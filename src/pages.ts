import type { Block, BlockResponse } from "@emdash-cms/blocks/server";
import type { CourierState } from "./inbox.js";
import { REPLY_MAX, type Listed, type Review, type Status } from "./reviews.js";

/** The owner's Reviews pages, drawn fresh from the store's own records on every click. */
export type Toast = BlockResponse["toast"];
export type Filter = "all" | Status;
export const FILTERS: Record<Filter, string> = { all: "All", published: "Published", pending: "Waiting for approval", hidden: "Hidden", spam: "Spam" };

const header = (text: string): Block => ({ type: "header", text });
const context = (text: string): Block => ({ type: "context", text });
const section = (text: string): Block => ({ type: "section", text });
const day = (at: string) => new Date(at).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" });
/** "★★★★☆", the way every storefront draws a rating. */
export const starRow = (stars: number) => "★".repeat(stars) + "☆".repeat(5 - stars);
const STATUS: Record<Status, string> = { published: "🟢 Published", pending: "🟡 Waiting for approval", hidden: "⚪ Hidden", spam: "🔴 Spam" };

export interface Counts { published: number; pending: number; hidden: number; spam: number }

export interface ListView {
  filter: Filter;
  items: Listed[];
  /** Set when more reviews follow this page. */
  next?: string;
  counts: Counts;
  approveFirst: boolean;
  /** Whether the store's courier is bringing shipped orders, and how many wait. */
  courier: CourierState;
}

const minute = (at: string) => new Date(at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";

/** Says plainly whether shipped orders are reaching Reviews (plugin-communication-rule-20261122). */
function courierBlock({ state, lastVisit, waiting }: CourierState): Block {
  const orders = waiting === 1 ? "1 shipped order is" : `${waiting} shipped orders are`;
  if (state === "missing") {
    return { type: "banner", variant: "alert", title: "Your store's courier has not come by",
      description: "Reviews hears that an order shipped through your store's courier. The DinkusKit store template includes it; on another EmDash site, add the DinkusKit courier package. Until it runs, Reviews cannot know which buyers to ask." };
  }
  if (state === "late") {
    return { type: "banner", variant: "alert", title: "Your store's courier is late",
      description: `It last came by ${minute(lastVisit!)} and should come about once a minute. ${orders} waiting here. New shipped orders arrive when it runs again.` };
  }
  return context(`Your store's courier last came by ${minute(lastVisit!)}. ${orders} waiting for a review request. This version does not send the request yet.`);
}

/** Every review the store holds, newest first, with the one setting that decides how new ones arrive. */
export function listPage(view: ListView, toast?: Toast): BlockResponse {
  const { counts, filter } = view;
  const total = counts.published + counts.pending + counts.hidden + counts.spam;
  const blocks: Block[] = [header("Reviews")];
  if (total === 0) {
    blocks.push({ type: "banner", variant: "default", title: "No reviews yet",
      description: "Reviews appear here when your buyers write them. This version does not ask buyers for reviews yet, so nothing is sent to them." });
  } else {
    blocks.push({ type: "stats", items: [
      { label: "Published", value: counts.published },
      { label: "Waiting for approval", value: counts.pending },
      { label: "Hidden or spam", value: counts.hidden + counts.spam },
    ] });
    blocks.push({ type: "actions", elements: (Object.keys(FILTERS) as Filter[]).map(key =>
      ({ type: "button" as const, label: FILTERS[key], action_id: "list", value: key, ...(key === filter ? { style: "primary" as const } : {}) })) });
    blocks.push({ type: "table", page_action_id: `more:${filter}`,
      empty_text: filter === "all" ? "No reviews yet." : `No reviews are ${FILTERS[filter].toLowerCase()}.`,
      columns: [{ key: "review", label: "Review", format: "element" }, { key: "from", label: "From" }, { key: "status", label: "Status" }],
      ...(view.next ? { next_cursor: view.next } : {}),
      rows: view.items.map(({ id, review }) => ({
        review: { type: "button", label: `${starRow(review.stars)} ${review.productName || review.productId}`, action_id: "open", value: id },
        from: `${review.name} · ${day(review.createdAt)}`,
        status: STATUS[review.status],
      })),
    });
  }
  blocks.push(courierBlock(view.courier));
  blocks.push({ type: "divider" }, { type: "form", block_id: "approve-first",
    fields: [{ type: "toggle", action_id: "approveFirst", label: "Hold every new review until I approve it",
      description: "Off: a review is published as soon as the buyer sends it, whatever its stars. On: every review waits here for you, whatever its stars.",
      initial_value: view.approveFirst }],
    submit: { label: "Save", action_id: "save_settings" } });
  blocks.push(context("You can hide a review, mark it as spam and reply to it. Nobody can change a buyer's stars or words."));
  return { blocks, ...(toast ? { toast } : {}) };
}

/** One review as the buyer wrote it, with the owner's three choices and the one public reply. */
export function reviewPage(id: string, review: Review, toast?: Toast, failure?: string): BlockResponse {
  const blocks: Block[] = [header(`${starRow(review.stars)} ${review.productName || review.productId}`)];
  if (failure) blocks.push({ type: "banner", variant: "error", title: "Not saved", description: failure });
  blocks.push({ type: "fields", fields: [
    { label: "Status", value: STATUS[review.status] },
    { label: "From", value: review.name },
    { label: "Written", value: day(review.createdAt) },
    { label: "Stars", value: `${review.stars} of 5` },
  ] });
  blocks.push(section(review.body || "The buyer left stars and no words."));
  const actions: Block & { type: "actions" } = { type: "actions", elements: [] };
  if (review.status !== "published") actions.elements.push({ type: "button", label: review.status === "pending" ? "Approve and publish" : "Publish again", action_id: `publish:${id}`, style: "primary" });
  if (review.status !== "hidden") actions.elements.push({ type: "button", label: "Hide", action_id: `hide:${id}`,
    confirm: { title: "Hide this review?", text: "Shoppers stop seeing it and it no longer counts in the product's rating. You can publish it again.", confirm: "Hide", deny: "Keep" } });
  if (review.status !== "spam") actions.elements.push({ type: "button", label: "Mark as spam", action_id: `spam:${id}`,
    confirm: { title: "Mark as spam?", text: "Shoppers stop seeing it and it no longer counts in the product's rating. You can publish it again.", confirm: "Mark as spam", deny: "Keep", style: "danger" } });
  actions.elements.push({ type: "button", label: "Back to reviews", action_id: "list", value: "all" });
  blocks.push(actions, { type: "divider" });
  blocks.push({ type: "form", block_id: `reply-${id}`,
    fields: [{ type: "text_input", action_id: "reply", label: "Your public reply", multiline: true,
      initial_value: review.reply?.body ?? "", placeholder: "Thank the buyer or answer their concern. Shoppers see this under the review." }],
    submit: { label: review.reply ? "Save reply" : "Reply", action_id: `reply:${id}` } });
  blocks.push(context(review.reply
    ? `Replied ${day(review.reply.at)}. Save empty text to take the reply away. Up to ${REPLY_MAX} characters.`
    : `One reply per review, up to ${REPLY_MAX} characters. You can change it later.`));
  return { blocks, ...(toast ? { toast } : {}) };
}
