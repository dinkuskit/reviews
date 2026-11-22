import { pluginResponse, type PluginContext, type SandboxedRouteContext } from "emdash/plugin";
import type { ShippedOrder } from "./inbox.js";
import { kept, keyOf, opens, REVIEW_PAGE } from "./requests.js";
import { addReview, approveFirst, readReview, BODY_MAX, NAME_MAX } from "./reviews.js";

/**
 * The plugin's side of the buyer's review page, reached only with the secret from a link in the
 * request email (reviews-who-may-review-20261122). EmDash does not let a plugin serve a web page,
 * so the store draws the page at REVIEW_PAGE: it asks `write` what the link opens, and its plain
 * form posts to `send`, which answers by sending the buyer back to the page. The link proves the
 * purchase; it works for one review per product, and nothing about the order or the buyer's email
 * is ever answered here.
 */
const ANONYMOUS = "Verified buyer";

interface Link { id: string; productId: string; secret: string }

function linkOf(read: (name: string) => string | null): Link | null {
  const id = read("o"), productId = read("p"), secret = read("k");
  if (!id || !productId || !secret || id.length > 200 || productId.length > 200 || secret.length !== 64) return null;
  return { id, productId, secret };
}

interface Opened { order: ShippedOrder; line: ShippedOrder["lines"][number]; reviewId: string }

/** The order and product a link stands for, or null for any link that does not open one. */
async function open(ctx: PluginContext, link: Link): Promise<Opened | null> {
  const shipped = (ctx.storage as unknown as { shipped: { get(id: string): Promise<unknown> } }).shipped;
  const order = kept(await shipped.get(link.id));
  if (!order || !(await opens(order, link.secret, Date.now()))) return null;
  const line = order.lines.find(found => found.productId === link.productId);
  if (!line) return null;
  // One review per product per order (reviews-review-content-20261122): the id is made from the pair.
  // It is a hash because shoppers see a review's id, and they must not see the order's.
  return { order, line, reviewId: (await keyOf(JSON.stringify([order.orderId, line.productId]))).slice(0, 32) };
}

/** "Sam T." from "Sam Taylor": the name shown unless the buyer changes it. */
export function shownName(name: string): string {
  const [first = "", ...rest] = name.trim().split(/\s+/);
  const last = rest.at(-1);
  return (last ? `${first} ${[...last][0]!.toUpperCase()}.` : first).slice(0, NAME_MAX) || ANONYMOUS;
}

const json = (status: number, body: unknown) => pluginResponse({ status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: { kind: "text", value: JSON.stringify(body) } });

/**
 * `GET write?o=<shipped order>&p=<product>&k=<secret>`: what the store's review page shows.
 * open: the form, with the product's name and the name the review would carry. done: this product
 * was already reviewed from this order. closed (404): the link opens nothing, for whatever reason.
 */
export async function writePage(route: SandboxedRouteContext, ctx: PluginContext) {
  let query: URLSearchParams;
  try {
    query = new URL(route.request.url, "https://store.invalid").searchParams;
  } catch {
    return json(404, { state: "closed" });
  }
  const link = linkOf(name => query.get(name));
  const opened = link ? await open(ctx, link) : null;
  if (!link || !opened) return json(404, { state: "closed" });
  if (await readReview(ctx, opened.reviewId)) return json(200, { state: "done" });
  return json(200, { state: "open", productId: opened.line.productId, productName: opened.line.productName,
    name: shownName(opened.order.name), anonymousName: ANONYMOUS, bodyMax: BODY_MAX, nameMax: NAME_MAX });
}

/** Where `send` sends the buyer: back to the store's review page, saying how it went. */
export type Sent = "sent" | "held" | "done" | "closed" | "stars" | "long" | "name" | "chars";

function back(link: Link | null, result: Sent) {
  const query = new URLSearchParams(link ? { o: link.id, p: link.productId, k: link.secret, r: result } : { r: result });
  return pluginResponse({ status: 303, headers: { Location: `${REVIEW_PAGE}?${query}`, "Cache-Control": "no-store" }, body: null });
}

/**
 * `POST send`, from the review page's plain form: keeps the buyer's review, then sends the buyer back
 * to the page with the outcome in `r`. sent: published. held: waiting for the owner (approve-first).
 * done: already reviewed, nothing changed. closed: the link opens nothing. stars, long, name, chars:
 * not kept, and the form says why. The same link sent twice keeps one review.
 */
export async function sendReview(route: SandboxedRouteContext, ctx: PluginContext) {
  const fields = new URLSearchParams(typeof route.input === "string" ? route.input : "");
  const link = linkOf(name => fields.get(name));
  const opened = link ? await open(ctx, link) : null;
  if (!link || !opened) return back(null, "closed");
  if (await readReview(ctx, opened.reviewId)) return back(link, "done");
  const stars = Number(fields.get("stars"));
  const body = (fields.get("body") ?? "").replace(/\r\n?/g, "\n").trim();
  const name = (fields.get("name") ?? "").replace(/\s+/g, " ").trim();
  const unshowable = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return back(link, "stars");
  if (body.length > BODY_MAX) return back(link, "long");
  if (name.length > NAME_MAX) return back(link, "name");
  if (unshowable.test(body) || unshowable.test(name)) return back(link, "chars");
  const hold = await approveFirst(ctx);
  const saved = await addReview(ctx, opened.reviewId, {
    productId: opened.line.productId, productName: opened.line.productName, stars, body, name: name || ANONYMOUS,
    status: hold ? "pending" : "published", createdAt: new Date().toISOString(), orderId: opened.order.orderId,
  });
  return back(link, saved ? (hold ? "held" : "sent") : "done");
}
