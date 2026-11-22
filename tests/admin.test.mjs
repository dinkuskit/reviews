import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../dist/plugin.mjs";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { review, staff, store } from "./store.mjs";

const admin = plugin.routes.admin.handler;
const text = response => JSON.stringify(response);
const press = (ctx, action_id, value) => admin(staff({ type: "block_action", action_id, value }), ctx);
const submit = (ctx, action_id, values) => admin(staff({ type: "form_submit", action_id, values }), ctx);
const valid = response => { const checked = validateBlockResponse(response); assert.equal(checked.valid, true, JSON.stringify(checked.errors)); };

test("the admin route is private and for Editors and Administrators", async () => {
  assert.equal(plugin.routes.admin.public, false);
  assert.equal(plugin.routes.admin.permission, "content:edit_any");
  const refused = [staff({ type: "page_load" }, 30), { ...staff({ type: "page_load" }), user: undefined }, { ...staff({ type: "page_load" }, 50), ui: { surface: "editor-panel" } }];
  for (const route of refused) {
    const response = await admin(route, store());
    assert.match(text(response), /Editors and Administrators/);
    assert.doesNotMatch(text(response), /No reviews yet/);
  }
});

test("an empty store says plainly that buyers are not asked yet", async () => {
  for (const role of [40, 50]) {
    const response = await admin(staff({ type: "page_load" }, role), store());
    valid(response);
    assert.match(text(response), /No reviews yet/);
    assert.match(text(response), /nothing is sent to them/);
    assert.match(text(response), /Hold every new review until I approve it/);
  }
});

test("the table lists reviews newest first, 20 a page, and filters by status", async () => {
  const ctx = store();
  for (let n = 1; n <= 23; n++) await ctx.storage.reviews.put(`r${n}`, review({ name: `Buyer ${n}`, status: n === 23 ? "pending" : "published" }));
  const first = await admin(staff({ type: "page_load" }), ctx);
  valid(first);
  const table = first.blocks.find(block => block.type === "table");
  assert.equal(table.rows.length, 20);
  assert.match(table.rows[0].from, /^Buyer 23 · /);
  assert.equal(table.rows[0].status, "🟡 Waiting for approval");
  assert.equal(table.rows[0].review.label, "★★★★★ Camp Mug");
  assert.deepEqual(first.blocks.find(block => block.type === "stats").items.map(item => item.value), [22, 1, 0]);

  const rest = await press(ctx, table.page_action_id, { cursor: table.next_cursor });
  valid(rest);
  const more = rest.blocks.find(block => block.type === "table");
  assert.deepEqual(more.rows.map(row => row.from.split(" · ")[0]), ["Buyer 3", "Buyer 2", "Buyer 1"]);
  assert.equal(more.next_cursor, undefined);

  const waiting = (await press(ctx, "list", "pending")).blocks.find(block => block.type === "table");
  assert.deepEqual(waiting.rows.map(row => row.review.value), ["r23"]);
  assert.equal(waiting.page_action_id, "more:pending");
  const none = (await press(ctx, "list", "spam")).blocks.find(block => block.type === "table");
  assert.equal(none.rows.length, 0);
  assert.equal(none.empty_text, "No reviews are spam.");
});

test("hiding, marking as spam and publishing again move the product's rating with them", async () => {
  const ctx = store();
  await ctx.storage.reviews.put("five", review({ stars: 5 }));
  await ctx.storage.reviews.put("two", review({ stars: 2 }));
  await ctx.storage.reviews.put("held", review({ stars: 1, status: "pending" }));
  await ctx.storage.ratings.put("mug", { value: 3.5, scale_min: 1, scale_max: 5, count: 2 });

  const opened = await press(ctx, "open", "two");
  valid(opened);
  assert.match(text(opened), /Sam T\./);
  assert.deepEqual(opened.blocks.find(block => block.type === "actions").elements.map(button => button.action_id), ["hide:two", "spam:two", "list"]);

  const hidden = await press(ctx, "hide:two");
  valid(hidden);
  assert.equal(hidden.toast.type, "success");
  assert.equal((await ctx.storage.reviews.get("two")).status, "hidden");
  assert.deepEqual(await ctx.storage.ratings.get("mug"), { value: 5, scale_min: 1, scale_max: 5, count: 1 });

  await press(ctx, "spam:five");
  assert.equal((await ctx.storage.reviews.get("five")).status, "spam");
  assert.equal(await ctx.storage.ratings.get("mug"), null, "a product with no published review has no rating");

  const approved = await press(ctx, "publish:held");
  assert.match(text(approved), /Published\. It counts/);
  await press(ctx, "publish:two");
  assert.deepEqual(await ctx.storage.ratings.get("mug"), { value: 1.5, scale_min: 1, scale_max: 5, count: 2 });
});

