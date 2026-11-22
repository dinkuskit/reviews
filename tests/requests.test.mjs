import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../dist/plugin.mjs";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { staff, store } from "./store.mjs";

const DAY = 86_400_000;
const run = ctx => plugin.hooks.cron.handler({ name: "review-requests", scheduledAt: new Date().toISOString() }, ctx);
const admin = (ctx, input) => plugin.routes.admin.handler(staff(input), ctx);
const page = async ctx => {
  const response = await admin(ctx, { type: "page_load" });
  assert.equal(validateBlockResponse(response).valid, true);
  return JSON.stringify(response);
};
const save = (ctx, values) => admin(ctx, { type: "form_submit", action_id: "save_settings", values });
/** A shipped order as the inbox keeps it, shipped `days` days ago. */
const order = (days, over = {}) => ({
  orderId: "order-1", shippedAt: new Date(Date.now() - days * DAY).toISOString(), email: "sam@example.test", name: "Sam Taylor",
  lines: [{ productId: "mug", productName: "Camp <Mug>" }, { productId: "tent", productName: "Trail Tent" }],
  state: "waiting", receivedAt: new Date(Date.now() - days * DAY).toISOString(), ...over,
});
const put = (ctx, id, data) => ctx.storage.shipped.put(id, data);
const row = (ctx, id) => ctx.storage.shipped.get(id);
const links = message => [...message.text.matchAll(/https:\/\/\S+/g)].map(found => found[0]);
/** The store's /review page asking the plugin what a link opens: the status and the JSON answer. */
const get = async (ctx, url) => {
  const response = await plugin.routes.write.handler({ input: undefined, request: { url: url.replace("/review?", "/_emdash/api/plugins/dinkus-reviews/write?"), method: "GET", headers: {} } }, ctx);
  assert.equal(Object.fromEntries(response.headers)["cache-control"], "no-store");
  return { status: response.status, ...JSON.parse(response.body.value) };
};
/** The page's form posting: always a 303 back to the store's /review page; answers the outcome in `r`. */
const post = async (ctx, fields) => {
  const response = await plugin.routes.send.handler({ input: new URLSearchParams(fields).toString(), request: { url: "", method: "POST", headers: {} } }, ctx);
  assert.equal(response.status, 303);
  assert.equal(response.body, null);
  const location = Object.fromEntries(response.headers).location;
  assert.match(location, /^\/review\?/);
  return new URLSearchParams(location.slice("/review?".length));
};
const fieldsOf = (url, more) => {
  const query = new URL(url).searchParams;
  return { o: query.get("o"), p: query.get("p"), k: query.get("k"), ...more };
};

test("the hourly run is scheduled when the plugin is switched on, and again from the Reviews page if it is missing", async () => {
  const ctx = store();
  await plugin.hooks["plugin:activate"]({}, ctx);
  assert.equal(ctx.tasks.get("review-requests"), "0 * * * *");
  ctx.tasks.clear();
  await page(ctx);
  assert.equal(ctx.tasks.get("review-requests"), "0 * * * *");
  // A scheduler that is down never stops the page from opening.
  ctx.cron.list = async () => { throw new Error("down"); };
  assert.match(await page(ctx), /Reviews/);
});

