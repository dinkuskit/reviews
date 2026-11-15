/**
 * A product's rating as every big platform exposes it: an average and a count.
 * The shape is UCP's `rating` (value, scale_min, scale_max, count), so the store's
 * catalog feed and the cross-store catalog can pass it on unchanged.
 */
export const SCALE_MIN = 1;
export const SCALE_MAX = 5;

export interface Rating { value: number; scale_min: number; scale_max: number; count: number }

/** A whole number of stars from 1 to 5, or null for anything else. Half stars are not accepted. */
export function stars(input: unknown): number | null {
  return typeof input === "number" && Number.isInteger(input) && input >= SCALE_MIN && input <= SCALE_MAX ? input : null;
}

/**
 * The rating for one product from the stars of its published reviews, or null when it has none:
 * a product with no reviews has no rating, never a rating of zero.
 */
export function aggregate(published: readonly number[]): Rating | null {
  let sum = 0;
  for (const value of published) {
    if (stars(value) === null) throw new TypeError("a published review must hold 1 to 5 whole stars");
    sum += value;
  }
  if (published.length === 0) return null;
  // One decimal place, as storefronts show it ("4.3"), rounded half up on the exact sum.
  return { value: Math.round((sum * 10) / published.length) / 10, scale_min: SCALE_MIN, scale_max: SCALE_MAX, count: published.length };
}
