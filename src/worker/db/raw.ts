// The only place raw `db.run/all` runs. Anything that reads rows out of a raw
// statement goes through a zod row schema, so a column rename or a driver
// returning a different shape fails here with a clear error instead of
// surfacing as `undefined` three layers away. Writes whose result is ignored
// (bulk json_each statements) go through `execRaw`. Enforced by
// tests/raw-sql.test.ts.
import type { SQL } from "drizzle-orm";
import { z, type ZodType } from "zod";
import type { Db } from "./index";

/** Runs a raw statement whose result is not read. */
export async function execRaw(db: Db, query: SQL): Promise<void> {
  await db.run(query);
}

/** Runs a raw read and validates every row against `row`. */
export async function queryRows<S extends ZodType>(db: Db, query: SQL, row: S): Promise<z.infer<S>[]> {
  const rows = await db.all<unknown>(query);
  return z.array(row).parse(rows);
}
