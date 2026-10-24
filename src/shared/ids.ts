// Zero-cost branded ids: at runtime they are plain strings, but the compiler
// refuses to pass a tracker id where a workspace id is expected (the classic
// argument-order slip that breaks tenant isolation). Mint them at the edges
// (route params, auth context, seed data) with the `as*` helpers.

declare const brand: unique symbol;
type Brand<B extends string> = string & { readonly [brand]: B };

export type WorkspaceId = Brand<"WorkspaceId">;
export type TrackerId = Brand<"TrackerId">;
export type ScanId = Brand<"ScanId">;
export type BusinessId = Brand<"BusinessId">;

export const asWorkspaceId = (id: string) => id as WorkspaceId;
export const asTrackerId = (id: string) => id as TrackerId;
export const asScanId = (id: string) => id as ScanId;
export const asBusinessId = (id: string) => id as BusinessId;
