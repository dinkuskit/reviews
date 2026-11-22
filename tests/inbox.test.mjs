import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../dist/plugin.mjs";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { courier, staff, store } from "./store.mjs";

const door = plugin.routes["courier/inbox"];
const call = (ctx, input) => door.handler(courier(input), ctx);
const refused = async (promise, code, status) => {
  await assert.rejects(promise, error => error.name === "PluginRouteError" && error.code === code && error.status === status, code);
};
let n = 0;
const shipped = (over = {}, data = {}) => {
  n++;
  return { id: `order-${n}:shipment-1`, at: "2026-11-22T15:01:09Z", data: {
    orderId: `order-${n}`, shippedAt: "2026-11-22T15:01:09Z", email: `buyer${n}@example.test`, name: "Sam Taylor",
    lines: [{ productId: "mug", productName: "Camp Mug" }, { productId: "tent", productName: "Trail Tent" }], ...data }, ...over };
};
const deliver = (ctx, items, after, next) => call(ctx, { op: "deliver", from: "dinkus-commerce", topic: "order.shipped", items, after, next });

test("the inbox is private, for the courier alone", async () => {
  assert.equal(door.public, false);
  assert.equal(door.permission, "plugins:manage");
  assert.deepEqual(door.methods, ["POST"]);
  const ctx = store();
  // Even the store's Administrator is refused: over HTTP a private route always carries a person.
  for (const role of [50, 40]) {
    for (const input of [{ op: "wants" }, { op: "deliver", from: "dinkus-commerce", topic: "order.shipped", items: [shipped()], after: null, next: "1" }]) {
      await refused(door.handler({ ...staff({ courier: 1, ...input }, role) }, ctx), "COURIER_ONLY", 403);
    }
  }
  assert.equal(await ctx.storage.shipped.count(), 0);
  assert.equal(await ctx.kv.get("courier:last-visit"), null);
  for (const input of [undefined, null, [], {}, { courier: 2, op: "wants" }, { courier: 1 }, { courier: 1, op: "since" }]) {
    await refused(door.handler({ input, request: { url: "", method: "POST", headers: {} } }, ctx), "BAD_COURIER_REQUEST", 400);
  }
});

test("wants names shipped orders from Commerce, from the bookmark, 50 at a time", async () => {
  const ctx = store();
  assert.deepEqual(await call(ctx, { op: "wants" }), { courier: 1, wants: [{ from: "dinkus-commerce", topic: "order.shipped", after: null, limit: 50 }] });
  assert.deepEqual(await deliver(ctx, [shipped()], null, "41"), { courier: 1, saved: 1, moved: true });
  assert.deepEqual((await call(ctx, { op: "wants" })).wants[0].after, "41");
});

test("a shipped order is kept once, with only what the request needs", async () => {
  const ctx = store();
  const item = shipped({}, { total: 4200, address: { line1: "1 Private Road" }, lines: [{ productId: "mug", productName: "Camp Mug", quantity: 2 }, { productId: "mug", productName: "Camp Mug" }, { productId: "tent" }] });
  assert.deepEqual(await deliver(ctx, [item], null, "1"), { courier: 1, saved: 1, moved: true });
  const kept = await ctx.storage.shipped.get(item.id);
  assert.deepEqual(Object.keys(kept).sort(), ["email", "lines", "name", "orderId", "receivedAt", "shippedAt", "state"]);
  assert.deepEqual(kept.lines, [{ productId: "mug", productName: "Camp Mug" }, { productId: "tent", productName: "" }]);
  assert.equal(kept.state, "waiting");
  assert.equal(kept.shippedAt, "2026-11-22T15:01:09.000Z");
  assert.doesNotMatch(JSON.stringify(kept), /Private Road|4200|quantity/);

  // The same item again, even with other words in it, changes nothing; a second label is a new item.
  const again = { ...item, data: { ...item.data, name: "Someone Else" } };
  const second = { ...item, id: item.id.replace("shipment-1", "shipment-2") };
  assert.deepEqual(await deliver(ctx, [again, second], "1", "2"), { courier: 1, saved: 1, moved: true });
  assert.equal((await ctx.storage.shipped.get(item.id)).name, "Sam Taylor");
  assert.equal(await ctx.storage.shipped.count(), 2);
});

