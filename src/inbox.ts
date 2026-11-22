import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";

/**
 * The Reviews plugin's courier inbox (dinkuskit/courier docs/doors.md). EmDash plugins cannot call
 * each other, so the store's courier carries the news that an order shipped from Commerce to here.
 * Everything kept stays in the store's own database; the buyer's email never leaves it.
 */
/**
 * A refusal, in the shape of EmDash's own route error. EmDash's sandbox passes only the words of a
 * thrown error back to the caller (as ROUTE_ERROR, status 400), so the code leads the words as well.
 */
class PluginRouteError extends Error {
  override name = "PluginRouteError";
  constructor(readonly code: string, message: string, readonly status: number) { super(`${code}: ${message}`); }
}

export const COURIER = 1;
export const SENDER = "dinkus-commerce";
export const TOPIC = "order.shipped";
/** Shipped orders taken in one handoff: the courier's default. */
const BATCH = 50;
const MAX_ITEMS = 100;
const LAST_VISIT = "courier:last-visit";
const BOOKMARK = `courier:after:${encodeURIComponent(SENDER)}:${encodeURIComponent(TOPIC)}`;
/** A run is due every minute; five quiet minutes means the courier is late. */
const LATE_AFTER_MS = 5 * 60_000;
const LINES_MAX = 100;

/**
 * One shipped order. waiting: its review request is not sent yet. asked: the request email went to
 * the store's email sender. failed: handing it over failed three times and it was given up on.
 * missed: its turn passed more than 30 days ago while requests were off, so it is not asked.
 */
export interface ShippedOrder {
  orderId: string;
  /** When the order shipped, as Commerce recorded it. The wait before asking counts from here. */
  shippedAt: string;
  /** The buyer's email and name from the order; kept in the store, never shown to shoppers. */
  email: string;
  name: string;
  /** The products bought; each can be reviewed once from this order. */
  lines: { productId: string; productName: string }[];
  state: "waiting" | "asked" | "failed" | "missed";
  receivedAt: string;
  /** When the request email was handed to the store's email sender. */
  askedAt?: string;
  /** SHA-256 of the secret in the email's links; the secret itself is never kept. */
  key?: string;
  /** How many times the email was handed over, failures included. */
  tries?: number;
}

interface Collection {
  get(id: string): Promise<unknown>;
  count(where?: Record<string, unknown>): Promise<number>;
  compareAndSet(id: string, expectedRevision: string | null, data: unknown): Promise<{ applied: boolean }>;
}
const shipped = (ctx: PluginContext) => (ctx.storage as unknown as { shipped: Collection }).shipped;

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value : null;
const when = (value: unknown) => (typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);

/** A courier item as a shipped order, or null when it is not one; a bad item is never kept. */
export function shippedOrder(item: unknown, now: string): { id: string; order: ShippedOrder } | null {
  if (!record(item) || !record(item.data)) return null;
  const id = text(item.id, 200), data = item.data;
  const orderId = text(data.orderId, 200), shippedAt = when(data.shippedAt ?? item.at);
  const email = text(data.email, 254), name = text(data.name, 200);
  if (!id || !orderId || !shippedAt || !email || !/^[^\s@]+@[^\s@]+$/.test(email) || !name) return null;
  if (!Array.isArray(data.lines) || data.lines.length === 0 || data.lines.length > LINES_MAX) return null;
  const lines: ShippedOrder["lines"] = [];
  const seen = new Set<string>();
  for (const line of data.lines) {
    const productId = record(line) ? text(line.productId, 200) : null;
    const productName = record(line) && typeof line.productName === "string" ? text(line.productName, 300) ?? "" : "";
    if (!productId) return null;
    // The same product twice in one order is still one review.
    if (seen.has(productId)) continue;
    seen.add(productId);
    lines.push({ productId, productName });
  }
  return { id, order: { orderId, shippedAt, email, name, lines, state: "waiting", receivedAt: now } };
}

function request(route: SandboxedRouteContext): Record<string, unknown> {
  // Over HTTP a private route always carries a signed-in person; the courier calls from the store's own code with none.
  if (route.user) throw new PluginRouteError("COURIER_ONLY", "Only the store's courier may use this door.", 403);
  const input = route.input;
  if (!record(input) || input.courier !== COURIER || typeof input.op !== "string") throw new PluginRouteError("BAD_COURIER_REQUEST", "This is not a courier request.", 400);
  return input;
}

/** `POST courier/inbox`: says what Reviews listens to, then takes each batch of shipped orders. */
export async function courierInbox(route: SandboxedRouteContext, ctx: PluginContext): Promise<unknown> {
  const input = request(route);
  if (input.op === "wants") {
    await ctx.kv.set(LAST_VISIT, new Date().toISOString());
    const after = await ctx.kv.get<unknown>(BOOKMARK);
    return { courier: COURIER, wants: [{ from: SENDER, topic: TOPIC, after: typeof after === "string" ? after : null, limit: BATCH }] };
  }
  if (input.op !== "deliver") throw new PluginRouteError("BAD_COURIER_REQUEST", "An inbox answers \"wants\" and \"deliver\".", 400);
  const { from, topic, items } = input;
  if (from !== SENDER || topic !== TOPIC) throw new PluginRouteError("UNWANTED_TOPIC", "Reviews only takes shipped orders from Commerce.", 400);
  if (!Array.isArray(items) || items.length > MAX_ITEMS) throw new PluginRouteError("BAD_COURIER_REQUEST", "A delivery needs at most 100 items.", 400);
  const after = typeof input.after === "string" ? input.after : null, next = typeof input.next === "string" ? input.next : null;
  const before = await ctx.kv.getVersioned<unknown>(BOOKMARK);
  const now = new Date().toISOString();
  let saved = 0;
  for (const item of items) {
    const found = shippedOrder(item, now);
    // Created only when absent: an order already here is left exactly as it is, so a repeated delivery changes nothing.
    if (found && (await shipped(ctx).compareAndSet(found.id, null, found.order)).applied) saved++;
  }
  // The bookmark moves only after the orders are saved, and only from the bookmark this batch was asked from,
  // so a slower, older run never moves it back.
  const current = typeof before?.value === "string" ? before.value : null;
  let moved = false;
  if (current === after && next !== null && next !== after) moved = (await ctx.kv.compareAndSet(BOOKMARK, before?.revision ?? null, next)).applied;
  return { courier: COURIER, saved, moved };
}

export interface CourierState { state: "visiting" | "late" | "missing"; lastVisit: string | null; waiting: number }

/** Whether the store's courier is coming by, and how many shipped orders wait, for the owner's page. */
export async function courierState(ctx: PluginContext, now = Date.now()): Promise<CourierState> {
  const [lastVisit, waiting] = await Promise.all([ctx.kv.get<unknown>(LAST_VISIT), shipped(ctx).count({ state: "waiting" })]);
  if (typeof lastVisit !== "string" || Number.isNaN(Date.parse(lastVisit))) return { state: "missing", lastVisit: null, waiting };
  return { state: now - Date.parse(lastVisit) > LATE_AFTER_MS ? "late" : "visiting", lastVisit, waiting };
}
