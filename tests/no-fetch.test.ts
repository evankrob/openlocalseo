// AGENTS.md: external HTTP lives in two places only. DataForSEO calls (billed,
// metered) go through src/worker/dataforseo/, outbound webhooks through
// src/worker/notify/. Anything else calling `fetch` is a new egress path nobody
// reviewed. oxlint has no restricted-globals rule for this, so scan the sources.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Directories (or files) allowed to call fetch, with the reason. */
const FETCH_ALLOWED: Record<string, string> = {
  "src/worker/dataforseo/": "the only DataForSEO client (invariant 1)",
  "src/worker/notify/": "the only webhook sender (invariant 8)",
  "src/client/lib/api.ts": "the browser's own /api calls",
  "src/client/pages/Businesses.tsx": "browser-side address geocoder (Nominatim)",
  // AGENTS.md does not list this one: the worker geocodes new businesses by
  // address through Nominatim (one attempt, no key). Kept to document reality.
  "src/worker/geocode.ts": "server-side address geocoder (Nominatim); not listed in AGENTS.md",
};

const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const CALLS_FETCH = /(?<![\w.$])fetch\s*\(|\b(?:globalThis|self|window)\.fetch\b|\btypeof fetch\b/;

describe("fetch egress", () => {
  const files = sourceFiles(join(root, "src")).map((p) => relative(root, p));
  const allowed = (file: string) => Object.keys(FETCH_ALLOWED).some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));

  it("is called only from the allow-listed modules", () => {
    const offenders = files.filter((f) => !allowed(f) && CALLS_FETCH.test(withoutComments(readFileSync(join(root, f), "utf8"))));
    expect(offenders, "route outbound HTTP through dataforseo/ or notify/ (see AGENTS.md)").toEqual([]);
  });

  it("allow-list has no stale entries", () => {
    const stale = Object.keys(FETCH_ALLOWED).filter(
      (entry) => !files.some((f) => (entry.endsWith("/") ? f.startsWith(entry) : f === entry)),
    );
    expect(stale).toEqual([]);
  });

  it("the detector catches the patterns it is meant to", () => {
    for (const snippet of ["await fetch(url)", "const f = globalThis.fetch", "x: typeof fetch", "return fetch (url)"]) {
      expect(CALLS_FETCH.test(snippet), snippet).toBe(true);
    }
    for (const snippet of ["app.fetch(req)", "fetchImpl(url)", "prefetch(url)"]) {
      expect(CALLS_FETCH.test(snippet), snippet).toBe(false);
    }
  });
});
