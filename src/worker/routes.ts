// The REST API as one table. Each route declares its access level, and
// registration is derived from the table, so:
//  - specific routes are always registered before param routes that would
//    shadow them (the admin-credits bug class), and
//  - the guard a route sits behind is data a test can enumerate.
import type { Handler, MiddlewareHandler } from "hono";
import type { Env } from "./env";

export type RouteMethod = "get" | "post" | "put" | "patch" | "delete" | "all";

/**
 * - public: no credentials (health, public report links, signup/login/logout)
 * - session: any signed-in member of the workspace (or an API key)
 * - admin: signed in with role admin or owner
 * - admin_token: the ADMIN_TOKEN bearer, checked in the handler (hosted top-ups)
 * - api_key: an API key, checked in the handler (MCP)
 */
export type RouteAccess = "public" | "session" | "admin" | "admin_token" | "api_key";

export type RouteDef<E extends { Bindings: Env }> = {
  method: RouteMethod;
  /** Full path including the /api prefix. */
  path: string;
  access: RouteAccess;
  handler: Handler<E>;
  /** Route-level middleware that runs before the handler (e.g. a throttle). */
  middleware?: MiddlewareHandler<E>[];
};

const segments = (path: string) => path.split("/").filter(Boolean);
const isParam = (segment: string) => segment.startsWith(":");

/** True when `earlier` would match `later`'s literal path first, hiding it. */
export function shadows(earlier: { method: string; path: string }, later: { method: string; path: string }): boolean {
  if (earlier.method !== later.method && earlier.method !== "ALL") return false;
  const a = segments(earlier.path);
  const b = segments(later.path);
  if (a.at(-1) === "*") {
    // A wildcard hides everything below its prefix.
    const prefix = a.slice(0, -1);
    return prefix.length <= b.length && prefix.every((s, i) => isParam(s) || s === b[i]);
  }
  if (a.length !== b.length) return false;
  let moreSpecific = false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (x === y || (isParam(x) && isParam(y))) continue;
    if (isParam(x)) moreSpecific = true; // `earlier` has a param where `later` is literal
    else return false;
  }
  return moreSpecific;
}

/** Every (earlier, later) pair where a param route is registered before a static sibling. */
export function findShadowedRoutes<T extends { method: string; path: string }>(routes: readonly T[]): Array<[T, T]> {
  const found: Array<[T, T]> = [];
  routes.forEach((later, j) => {
    for (const earlier of routes.slice(0, j)) {
      if (shadows(earlier, later)) found.push([earlier, later]);
    }
  });
  return found;
}

/** Stable sort: fewer params (more literal segments) first, so literals always win over params. */
export function orderRoutes<T extends { path: string }>(routes: readonly T[]): T[] {
  const paramCount = (path: string) => segments(path).filter(isParam).length;
  return routes
    .map((route, index) => ({ route, index }))
    .sort((x, y) => paramCount(x.route.path) - paramCount(y.route.path) || x.index - y.index)
    .map((entry) => entry.route);
}
