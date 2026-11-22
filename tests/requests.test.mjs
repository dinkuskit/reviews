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
const save = (ctx, values) => admin(ctx, { type: "form_submit", action_id: "save_settings", values: { remindersOn: true, reminderDays: 7, ...values } });
/** Moves an asked order's request email `days` days into the past. */
const age = async (ctx, id, days) => put(ctx, id, { ...(await row(ctx, id)), askedAt: new Date(Date.now() - days * DAY).toISOString() });
/** A shipped order as the inbox keeps it, shipped `days` days ago. */
const order = (days, over = {}) => ({
  orderId: "order-1", shippedAt: new Date(Date.now() - days * DAY).toISOString(), email: "sam@example.test", name: "Sam Taylor",
  lines: [{ productId: "mug", productName: "Camp <Mug>" }, { productId: "tent", productName: "Trail Tent" }],
  state: "waiting", receivedAt: new Date(Date.now() - days * DAY).toISOString(), ...over,
});
const put = (ctx, id, data) => ctx.storage.shipped.put(id, data);
const row = (ctx, id) => ctx.storage.shipped.get(id);
const links = message => [...message.text.matchAll(/https:\/\/\S+/g)].map(found => found[0]);
/** The store's /review page asking the plugin, from inside the store's server, what a link opens. */
const get = (ctx, url) => plugin.routes.write.handler({ input: fieldsOf(url), request: { url: "", method: "POST", headers: {} } }, ctx);
/** The store's server handing the plugin the form the buyer sent. */
const post = (ctx, fields) => plugin.routes.send.handler({ input: fields, request: { url: "", method: "POST", headers: {} } }, ctx);
const CLOSED = { ok: false, error: { code: "CLOSED" } };
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
  assert.match(await page(ctx), /Each buyer gets an email 3 days after their order ships/);
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
  assert.deepEqual(await get(ctx, links(ctx.sent[0])[0]),
    { ok: true, state: "open", productId: "mug", productName: "Camp <Mug>", name: "Sam T.", anonymousName: "Verified buyer", bodyMax: 2000, nameMax: 60 });
});

test("a link that is wrong, for another product, or older than 60 days opens nothing", async () => {
  const ctx = store();
  await put(ctx, "a", order(15));
  await run(ctx);
  const good = links(ctx.sent[0])[0];
  const swap = (name, value) => { const url = new URL(good); url.searchParams.set(name, value); return url.href; };
  for (const url of [swap("k", "0".repeat(64)), swap("k", "short"), swap("p", "stove"), swap("o", "b"), swap("o", "constructor"), good.split("?")[0] + "?"]) {
    assert.deepEqual(await get(ctx, url), CLOSED, url);
  }
  for (const input of [undefined, null, "o=a", [], { o: 1, p: 2, k: 3 }, { o: ["a"], p: "mug", k: {} }]) {
    assert.deepEqual(await plugin.routes.write.handler({ input, request: { url: "", method: "POST", headers: {} } }, ctx), CLOSED);
    assert.deepEqual(await post(ctx, input), CLOSED);
  }
  assert.deepEqual(await post(ctx, fieldsOf(swap("k", "0".repeat(64)), { stars: "5" })), CLOSED);
  assert.equal(ctx.storage.reviews.rows.size, 0);
  const kept = await row(ctx, "a");
  await put(ctx, "a", { ...kept, askedAt: new Date(Date.now() - 61 * DAY).toISOString() });
  assert.deepEqual(await get(ctx, good), CLOSED);
  assert.deepEqual(await post(ctx, fieldsOf(good, { stars: "5" })), CLOSED);
  // An order that was never asked has no link at all.
  await put(ctx, "w", order(1));
  assert.deepEqual(await get(ctx, swap("o", "w")), CLOSED);
  assert.equal(ctx.storage.reviews.rows.size, 0);
});

test("a buyer's review is kept once, published at once, and counts in the rating", async () => {
  const ctx = store();
  await put(ctx, "a", order(15));
  await run(ctx);
  const [mug, tent] = links(ctx.sent[0]);
  assert.deepEqual(await post(ctx, fieldsOf(mug, { stars: "4", body: "  Keeps coffee hot.\r\nGood handle.  ", name: "" })), { ok: true, result: "sent" });
  const [[id, saved]] = [...ctx.storage.reviews.rows];
  // Shoppers see a review's id, so it gives away nothing about the order.
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.deepEqual({ ...saved.data, createdAt: "" }, { productId: "mug", productName: "Camp <Mug>", stars: 4, body: "Keeps coffee hot.\nGood handle.",
    name: "Verified buyer", status: "published", createdAt: "", orderId: "order-1" });
  assert.deepEqual(await ctx.storage.ratings.get("mug"), { value: 4, count: 1, turn: 1 });
  // The same link again changes nothing, whatever it carries.
  assert.deepEqual(await post(ctx, fieldsOf(mug, { stars: "1", body: "Changed my mind" })), { ok: true, result: "done" });
  assert.deepEqual(await get(ctx, mug), { ok: true, state: "done" });
  assert.equal(ctx.storage.reviews.rows.size, 1);
  assert.equal((await ctx.storage.ratings.get("mug")).value, 4);
  // The other product in the order still has its own review.
  assert.deepEqual(await post(ctx, fieldsOf(tent, { stars: 5, name: "  Sam   from Ohio " })), { ok: true, result: "sent" });
  assert.equal([...ctx.storage.reviews.rows.values()].find(found => found.data.productId === "tent").data.name, "Sam from Ohio");
  assert.equal(ctx.storage.reviews.rows.size, 2);
});