test("no owner action changes a buyer's stars, words, name, date or order", async () => {
  const ctx = store();
  const written = review({ stars: 1, body: "Arrived cracked.", name: "Verified buyer" });
  await ctx.storage.reviews.put("r1", written);
  await press(ctx, "hide:r1");
  await press(ctx, "spam:r1");
  await press(ctx, "publish:r1");
  await submit(ctx, "reply:r1", { reply: "Sorry about that. A new one is on its way.", stars: 5, body: "Great!", name: "Owner", status: "hidden" });
  const { reply, ...kept } = await ctx.storage.reviews.get("r1");
  assert.deepEqual(kept, written);
  assert.equal(reply.body, "Sorry about that. A new one is on its way.");
  // Nothing on the route writes a review, and "pending" cannot be chosen by the owner.
  for (const action of ["pending:r1", "delete:r1", "create", "stars:r1"]) assert.deepEqual(await press(ctx, action, 5), { blocks: [] });
  assert.equal(await ctx.storage.reviews.count(), 1);
  assert.equal((await ctx.storage.reviews.get("r1")).status, "published");
});

test("one public reply, replaced by saving again and removed by saving empty", async () => {
  const ctx = store();
  await ctx.storage.reviews.put("r1", review());
  const saved = await submit(ctx, "reply:r1", { reply: "  Thank you!  " });
  valid(saved);
  assert.match(saved.toast.message, /Reply saved/);
  assert.equal((await ctx.storage.reviews.get("r1")).reply.body, "Thank you!");
  await submit(ctx, "reply:r1", { reply: "Thanks, Sam." });
  assert.equal((await ctx.storage.reviews.get("r1")).reply.body, "Thanks, Sam.");

  const long = await submit(ctx, "reply:r1", { reply: "x".repeat(2001) });
  valid(long);
  assert.match(text(long), /up to 2000 characters\. Yours is 2001/);
  assert.equal((await ctx.storage.reviews.get("r1")).reply.body, "Thanks, Sam.");

  const removed = await submit(ctx, "reply:r1", { reply: "   " });
  assert.match(removed.toast.message, /Reply removed/);
  assert.equal("reply" in await ctx.storage.reviews.get("r1"), false);
  assert.deepEqual(await ctx.storage.ratings.get("mug"), null, "a reply never touches the rating");
});

test("a review that is gone or just changed is said plainly", async () => {
  const ctx = store();
  for (const response of [await press(ctx, "open", "nope"), await press(ctx, "hide:nope"), await submit(ctx, "reply:nope", { reply: "hi" })]) {
    valid(response);
    assert.equal(response.toast.message, "That review is no longer here.");
  }
  await ctx.storage.reviews.put("r1", review());
  const racing = ctx.storage.reviews.compareAndSet;
  ctx.storage.reviews.compareAndSet = async () => ({ applied: false });
  const lost = await press(ctx, "hide:r1");
  valid(lost);
  assert.match(text(lost), /The review changed just now/);
  ctx.storage.reviews.compareAndSet = racing;
  assert.equal((await ctx.storage.reviews.get("r1")).status, "published");
});

test("the approve-first switch is off until the owner turns it on", async () => {
  const ctx = store();
  const toggle = response => response.blocks.find(block => block.type === "form").fields[0].initial_value;
  assert.equal(toggle(await admin(staff({ type: "page_load" }), ctx)), false);
  const on = await submit(ctx, "save_settings", { approveFirst: true });
  assert.equal(on.toast.message, "New reviews now wait for your approval.");
  assert.equal(toggle(await admin(staff({ type: "page_load" }), ctx)), true);
  const off = await submit(ctx, "save_settings", {});
  assert.equal(off.toast.message, "New reviews are now published straight away.");
  assert.equal(toggle(off), false);
});

test("a record that is not a review is never shown", async () => {
  const ctx = store();
  await ctx.storage.reviews.put("bad-stars", review({ stars: 6 }));
  await ctx.storage.reviews.put("bad-status", review({ status: "featured" }));
  await ctx.storage.reviews.put("good", review());
  const table = (await admin(staff({ type: "page_load" }), ctx)).blocks.find(block => block.type === "table");
  assert.deepEqual(table.rows.map(row => row.review.value), ["good"]);
  assert.equal((await press(ctx, "open", "bad-stars")).toast.message, "That review is no longer here.");
});
