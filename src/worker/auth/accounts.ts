import { and, eq, gt, sql } from "drizzle-orm";
import { first, must } from "@/shared/assert";
import { AppError } from "@/shared/errors";
import { asWorkspaceId, type WorkspaceId } from "@/shared/ids";
import type { Db } from "../db";
import { memberships, sessions, users, workspaces } from "../db/schema";
import { grantCredits } from "../billing/credits";
import { newId, nowIso, randomToken, sha256Hex } from "../lib";
import { hashPassword, verifyPassword } from "./password";

export type Role = "owner" | "admin" | "member";

export type AuthContext = {
  userId: string;
  email: string;
  workspaceId: WorkspaceId;
  role: Role;
  via: "session" | "access" | "noauth" | "apikey";
  /** Set when `via` is "apikey"; the per-key rate limit counts on it. */
  apiKeyId?: string;
};

const SESSION_DAYS = 30;
export const SESSION_COOKIE = "olseo_session";
const DEFAULT_WORKSPACE_ID = "default";

export const ROLE_RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
}

export async function createWorkspace(db: Db, ownerId: string, name: string, freeCredits = 0) {
  const id = newId();
  const slug = `${slugify(name)}-${id.slice(0, 6)}`;
  await db.insert(workspaces).values({ id, name, slug });
  await db.insert(memberships).values({ workspaceId: id, userId: ownerId, role: "owner" });
  if (freeCredits > 0) await grantCredits(db, id, freeCredits, "grant");
  return { id, name, slug };
}

export async function listWorkspaces(db: Db, userId: string) {
  return db
    .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, userId))
    .orderBy(memberships.createdAt);
}

/** The requested workspace if the user belongs to it, else their first one. */
export async function resolveWorkspace(db: Db, userId: string, requested?: string | null) {
  const all = await listWorkspaces(db, userId);
  if (requested) {
    const match = all.find((w) => w.id === requested);
    if (!match) throw new AppError("FORBIDDEN", "You are not a member of that workspace");
    return match;
  }
  const first = all[0];
  if (!first) throw new AppError("FORBIDDEN", "This account has no workspace");
  return first;
}

async function getOrCreateUser(db: Db, email: string, name?: string | null) {
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) return existing;
  const id = newId();
  await db.insert(users).values({ id, email, name: name ?? null }).onConflictDoNothing();
  const [created] = await db.select().from(users).where(eq(users.email, email));
  return must(created, "user exists after insert");
}

/**
 * local_noauth and cloudflare_access share one workspace ("default"): an
 * agency's team signs in through Access and sees the same clients. The first
 * person becomes owner, later ones join as members.
 */
export async function ensureSharedWorkspaceMember(db: Db, email: string, firstRole: Role = "owner"): Promise<AuthContext> {
  const user = await getOrCreateUser(db, email);
  await db.insert(workspaces).values({ id: DEFAULT_WORKSPACE_ID, name: "My workspace", slug: "default" }).onConflictDoNothing();
  const { n } = first(await db
    .select({ n: sql<number>`count(*)` })
    .from(memberships)
    .where(eq(memberships.workspaceId, DEFAULT_WORKSPACE_ID)), "membership count");
  await db
    .insert(memberships)
    .values({ workspaceId: DEFAULT_WORKSPACE_ID, userId: user.id, role: Number(n) === 0 ? firstRole : "member" })
    .onConflictDoNothing();
  const member = first(await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, DEFAULT_WORKSPACE_ID), eq(memberships.userId, user.id))), "membership just inserted");
  return { userId: user.id, email, workspaceId: asWorkspaceId(DEFAULT_WORKSPACE_ID), role: member.role, via: "noauth" };
}

// ---- hosted: email + password ------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function signUp(
  db: Db,
  input: { email: string; password: string; name?: string },
  freeCredits: number,
) {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new AppError("VALIDATION_ERROR", "Enter a valid email address");
  if (input.password.length < 10) throw new AppError("VALIDATION_ERROR", "Password must be at least 10 characters");
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) throw new AppError("VALIDATION_ERROR", "An account with this email already exists");
  const id = newId();
  await db.insert(users).values({ id, email, name: input.name ?? null, passwordHash: await hashPassword(input.password) });
  const workspace = await createWorkspace(db, id, input.name ? `${input.name}'s workspace` : "My workspace", freeCredits);
  return { userId: id, email, workspace };
}

export async function logIn(db: Db, emailInput: string, password: string) {
  const email = emailInput.trim().toLowerCase();
  const [user] = await db.select().from(users).where(eq(users.email, email));
  // Verify against a dummy hash when the user is unknown so timing does not reveal accounts.
  const ok = await verifyPassword(password, user?.passwordHash ?? "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  if (!user || !user.passwordHash || !ok) throw new AppError("UNAUTHENTICATED", "Wrong email or password");
  return user;
}

export async function createSession(db: Db, userId: string, now = new Date()) {
  const token = randomToken(32);
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  await db.insert(sessions).values({ id: await sha256Hex(token), userId, expiresAt: expires.toISOString() });
  return { token, expires };
}

export async function getSessionUser(db: Db, token: string, now = new Date()) {
  const [row] = await db
    .select({ id: users.id, email: users.email })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, await sha256Hex(token)), gt(sessions.expiresAt, nowIso(now))));
  return row ?? null;
}

export async function deleteSession(db: Db, token: string) {
  await db.delete(sessions).where(eq(sessions.id, await sha256Hex(token)));
}

