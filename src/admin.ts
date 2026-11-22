import type { BlockResponse } from "@emdash-cms/blocks/server";
import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import { FILTERS, listPage, reviewPage, type Filter, type Toast } from "./pages.js";
import { approveFirst, countReviews, listReviews, readReview, setApproveFirst, setReply, setStatus, REPLY_MAX, type Status } from "./reviews.js";

/** EmDash's Editor role; Administrators are above it. Lower roles never see Reviews. */
const EDITOR = 40;

interface Action { type: "block_action"; action_id: string; value?: unknown }
interface Submit { type: "form_submit"; action_id: string; values: Record<string, unknown> }
type Interaction = { type: "page_load" } | Action | Submit;

function interaction(input: unknown): Interaction | null {
  if (typeof input !== "object" || input === null) return null;
  const value = input as Record<string, unknown>;
  if (value.type === "page_load") return { type: "page_load" };
  if (value.type === "block_action" && typeof value.action_id === "string") return { type: "block_action", action_id: value.action_id, value: value.value };
  if (value.type === "form_submit" && typeof value.action_id === "string" && typeof value.values === "object" && value.values !== null) {
    return { type: "form_submit", action_id: value.action_id, values: value.values as Record<string, unknown> };
  }
  return null;
}

const filterOf = (value: unknown): Filter => (typeof value === "string" && Object.hasOwn(FILTERS, value) ? value as Filter : "all");
/** A review's id from `verb:<id>`. An id may itself hold a colon, so everything after the first one is the id. */
const idOf = (actionId: string) => actionId.slice(actionId.indexOf(":") + 1);
const cursorOf = (value: unknown) => {
  const cursor = typeof value === "object" && value !== null ? (value as { cursor?: unknown }).cursor : undefined;
  return typeof cursor === "string" && cursor.length <= 2000 ? cursor : undefined;
};

async function list(ctx: PluginContext, filter: Filter, cursor?: string, toast?: Toast): Promise<BlockResponse> {
  const [page, published, pending, hidden, spam, hold] = await Promise.all([
    listReviews(ctx, filter === "all" ? {} : { status: filter }, cursor),
    countReviews(ctx, "published"), countReviews(ctx, "pending"), countReviews(ctx, "hidden"), countReviews(ctx, "spam"),
    approveFirst(ctx),
  ]);
  return listPage({ filter, items: page.items, next: page.cursor, counts: { published, pending, hidden, spam }, approveFirst: hold }, toast);
}

const GONE: Toast = { message: "That review is no longer here.", type: "error" };
const VERBS: Record<string, { status: Exclude<Status, "pending">; done: string }> = {
  publish: { status: "published", done: "Published. It counts in the product's rating." },
  hide: { status: "hidden", done: "Hidden. It no longer counts in the product's rating." },
  spam: { status: "spam", done: "Marked as spam. It no longer counts in the product's rating." },
};

/**
 * The Reviews page's one private route. EmDash lets only Editors and Administrators in
 * (content:edit_any); the check here is the belt to that permission's braces.
 * Nothing on this route can write a review or change a buyer's stars, words, name or date.
 */
export async function reviewsAdmin(route: SandboxedRouteContext, ctx: PluginContext): Promise<BlockResponse> {
  const user = route.user;
  if (route.ui?.surface !== "admin-page" || typeof user?.role !== "number" || user.role < EDITOR) {
    return { blocks: [{ type: "banner", variant: "error", title: "Reviews is for Editors and Administrators", description: "Ask an Administrator of this site to manage reviews." }] };
  }
  const input = interaction(route.input);
  if (!input) return { blocks: [] };
  if (input.type === "page_load") return list(ctx, "all");

  if (input.type === "form_submit") {
    if (input.action_id === "save_settings") {
      const on = input.values.approveFirst === true;
      await setApproveFirst(ctx, on);
      return list(ctx, "all", undefined, { message: on ? "New reviews now wait for your approval." : "New reviews are now published straight away.", type: "success" });
    }
    if (input.action_id.startsWith("reply:")) {
      const id = idOf(input.action_id), typed = typeof input.values.reply === "string" ? input.values.reply : "";
      const current = await readReview(ctx, id);
      if (!current) return list(ctx, "all", undefined, GONE);
      if (typed.trim().length > REPLY_MAX) return reviewPage(id, current, undefined, `A reply can be up to ${REPLY_MAX} characters. Yours is ${typed.trim().length}.`);
      const saved = await setReply(ctx, id, typed, new Date().toISOString());
      if (!saved) return reviewPage(id, current, undefined, "The review changed while you were typing, or the reply holds characters that cannot be shown. Check it and save again.");
      return reviewPage(id, saved, { message: saved.reply ? "Reply saved. Shoppers see it under the review." : "Reply removed.", type: "success" });
    }
    return { blocks: [] };
  }

  const [verb] = input.action_id.split(":", 1);
  if (input.action_id === "list") return list(ctx, filterOf(input.value));
  if (verb === "more") return list(ctx, filterOf(idOf(input.action_id)), cursorOf(input.value));
  if (input.action_id === "open") {
    const id = typeof input.value === "string" ? input.value : "";
    const found = id ? await readReview(ctx, id) : null;
    return found ? reviewPage(id, found) : list(ctx, "all", undefined, GONE);
  }
  // Own entries only: "constructor" or "toString" must never pass as a verb.
  const change = verb && Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined;
  if (change) {
    const id = idOf(input.action_id);
    const saved = await setStatus(ctx, id, change.status);
    if (saved) return reviewPage(id, saved, { message: change.done, type: "success" });
    const current = await readReview(ctx, id);
    return current ? reviewPage(id, current, undefined, "The review changed just now. Check it and press again.") : list(ctx, "all", undefined, GONE);
  }
  return { blocks: [] };
}
