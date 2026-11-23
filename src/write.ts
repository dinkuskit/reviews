import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import type { ShippedOrder } from "./inbox.js";
import { holds, kept, opens, reviewIdOf, stop, stopped } from "./requests.js";
import { addReview, approveFirst, readReview, BODY_MAX, NAME_MAX } from "./reviews.js";

/**
 * The plugin's side of the buyer's review page, reached only with the secret from a link in the
 * request email (reviews-who-may-review-20261122). EmDash does not let a plugin serve a web page,
 * so the store draws the page at /review. Its server asks `write` what the link opens, and
 * when the buyer sends the page's plain form, the store's server hands it to `send`. The link
 * proves the purchase; it works for one review per product, and nothing about the order or the
 * buyer's email is ever answered here.
 */
const ANONYMOUS = "Verified buyer";

interface Link { id: string; productId: string; secret: string }

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});

function linkOf(input: Record<string, unknown>): Link | null {
  const { o: id, p: productId, k: secret } = input;
  if (typeof id !== "string" || typeof productId !== "string" || typeof secret !== "string") return null;
  if (!id || !productId || id.length > 200 || productId.length > 200 || secret.length !== 64) return null;
  return { id, productId, secret };
}

/**
 * The stop link (review-email-stop-link-20261122): the same `o` and `k` with `stop` and no product.
 * It opens the order whose request or reminder email carried the secret, as long as that request is kept.
 */
async function stopOrder(ctx: PluginContext, input: Record<string, unknown>): Promise<ShippedOrder | null> {
  const { o: id, k: secret } = input;
  if (typeof id !== "string" || typeof secret !== "string" || !id || id.length > 200 || secret.length !== 64) return null;
  const shipped = (ctx.storage as unknown as { shipped: { get(id: string): Promise<unknown> } }).shipped;
  const order = kept(await shipped.get(id));
  return order && (await holds(order, secret)) ? order : null;
}
const stopAsked = (input: Record<string, unknown>) => input.stop === "1" || input.stop === 1 || input.stop === true;

interface Opened { order: ShippedOrder; line: ShippedOrder["lines"][number]; reviewId: string }

/** The order and product a link stands for, or null for any link that does not open one. */
async function open(ctx: PluginContext, link: Link): Promise<Opened | null> {
  const shipped = (ctx.storage as unknown as { shipped: { get(id: string): Promise<unknown> } }).shipped;
  const order = kept(await shipped.get(link.id));
  if (!order || !(await opens(order, link.secret, Date.now()))) return null;
  const line = order.lines.find(found => found.productId === link.productId);
  if (!line) return null;
  // One review per product per order (reviews-review-content-20261122): the id is made from the pair.
  return { order, line, reviewId: await reviewIdOf(order.orderId, line.productId) };
}

/** "Sam T." from "Sam Taylor": the name shown unless the buyer changes it. */
export function shownName(name: string): string {
  const [first = "", ...rest] = name.trim().split(/\s+/);
  const last = rest.at(-1);
  return (last ? `${first} ${[...last][0]!.toUpperCase()}.` : first).slice(0, NAME_MAX) || ANONYMOUS;
}

/** Why nothing was opened or kept. CLOSED: the link opens nothing, for whatever reason. The rest: the form says why. */
export type Refusal = "CLOSED" | "STARS" | "LONG" | "NAME" | "CHARS";
const refuse = (code: Refusal) => ({ ok: false as const, error: { code } });

/**
 * `POST write` with `{ o: <shipped order>, p: <product>, k: <secret> }`: what the store's review page shows.
 * open: the form, with the product's name and the name the review would carry. done: this product
 * was already reviewed from this order. Any link that opens nothing is refused as CLOSED.
 * With `stop` in place of `p` it answers the stop page: stop (the button), or stopped (already done).
 */
export async function writePage(route: SandboxedRouteContext, ctx: PluginContext) {
  const input = record(route.input);
  if (stopAsked(input)) {
    // Asking changes nothing: a mail filter that opens every link in an email stops nothing.
    const order = await stopOrder(ctx, input);
    if (!order) return refuse("CLOSED");
    return { ok: true as const, state: (await stopped(ctx, order.email)) ? "stopped" as const : "stop" as const, store: ctx.site.name || "" };
  }
  const link = linkOf(input);
  const opened = link ? await open(ctx, link) : null;
  if (!opened) return refuse("CLOSED");
  if (await readReview(ctx, opened.reviewId)) return { ok: true as const, state: "done" as const };
  return { ok: true as const, state: "open" as const, productId: opened.line.productId, productName: opened.line.productName,
    name: shownName(opened.order.name), anonymousName: ANONYMOUS, bodyMax: BODY_MAX, nameMax: NAME_MAX };
}

/**
 * `POST send` with the link's `o`, `p`, `k` and the form's `stars`, `body`, `name`: keeps the buyer's
 * review. sent: published. held: waiting for the owner (approve-first). done: already reviewed,
 * nothing changed. The same link sent twice keeps one review.
 * With `stop` in place of `p` it keeps the buyer's stop and answers stopped.
 */
export async function sendReview(route: SandboxedRouteContext, ctx: PluginContext) {
  const input = record(route.input);
  if (stopAsked(input)) {
    // The buyer pressed "Stop review emails": every review email from this store to their address stops.
    const order = await stopOrder(ctx, input);
    if (!order) return refuse("CLOSED");
    await stop(ctx, order.email);
    return { ok: true as const, result: "stopped" as const, store: ctx.site.name || "" };
  }
  const link = linkOf(input);
  const opened = link ? await open(ctx, link) : null;
  if (!opened) return refuse("CLOSED");
  if (await readReview(ctx, opened.reviewId)) return { ok: true as const, result: "done" as const };
  const stars = typeof input.stars === "number" ? input.stars : typeof input.stars === "string" && /^[1-5]$/.test(input.stars) ? Number(input.stars) : NaN;
  const body = (typeof input.body === "string" ? input.body : "").replace(/\r\n?/g, "\n").trim();
  const name = (typeof input.name === "string" ? input.name : "").replace(/\s+/g, " ").trim();
  const unshowable = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return refuse("STARS");
  if (body.length > BODY_MAX) return refuse("LONG");
  if (name.length > NAME_MAX) return refuse("NAME");
  if (unshowable.test(body) || unshowable.test(name)) return refuse("CHARS");
  const hold = await approveFirst(ctx);
  const saved = await addReview(ctx, opened.reviewId, {
    productId: opened.line.productId, productName: opened.line.productName, stars, body, name: name || ANONYMOUS,
    status: hold ? "pending" : "published", createdAt: new Date().toISOString(), orderId: opened.order.orderId,
  });
  return { ok: true as const, result: saved ? (hold ? "held" as const : "sent" as const) : "done" as const };
}
