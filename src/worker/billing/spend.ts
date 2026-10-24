// The one place a `SpendAuthorization` is minted, so a billed provider call
// (task_post, live search, profile / reviews posts) cannot be written without
// a hold or BYOK decision on the way: `DataForSeoProvider.billed()` requires
// the token and nothing else can construct it.
//
//  - `withCreditHold` runs when work is admitted (scan / snapshot creation):
//    hosted mode holds credits first, BYOK spends the user's own key.
//  - `billedProviderFor` runs in the queue consumer, where the token cannot be
//    carried over the queue: it re-derives it from the hold persisted on the row.
import { AppError } from "@/shared/errors";
import type { WorkspaceId } from "@/shared/ids";
import type { AppConfig } from "../config";
import type { Db } from "../db";
import type { BilledProvider, DataForSeoProvider, ProviderScope, SpendAuthorization } from "../dataforseo/types";
import { holdCredits, type ChargeScope } from "./credits";

/** The only mint. Keep it private to this module. */
const authorize = () => ({}) as SpendAuthorization;

export type SpendEstimate = {
  billingMode: AppConfig["billingMode"];
  /** Hosted only: credits to hold (the quote's upper bound); 0 in BYOK mode. */
  credits: number;
  scope: ChargeScope;
  /** The scan or snapshot id the hold is booked against. */
  refId: string;
};

/**
 * Takes the credit hold (hosted) or accepts the user's own key (BYOK), then
 * runs `fn` with proof of it. A hold that cannot be placed throws
 * INSUFFICIENT_CREDITS before `fn` runs. If `fn` throws, the hold is kept: the
 * row it was booked against settles or refunds it (failure path / reaper).
 */
export async function withCreditHold<T>(
  db: Db,
  workspaceId: WorkspaceId,
  estimate: SpendEstimate,
  fn: (authorization: SpendAuthorization) => Promise<T>,
): Promise<T> {
  if (estimate.billingMode === "hosted") await holdCredits(db, workspaceId, estimate.credits, estimate.refId, estimate.scope);
  return fn(authorize());
}

export const providerScope = (b: ProviderScope): ProviderScope => ({
  name: b.name,
  placeId: b.placeId,
  domain: b.domain,
  category: b.category,
  lat: b.lat,
  lng: b.lng,
});

/** A scan or snapshot row: `reservedCredits` records the hold taken when it was admitted. */
type HeldRow = { reservedCredits: number };

type ProviderDeps = {
  provider: DataForSeoProvider;
  /** Builds a provider for one business (its simulated market in local dev); unset = `provider` for all. */
  scopeProvider?: (scope: ProviderScope) => DataForSeoProvider;
  config: Pick<AppConfig, "billingMode">;
};

/**
 * Billed calls for work that was already admitted. Hosted rows must carry a
 * hold; BYOK rows spend the user's own key. Refuses rather than spend without one.
 */
export function billedProviderFor(deps: ProviderDeps, row: HeldRow, scope?: ProviderScope): BilledProvider {
  if (deps.config.billingMode === "hosted" && row.reservedCredits <= 0) {
    throw new AppError("INSUFFICIENT_CREDITS", "No credits were held for this job, so nothing was spent.");
  }
  const provider = scope && deps.scopeProvider ? deps.scopeProvider(scope) : deps.provider;
  return provider.billed(authorize());
}