test("an item that is not a shipped order is never kept", async () => {
  const ctx = store();
  const bad = [
    null, "order", { id: "x" }, shipped({ id: "" }), shipped({ id: "i".repeat(201) }),
    shipped({}, { orderId: "" }), shipped({}, { email: "not-an-email" }), shipped({}, { email: undefined }), shipped({}, { name: "" }),
    shipped({}, { lines: [] }), shipped({}, { lines: "mug" }), shipped({}, { lines: [{ productName: "No id" }] }),
    shipped({ at: "never" }, { shippedAt: "never" }), shipped({}, { name: "Sam\u0000" }),
    shipped({}, { lines: Array.from({ length: 101 }, (_, index) => ({ productId: `p${index}` })) }),
  ];
  const good = shipped();
  assert.deepEqual(await deliver(ctx, [...bad, good], null, "9"), { courier: 1, saved: 1, moved: true });
  assert.deepEqual([...ctx.storage.shipped.rows.keys()], [good.id]);
});

test("the bookmark only moves forward from where the batch was asked", async () => {
  const ctx = store();
  await deliver(ctx, [shipped()], null, "5");
  // A slower, older run that asked from the start: its orders are still saved once, its bookmark is ignored.
  assert.deepEqual(await deliver(ctx, [shipped()], null, "3"), { courier: 1, saved: 1, moved: false });
  assert.deepEqual(await deliver(ctx, [shipped()], "4", "9"), { courier: 1, saved: 1, moved: false });
  assert.equal(await ctx.kv.get("courier:after:dinkus-commerce:order.shipped"), "5");
  assert.deepEqual(await deliver(ctx, [], "5", "5"), { courier: 1, saved: 0, moved: false });
  assert.deepEqual(await deliver(ctx, [], "5", "6"), { courier: 1, saved: 0, moved: true });
  // Another run moved it between this run's read and its write.
  const racing = ctx.kv.compareAndSet;
  ctx.kv.compareAndSet = async () => ({ applied: false });
  assert.deepEqual(await deliver(ctx, [shipped()], "6", "7"), { courier: 1, saved: 1, moved: false });
  ctx.kv.compareAndSet = racing;
  assert.equal(await ctx.kv.get("courier:after:dinkus-commerce:order.shipped"), "6");
});

test("news Reviews did not ask for is refused whole", async () => {
  const ctx = store();
  await refused(call(ctx, { op: "deliver", from: "some-other-plugin", topic: "order.shipped", items: [shipped()], after: null, next: "1" }), "UNWANTED_TOPIC", 400);
  await refused(call(ctx, { op: "deliver", from: "dinkus-commerce", topic: "order.paid", items: [shipped()], after: null, next: "1" }), "UNWANTED_TOPIC", 400);
  await refused(deliver(ctx, "nope", null, "1"), "BAD_COURIER_REQUEST", 400);
  await refused(deliver(ctx, Array.from({ length: 101 }, () => shipped()), null, "1"), "BAD_COURIER_REQUEST", 400);
  assert.equal(await ctx.storage.shipped.count(), 0);
  assert.equal(await ctx.kv.get("courier:after:dinkus-commerce:order.shipped"), null);
});

test("the Reviews page says plainly whether the courier is coming by", async () => {
  const admin = plugin.routes.admin.handler;
  const page = async ctx => {
    const response = await admin(staff({ type: "page_load" }), ctx);
    assert.equal(validateBlockResponse(response).valid, true);
    return JSON.stringify(response);
  };
  const ctx = store();
  assert.match(await page(ctx), /Your store's courier has not come by/);
  await call(ctx, { op: "wants" });
  await deliver(ctx, [shipped(), shipped()], null, "2");
  const visiting = await page(ctx);
  assert.match(visiting, /Your store's courier last came by .* UTC\. 2 shipped orders are waiting for a review request\. This version does not send the request yet\./);
  assert.doesNotMatch(visiting, /has not come by|is late|@example\.test|Sam Taylor/);
  await ctx.kv.set("courier:last-visit", new Date(Date.now() - 6 * 60_000).toISOString());
  assert.match(await page(ctx), /Your store's courier is late/);
});