test("the same form sent twice at once keeps one review", async () => {
  const ctx = store();
  await put(ctx, "a", order(15));
  await run(ctx);
  const fields = fieldsOf(links(ctx.sent[0])[0], { stars: "5" });
  const results = (await Promise.all([post(ctx, fields), post(ctx, fields), post(ctx, fields)])).map(found => found.result).sort();
  assert.deepEqual(results, ["done", "done", "sent"]);
  assert.equal(ctx.storage.reviews.rows.size, 1);
  assert.equal((await ctx.storage.ratings.get("mug")).count, 1);
});

test("with approve-first on, a new review waits and does not count yet", async () => {
  const ctx = store();
  await save(ctx, { approveFirst: true, requestsOn: true, requestDays: 14 });
  await put(ctx, "a", order(15));
  await run(ctx);
  assert.deepEqual(await post(ctx, fieldsOf(links(ctx.sent[0])[0], { stars: "1" })), { ok: true, result: "held" });
  assert.equal([...ctx.storage.reviews.rows.values()][0].data.status, "pending");
  assert.equal(await ctx.storage.ratings.get("mug"), null);
});

test("a review that cannot be kept is refused with the reason, and nothing is kept", async () => {
  const ctx = store();
  await put(ctx, "a", order(15));
  await run(ctx);
  const link = links(ctx.sent[0])[0];
  for (const [fields, code] of [
    [{ body: "No stars" }, "STARS"], [{ stars: "6" }, "STARS"], [{ stars: "2.5" }, "STARS"], [{ stars: 0 }, "STARS"], [{ stars: 4.5 }, "STARS"], [{ stars: " 5" }, "STARS"],
    [{ stars: "5", body: "x".repeat(2001) }, "LONG"], [{ stars: "5", name: "n".repeat(61) }, "NAME"], [{ stars: "5", body: "bell\u0007" }, "CHARS"],
  ]) {
    assert.deepEqual(await post(ctx, fieldsOf(link, fields)), { ok: false, error: { code } });
  }
  assert.equal(ctx.storage.reviews.rows.size, 0);
  assert.equal((await get(ctx, link)).state, "open");
});

test("a buyer who has not reviewed everything gets one reminder 7 days after the request, for what is left", async () => {
  const ctx = store();
  await put(ctx, "a", order(15));
  await run(ctx);
  const first = links(ctx.sent[0]);
  // The buyer reviews the mug and leaves the tent.
  assert.equal((await post(ctx, fieldsOf(first[0], { stars: "5" }))).result, "sent");
  await age(ctx, "a", 6);
  await run(ctx);
  assert.equal(ctx.sent.length, 1);
  await age(ctx, "a", 7);
  await run(ctx);
  assert.equal(ctx.sent.length, 2);
  const reminder = ctx.sent[1];
  assert.equal(reminder.to, "sam@example.test");
  assert.equal(reminder.subject, "A reminder: how was your order from Camp Store?");
  assert.match(reminder.text, /This is the only reminder\./);
  assert.equal(links(reminder).length, 1);
  assert.match(links(reminder)[0], /^https:\/\/store\.example\.test\/review\?o=a&p=tent&k=[0-9a-f]{64}$/);
  assert.doesNotMatch(reminder.text, /Camp <Mug>/);
  const kept = await row(ctx, "a");
  assert.equal(kept.state, "reminded");
  assert.match(kept.remindKey, /^[0-9a-f]{64}$/);
  assert.notEqual(kept.remindKey, kept.key);
  assert.equal(JSON.stringify(kept).includes(new URL(links(reminder)[0]).searchParams.get("k")), false);
  // The reminder's link opens the form, and so does the first email's.
  assert.equal((await get(ctx, links(reminder)[0])).state, "open");
  assert.equal((await get(ctx, first[1])).state, "open");
  assert.equal((await get(ctx, first[0])).state, "done");
  // Never a second reminder.
  await age(ctx, "a", 30);
  await run(ctx);
  await run(ctx);
  assert.equal(ctx.sent.length, 2);
  assert.match(await page(ctx), /A buyer who has not reviewed everything gets one reminder 7 days later\. 1 buyer has been asked so far, and 1 was reminded\./);
});

