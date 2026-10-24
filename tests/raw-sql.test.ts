// Raw SQL is untyped at the result edge, and agents copy what they see. Keep it
// in a short, reviewed list of files, and keep every raw read behind a row schema.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "fixtures" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const files = [...sourceFiles(join(root, "src")), ...sourceFiles(join(root, "scripts"))].map((p) => relative(root, p));
const read = (file: string) => readFileSync(join(root, file), "utf8");

/** Files that may contain a drizzle `sql` fragment. Add a file here only with a reason. */
const SQL_ALLOW_LIST: Record<string, string> = {
  "src/worker/db/schema.ts": "column defaults and partial-index predicates",
  "src/worker/scans/sql.ts": "json_each bulk writes (D1 100-parameter cap)",
  "src/worker/gbp/sql.ts": "json_each review upsert",
  "src/worker/scans/queries.ts": "latest-scan window function (typed via queryRows)",
  "src/worker/scans/process.ts": "atomic cost accumulation",
  "src/worker/gbp/process.ts": "atomic cost accumulation",
  "src/worker/billing/credits.ts": "conditional balance updates",
  "src/worker/billing/usage.ts": "typed count/sum aggregates",
  "src/worker/alerts.ts": "coalesce join, unread count",
  "src/worker/ratelimit/index.ts": "fixed-window upsert increment",
  "src/worker/retention.ts": "bounded batch deletes",
  "src/worker/reports.ts": "view counter increment",
  "src/worker/auth/accounts.ts": "membership count",
  "scripts/seed.ts": "SELECT * dump for the seed file (typed via queryRows)",
};

describe("raw SQL", () => {
  it("only appears in allow-listed files", () => {
    const offenders = files.filter((f) => /\bsql(\.raw)?\s*(`|<[^>]*>`|\()/.test(read(f)) && !(f in SQL_ALLOW_LIST));
    expect(offenders, "new raw sql: use the query builder, or add the file to SQL_ALLOW_LIST with a reason").toEqual([]);
  });

  it("allow-list has no stale entries", () => {
    const stale = Object.keys(SQL_ALLOW_LIST).filter((f) => !files.includes(f) || !/\bsql(\.raw)?\s*(`|<[^>]*>`|\()/.test(read(f)));
    expect(stale).toEqual([]);
  });

  it("raw statements are executed only through db/raw.ts (typed row mapper)", () => {
    const direct = /\b(?:db|tx)\.(run|all|get|values|execute)\s*[<(]/;
    const offenders = files.filter((f) => f !== "src/worker/db/raw.ts" && direct.test(read(f)));
    expect(offenders, "use execRaw / queryRows from db/raw.ts").toEqual([]);
  });
});
