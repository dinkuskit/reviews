import test from "node:test";
import assert from "node:assert/strict";
// The rating rules have no build step of their own: Node runs the TypeScript source directly.
import { aggregate, stars } from "../src/rating.ts";

test("only whole stars from 1 to 5 count", () => {
  for (const good of [1, 2, 3, 4, 5]) assert.equal(stars(good), good);
  for (const bad of [0, 6, 4.5, -1, NaN, Infinity, "5", null, undefined, true]) assert.equal(stars(bad), null);
});

test("a product with no reviews has no rating, not a rating of zero", () => {
  assert.equal(aggregate([]), null);
});

test("the rating is the average to one decimal place and the number of reviews, in UCP's shape", () => {
  assert.deepEqual(aggregate([5]), { value: 5, scale_min: 1, scale_max: 5, count: 1 });
  assert.deepEqual(aggregate([5, 4, 4]), { value: 4.3, scale_min: 1, scale_max: 5, count: 3 });
  assert.deepEqual(aggregate([1, 2]), { value: 1.5, scale_min: 1, scale_max: 5, count: 2 });
  // 4.25 rounds half up to 4.3, never down to 4.2.
  assert.deepEqual(aggregate([5, 4, 4, 4]), { value: 4.3, scale_min: 1, scale_max: 5, count: 4 });
});

test("a star value that could not have been accepted is refused, not averaged in", () => {
  assert.throws(() => aggregate([5, 0]), TypeError);
  assert.throws(() => aggregate([4.5]), TypeError);
});
