import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../dist/plugin.mjs";
import { validateBlockResponse } from "@emdash-cms/blocks/server";

const admin = plugin.routes.admin.handler;
const route = (role, surface = "admin-page") => ({
  input: { type: "page_load" }, ui: { surface, locale: "en", direction: "ltr" },
  user: role === null ? undefined : { id: "u1", email: "staff@example.test", name: "Staff", role, createdAt: "" },
  request: { url: "", method: "POST", headers: {} },
});
const text = response => JSON.stringify(response);

test("the admin route is private and for Editors and Administrators", async () => {
  assert.equal(plugin.routes.admin.public, false);
  assert.equal(plugin.routes.admin.permission, "content:edit_any");
  for (const refused of [route(30), route(null), route(50, "editor-panel")]) {
    const response = await admin(refused, {});
    assert.match(text(response), /Editors and Administrators/);
    assert.doesNotMatch(text(response), /No reviews yet/);
  }
});

test("the Reviews page says plainly that nothing is collected yet", async () => {
  for (const role of [40, 50]) {
    const response = await admin(route(role), {});
    assert.equal(validateBlockResponse(response).valid, true);
    assert.match(text(response), /No reviews yet/);
    assert.match(text(response), /Nothing is sent to your buyers/);
  }
});

test("the plugin has the admin route and nothing else", () => {
  assert.deepEqual(Object.keys(plugin.routes), ["admin"]);
  assert.equal(plugin.hooks, undefined);
});