test("a buyer is asked once, 14 days after the order ships, with a link for each product", async () => {
  const ctx = store();
  await put(ctx, "order-1:shipment-1", order(15));
  await put(ctx, "order-2:shipment-1", order(13, { orderId: "order-2", email: "kim@example.test" }));
  await run(ctx);
  assert.equal(ctx.sent.length, 1);
  const [message] = ctx.sent;
  assert.equal(message.to, "sam@example.test");
  assert.equal(message.subject, "How was your order from Camp Store?");
  assert.match(message.text, /^Hi Sam,/);
  assert.equal(links(message).length, 2);
  assert.match(links(message)[0], /^https:\/\/store\.example\.test\/review\?o=order-1%3Ashipment-1&p=mug&k=[0-9a-f]{64}$/);
  // The product's name is the store's text; it is never markup in the email.
  assert.match(message.html, /Camp &#60;Mug&#62;/);
  assert.doesNotMatch(message.html, /<Mug>/);
  const kept = await row(ctx, "order-1:shipment-1");
  assert.equal(kept.state, "asked");
  assert.match(kept.key, /^[0-9a-f]{64}$/);
  // The secret in the link is not what is kept.
  assert.equal(JSON.stringify(kept).includes(new URL(links(message)[0]).searchParams.get("k")), false);
  assert.equal((await row(ctx, "order-2:shipment-1")).state, "waiting");
  await run(ctx);
  await run(ctx);
  assert.equal(ctx.sent.length, 1);
});

test("the owner sets the wait and can turn requests off", async () => {
  const ctx = store();
  await put(ctx, "a", order(4));
  await run(ctx);
  assert.equal(ctx.sent.length, 0);
  for (const days of [0, 91, 2.5, "7", undefined]) {
    assert.match((await save(ctx, { requestsOn: true, requestDays: days })).toast.message, /^Not saved\. The wait before asking is a whole number of days from 1 to 90\./);
  }
  await save(ctx, { requestsOn: false, requestDays: 3 });
  assert.match(await page(ctx), /Review requests are off\. No buyer is emailed\./);
  await run(ctx);
  assert.equal(ctx.sent.length, 0);
  await save(ctx, { requestsOn: true, requestDays: 3 });
  assert.match(await page(ctx), /Each buyer gets one email 3 days after their order ships/);
  await run(ctx);
  assert.equal(ctx.sent.length, 1);
  assert.match(await page(ctx), /1 buyer has been asked so far\./);
});

test("a store with no email sender sends nothing, loses nothing, and the page says so", async () => {
  const ctx = store();
  const sender = ctx.email;
  ctx.email = undefined;
  await put(ctx, "a", order(20));
  await run(ctx);
  assert.equal((await row(ctx, "a")).state, "waiting");
  const text = await page(ctx);
  assert.match(text, /Review requests are waiting for an email sender/);
  assert.doesNotMatch(text, /sam@example\.test|Sam Taylor/);
  ctx.email = sender;
  await run(ctx);
  assert.equal(ctx.sent.length, 1);
  assert.doesNotMatch(await page(ctx), /waiting for an email sender/);
});

test("a site that does not know its own address sends nothing, because the links would not open", async () => {
  const ctx = store();
  const url = ctx.url;
  ctx.url = path => path;
  await put(ctx, "a", order(20));
  await run(ctx);
  assert.equal(ctx.sent.length, 0);
  assert.equal((await row(ctx, "a")).state, "waiting");
  assert.match(await page(ctx), /Review requests are waiting for your site's address/);
  ctx.url = url;
  await run(ctx);
  assert.equal(ctx.sent.length, 1);
  assert.doesNotMatch(await page(ctx), /waiting for your site's address/);
});

test("a request that cannot be handed over waits and is tried 3 times, then given up on", async () => {
  const ctx = store();
  let calls = 0;
  ctx.email = { async send() { calls++; throw new Error("sender down for sam@example.test"); } };
  await put(ctx, "a", order(20));
  await run(ctx);
  assert.deepEqual([(await row(ctx, "a")).state, (await row(ctx, "a")).tries, (await row(ctx, "a")).key], ["waiting", 1, undefined]);
  await run(ctx);
  await run(ctx);
  assert.equal((await row(ctx, "a")).state, "failed");
  await run(ctx);
  assert.equal(calls, 3);
  assert.match(await page(ctx), /1 request could not be handed to your email sender after 3 tries and will not be sent\./);
});

test("an order whose turn passed more than 30 days ago is not asked", async () => {
  const ctx = store();
  await put(ctx, "old", order(14 + 31));
  await put(ctx, "due", order(14 + 29, { orderId: "order-2" }));
  await run(ctx);
  assert.equal((await row(ctx, "old")).state, "missed");
  assert.equal((await row(ctx, "due")).state, "asked");
  assert.equal(ctx.sent.length, 1);
});

test("two runs at once email a buyer once", async () => {
  const ctx = store();
  await put(ctx, "a", order(20));
  await Promise.all([run(ctx), run(ctx), run(ctx)]);
  assert.equal(ctx.sent.length, 1);
});

test("the link's secret opens the review form's facts, and never the order or the email", async () => {
  const ctx = store();
  await put(ctx, "order-1:shipment-1", order(15));
  await run(ctx);
  const answer = await get(ctx, links(ctx.sent[0])[0]);
  assert.deepEqual(answer, { status: 200, state: "open", productId: "mug", productName: "Camp <Mug>", name: "Sam T.", anonymousName: "Verified buyer", bodyMax: 2000, nameMax: 60 });
});

test("a link that is wrong, for another product, or older than 60 days opens nothing", async () => {
  const ctx = store();
  await put(ctx, "a", order(15));
  await run(ctx);
  const good = links(ctx.sent[0])[0];
  const swap = (name, value) => { const url = new URL(good); url.searchParams.set(name, value); return url.href; };
  for (const url of [swap("k", "0".repeat(64)), swap("k", "short"), swap("p", "stove"), swap("o", "b"), swap("o", "constructor"), good.split("?")[0] + "?"]) {
    assert.deepEqual(await get(ctx, url), { status: 404, state: "closed" }, url);
  }
  const refused = await post(ctx, fieldsOf(swap("k", "0".repeat(64)), { stars: "5" }));
  // A link that opens nothing is sent back with nothing of what it carried.
  assert.equal(refused.toString(), "r=closed");
  assert.equal(ctx.storage.reviews.rows.size, 0);
  const kept = await row(ctx, "a");
  await put(ctx, "a", { ...kept, askedAt: new Date(Date.now() - 61 * DAY).toISOString() });
  assert.equal((await get(ctx, good)).status, 404);
  assert.equal((await post(ctx, fieldsOf(good, { stars: "5" }))).get("r"), "closed");
  // An order that was never asked has no link at all.
  await put(ctx, "w", order(1));
  assert.equal((await get(ctx, swap("o", "w"))).status, 404);
  assert.equal(ctx.storage.reviews.rows.size, 0);
});

test("a buyer's review is kept once, published at once, and counts in the rating", async () => {
  const ctx = store();
  await put(ctx, "a", order(15));
  await run(ctx);
  const [mug, tent] = links(ctx.sent[0]);
  const first = await post(ctx, fieldsOf(mug, { stars: "4", body: "  Keeps coffee hot.\r\nGood handle.  ", name: "" }));
  assert.equal(first.get("r"), "sent");
  // The buyer lands back on the same link.
  assert.deepEqual([first.get("o"), first.get("p"), first.get("k")], Object.values(fieldsOf(mug)));
  const [[id, saved]] = [...ctx.storage.reviews.rows];
  // Shoppers see a review's id, so it gives away nothing about the order.
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.deepEqual({ ...saved.data, createdAt: "" }, { productId: "mug", productName: "Camp <Mug>", stars: 4, body: "Keeps coffee hot.\nGood handle.",
    name: "Verified buyer", status: "published", createdAt: "", orderId: "order-1" });
  assert.deepEqual(await ctx.storage.ratings.get("mug"), { value: 4, count: 1, turn: 1 });
  // The same link again changes nothing, whatever it carries.
  assert.equal((await post(ctx, fieldsOf(mug, { stars: "1", body: "Changed my mind" }))).get("r"), "done");
  assert.deepEqual(await get(ctx, mug), { status: 200, state: "done" });
  assert.equal(ctx.storage.reviews.rows.size, 1);
  assert.equal((await ctx.storage.ratings.get("mug")).value, 4);
  // The other product in the order still has its own review.
  assert.equal((await post(ctx, fieldsOf(tent, { stars: "5", name: "  Sam   from Ohio " }))).get("r"), "sent");
  assert.equal([...ctx.storage.reviews.rows.values()].find(found => found.data.productId === "tent").data.name, "Sam from Ohio");
  assert.equal(ctx.storage.reviews.rows.size, 2);
});

test("the same form sent twice at once keeps one review", async () => {
  const ctx = store();
  await put(ctx, "a", order(15));
  await run(ctx);
  const fields = fieldsOf(links(ctx.sent[0])[0], { stars: "5" });
  const results = (await Promise.all([post(ctx, fields), post(ctx, fields), post(ctx, fields)])).map(found => found.get("r")).sort();
  assert.deepEqual(results, ["done", "done", "sent"]);
  assert.equal(ctx.storage.reviews.rows.size, 1);
  assert.equal((await ctx.storage.ratings.get("mug")).count, 1);
});

test("with approve-first on, a new review waits and does not count yet", async () => {
  const ctx = store();
  await save(ctx, { approveFirst: true, requestsOn: true, requestDays: 14 });
  await put(ctx, "a", order(15));
  await run(ctx);
  assert.equal((await post(ctx, fieldsOf(links(ctx.sent[0])[0], { stars: "1" }))).get("r"), "held");
  assert.equal([...ctx.storage.reviews.rows.values()][0].data.status, "pending");
  assert.equal(await ctx.storage.ratings.get("mug"), null);
});

test("a review that cannot be kept is sent back with the reason, and nothing is kept", async () => {
  const ctx = store();
  await put(ctx, "a", order(15));
  await run(ctx);
  const link = links(ctx.sent[0])[0];
  for (const [fields, reason] of [
    [{ body: "No stars" }, "stars"], [{ stars: "6" }, "stars"], [{ stars: "2.5" }, "stars"], [{ stars: "0" }, "stars"],
    [{ stars: "5", body: "x".repeat(2001) }, "long"], [{ stars: "5", name: "n".repeat(61) }, "name"], [{ stars: "5", body: "bell\u0007" }, "chars"],
  ]) {
    assert.equal((await post(ctx, fieldsOf(link, fields))).get("r"), reason);
  }
  assert.equal(ctx.storage.reviews.rows.size, 0);
  assert.equal((await get(ctx, link)).state, "open");
});