test("a buyer who reviewed everything, even a review the owner hid, gets no reminder", async () => {
  const ctx = store();
  await put(ctx, "a", order(15));
  await run(ctx);
  for (const link of links(ctx.sent[0])) assert.equal((await post(ctx, fieldsOf(link, { stars: "2" }))).result, "sent");
  const [hidden] = [...ctx.storage.reviews.rows.keys()];
  await admin(ctx, { type: "block_action", action_id: `hide:${hidden}` });
  await age(ctx, "a", 8);
  await run(ctx);
  assert.equal(ctx.sent.length, 1);
  assert.equal((await row(ctx, "a")).state, "settled");
  assert.match(await page(ctx), /1 buyer has been asked so far\./);
});

test("each email's link works for its own 60 days", async () => {
  const ctx = store();
  await put(ctx, "a", order(15));
  await run(ctx);
  const first = links(ctx.sent[0])[0];
  await age(ctx, "a", 7);
  await run(ctx);
  const second = links(ctx.sent[1])[0];
  // 61 days after the request the first link is closed and the reminder's, sent 54 days ago, is open.
  const kept = await row(ctx, "a");
  await put(ctx, "a", { ...kept, askedAt: new Date(Date.now() - 61 * DAY).toISOString(), remindedAt: new Date(Date.now() - 54 * DAY).toISOString() });
  assert.deepEqual(await get(ctx, first), CLOSED);
  assert.equal((await get(ctx, second)).state, "open");
  await put(ctx, "a", { ...kept, askedAt: new Date(Date.now() - 68 * DAY).toISOString(), remindedAt: new Date(Date.now() - 61 * DAY).toISOString() });
  assert.deepEqual(await get(ctx, second), CLOSED);
  assert.deepEqual(await post(ctx, fieldsOf(second, { stars: "5" })), CLOSED);
  assert.equal(ctx.storage.reviews.rows.size, 0);
});

test("the owner sets the reminder's wait from 1 to 10 days and can turn it off", async () => {
  const ctx = store();
  for (const days of [0, 11, 2.5, "3", undefined]) {
    assert.match((await save(ctx, { requestsOn: true, requestDays: 14, reminderDays: days })).toast.message, /^Not saved\. The wait before the reminder is a whole number of days from 1 to 10\./);
  }
  await put(ctx, "a", order(15));
  await run(ctx);
  await save(ctx, { requestsOn: true, requestDays: 14, remindersOn: false, reminderDays: 2 });
  assert.match(await page(ctx), /No reminder is sent\./);
  await age(ctx, "a", 9);
  await run(ctx);
  assert.equal(ctx.sent.length, 1);
  assert.equal((await row(ctx, "a")).state, "asked");
  await save(ctx, { requestsOn: true, requestDays: 14, remindersOn: true, reminderDays: 2 });
  await age(ctx, "a", 1);
  await run(ctx);
  assert.equal(ctx.sent.length, 1);
  await age(ctx, "a", 2);
  await run(ctx);
  assert.equal(ctx.sent.length, 2);
  // A reminder whose turn passed more than 30 days ago while reminders were off is not sent.
  await put(ctx, "b", order(60, { orderId: "order-2", state: "asked", askedAt: new Date(Date.now() - 33 * DAY).toISOString(), key: "0".repeat(64) }));
  await run(ctx);
  assert.equal(ctx.sent.length, 2);
  assert.equal((await row(ctx, "b")).state, "settled");
  // With requests off nobody is emailed, reminders included.
  await put(ctx, "c", order(20, { orderId: "order-3", state: "asked", askedAt: new Date(Date.now() - 5 * DAY).toISOString(), key: "0".repeat(64) }));
  await save(ctx, { requestsOn: false, requestDays: 14, remindersOn: true, reminderDays: 2 });
  await run(ctx);
  assert.equal(ctx.sent.length, 2);
});

test("a reminder that cannot be handed over is tried 3 times, then given up on, and two runs at once remind once", async () => {
  const ctx = store();
  await put(ctx, "a", order(15));
  await run(ctx);
  const first = links(ctx.sent[0])[0];
  await age(ctx, "a", 7);
  const sender = ctx.email;
  let calls = 0;
  ctx.email = { async send() { calls++; throw new Error("sender down for sam@example.test"); } };
  await run(ctx);
  assert.equal((await row(ctx, "a")).state, "asked");
  assert.equal("remindKey" in (await row(ctx, "a")), false);
  await run(ctx);
  await run(ctx);
  await run(ctx);
  assert.equal(calls, 3);
  assert.equal((await row(ctx, "a")).state, "settled");
  // The first email's link still works.
  assert.equal((await get(ctx, first)).state, "open");
  ctx.email = sender;
  await put(ctx, "b", order(15, { orderId: "order-2" }));
  await run(ctx);
  await age(ctx, "b", 7);
  await Promise.all([run(ctx), run(ctx)]);
  assert.equal(ctx.sent.filter(message => message.subject.startsWith("A reminder")).length, 1);
});
