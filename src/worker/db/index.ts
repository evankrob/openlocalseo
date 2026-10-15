import { drizzle } from "drizzle-orm/d1";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

// Async SQLite: D1 in the Worker, libsql in unit tests. Code written against
// this type runs on both, so services are tested against real SQL.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = BaseSQLiteDatabase<"async", any, typeof schema>;

export function createDb(d1: D1Database): Db {
  return drizzle(d1, { schema });
}

export { schema };
