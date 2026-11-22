import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../dist/plugin.mjs";
import { review, shopper, staff, store } from "./store.mjs";

const { admin } = plugin.routes;
/** A public route as a caller sees it: the status and the JSON it carries. */
const open = name => ({ ...plugin.routes[name], handler: async (route, ctx) => {
  const response = await plugin.routes[name].handler(route, ctx);
  const body = JSON.parse(response.body.value);
  return response.status === 200 ? body : { status: response.status, ...body };
} });
const rating = open("rating"), list = open("list");

test("the plugin has the admin route and two read-only public routes", () => {
  assert.deepEqual(Object.keys(plugin.routes), ["admin", "rating", "list"]);
  for (const route of [rating, list]) {
    assert.equal(route.public, true);
    assert.deepEqual(route.methods, ["GET"]);
    assert.equal(route.response, "raw");
    assert.deepEqual(route.request, { body: "none" });
  }
  assert.equal(plugin.hooks, undefined);
});

test("a product's rating is its published reviews only, in UCP's shape", async () => {
  const ctx = store();
  assert.deepEqual(await rating.handler(shopper("/rating?product=mug"), ctx), { productId: "mug", rating: null });
  await ctx.storage.reviews.put("a", review({ stars: 5, status: "pending" }));
  await ctx.storage.reviews.put("b", review({ stars: 4, status: "pending" }));
  await ctx.storage.reviews.put("c", review({ stars: 1, status: "pending" }));
  await ctx.storage.reviews.put("other", review({ productId: "tent", stars: 1, status: "pending" }));
  for (const id of ["a", "b", "other"]) await admin.handler(staff({ type: "block_action", action_id: `publish:${id}` }), ctx);
  assert.deepEqual(await rating.handler(shopper("https://store.example/_emdash/api/plugins/dinkus-reviews/rating?product=mug"), ctx),
    { productId: "mug", rating: { value: 4.5, scale_min: 1, scale_max: 5, count: 2 } });
  assert.deepEqual((await rating.handler(shopper("/rating?product=tent"), ctx)).rating, { value: 1, scale_min: 1, scale_max: 5, count: 1 });
});

test("the public list holds published reviews only and never the order or the status", async () => {
  const ctx = store();
  await ctx.storage.reviews.put("seen", review({ stars: 4, body: "Good mug.", name: "Sam T.", orderId: "order-secret-1", reply: { body: "Thanks!", at: "2026-11-02T00:00:00.000Z" } }));
  await ctx.storage.reviews.put("stars-only", review({ stars: 5, body: "", orderId: "order-secret-2" }));
  for (const status of ["pending", "hidden", "spam"]) await ctx.storage.reviews.put(status, review({ status, body: `${status} words`, orderId: "order-secret-3" }));
  await ctx.storage.reviews.put("tent", review({ productId: "tent", body: "A tent." }));
  const answer = await list.handler(shopper("/list?product=mug"), ctx);
  assert.deepEqual(answer.reviews.map(item => item.id), ["stars-only", "seen"]);
  assert.deepEqual(Object.keys(answer.reviews[1]).sort(), ["body", "createdAt", "id", "name", "reply", "stars", "verifiedBuyer"]);
  assert.deepEqual(answer.reviews[1].reply, { body: "Thanks!", at: "2026-11-02T00:00:00.000Z" });
  assert.equal(answer.reviews[0].verifiedBuyer, true);
  assert.equal("reply" in answer.reviews[0], false);
  assert.doesNotMatch(JSON.stringify(answer), /order-secret|pending words|hidden words|spam words|A tent|status/);
});

test("the public list pages 20 at a time, newest first", async () => {
  const ctx = store();
  for (let n = 1; n <= 45; n++) await ctx.storage.reviews.put(`r${n}`, review());
  const seen = [];
  let cursor, pages = 0;
  do {
    const answer = await list.handler(shopper(`/list?product=mug${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`), ctx);
    assert.ok(answer.reviews.length <= 20);
    seen.push(...answer.reviews.map(item => item.id));
    cursor = answer.cursor;
    pages++;
  } while (cursor);
  assert.equal(pages, 3);
  assert.deepEqual(seen, Array.from({ length: 45 }, (_, index) => `r${45 - index}`));
});

test("a request without a usable product is answered 400", async () => {
  const ctx = store();
  for (const route of [rating, list]) {
    for (const url of ["/x", "/x?product=", `/x?product=${"p".repeat(201)}`, "/x?product=a%00b"]) {
      const response = await route.handler(shopper(url), ctx);
      assert.equal(response.status, 400, url);
      assert.equal(response.error.code, "INVALID_REQUEST");
    }
  }
  assert.equal((await list.handler(shopper(`/x?product=mug&cursor=${"c".repeat(2001)}`), ctx)).status, 400);
});
