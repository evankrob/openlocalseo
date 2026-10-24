// Tiny helpers for `noUncheckedIndexedAccess`: turn "this must exist" into an
// explicit, named failure instead of a blanket `!` or a silent `undefined`.

/** Returns `value`, or throws when it is null/undefined (a broken invariant). */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Invariant violated: ${what}`);
  return value;
}

/** `items[index]`, or a named failure when it is out of range (for places that know the length). */
export function at<T>(items: readonly T[], index: number): T {
  return must(items[index], `index ${index} of ${items.length} items`);
}

/** First element of an array that is known to be non-empty. */
export function first<T>(items: readonly T[], what: string): T {
  return must(items[0], `${what} (expected at least one row)`);
}
