import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@/worker/db/schema";
import type { Db } from "@/worker/db";

/** Fresh in-memory SQLite with the real migrations applied. */
export async function createTestDb(): Promise<Db> {
  const client = createClient({ url: ":memory:" });
  const dir = join(process.cwd(), "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const statements = readFileSync(join(dir, file), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) await client.execute(statement);
  }
  await client.execute("PRAGMA foreign_keys = ON");
  return drizzle(client, { schema });
}
