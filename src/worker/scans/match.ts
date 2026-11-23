import type { MapResult } from "../dataforseo/types";

type Identity = { placeId: string | null; cid: string | null; domain: string | null; name: string };

const normalizeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "");
const normalizeDomain = (domain: string) =>
  domain.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

/**
 * Is this result the tracked business? Place id / cid are exact. Only when
 * neither is known do we fall back to domain, then name: a domain alone would
 * confuse the locations of a multi-location chain.
 */
export function isTargetBusiness(item: MapResult, business: Identity): boolean {
  if (business.placeId || business.cid) {
    return (
      (!!business.placeId && item.placeId === business.placeId) ||
      (!!business.cid && item.cid === business.cid)
    );
  }
  if (business.domain && item.domain) {
    if (normalizeDomain(item.domain) === normalizeDomain(business.domain)) return true;
  }
  return normalizeName(item.name) === normalizeName(business.name);
}

/**
 * Identity of a listed business across points and scans: place id, else cid.
 * A result with neither is keyed to its own row id so it never merges with
 * another point's result: names are not an identity (two shops can share one).
 */
export function businessKey(item: MapResult, rowId: string): string {
  return item.placeId ?? item.cid ?? `row:${rowId}`;
}
