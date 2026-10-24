// Workspace API keys, used by the MCP server and scripts. Only a SHA-256 of
// the key is stored; the plaintext is shown once at creation.
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db";
import { apiKeys, memberships, users } from "../db/schema";
import { newId, nowIso, randomToken, sha256Hex } from "../lib";
import type { AuthContext } from "./accounts";

export const API_KEY_PREFIX = "olseo_";

export async function createApiKey(db: Db, workspaceId: string, createdBy: string, name: string) {
  const key = `${API_KEY_PREFIX}${randomToken(30)}`;
  const id = newId();
  await db.insert(apiKeys).values({
    id,
    workspaceId,
    createdBy,
    name,
    prefix: key.slice(0, 10),
    keyHash: await sha256Hex(key),
  });
  return { id, key, prefix: key.slice(0, 10) };
}

export async function listApiKeys(db: Db, workspaceId: string) {
  return db
    .select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, lastUsedAt: apiKeys.lastUsedAt, createdAt: apiKeys.createdAt })
    .from(apiKeys)
    .where(and(eq(apiKeys.workspaceId, workspaceId), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt));
}

export async function revokeApiKey(db: Db, workspaceId: string, id: string) {
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: nowIso() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, workspaceId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

/** Resolves a bearer key to an auth context acting with the creator's role. */
export async function authenticateApiKey(db: Db, key: string): Promise<AuthContext | null> {
  if (!key.startsWith(API_KEY_PREFIX)) return null;
  const [row] = await db
    .select({ id: apiKeys.id, workspaceId: apiKeys.workspaceId, userId: apiKeys.createdBy })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, await sha256Hex(key)), isNull(apiKeys.revokedAt)));
  if (!row || !row.userId) return null;
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, row.userId));
  const [member] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, row.workspaceId), eq(memberships.userId, row.userId)));
  // The creator left the workspace: the key stops working with them.
  if (!user || !member) return null;
  await db.update(apiKeys).set({ lastUsedAt: nowIso() }).where(eq(apiKeys.id, row.id));
  return { userId: row.userId, email: user.email, workspaceId: row.workspaceId, role: member.role, via: "apikey", apiKeyId: row.id };
}
