import type { PluginContext } from "emdash/plugin";
import type { ShippedOrder } from "./inbox.js";

/** The store's own page where a buyer writes a review; the store template draws it (see write.ts). */
export const REVIEW_PAGE = "/review";

/**
 * The review request: one email per shipped order, sent by the store's own email sender
 * (reviews-request-email-sender-20261122) once the wait after shipping is over
 * (reviews-request-delay-14-days-20261122). The buyer's email goes to that sender and nowhere else.
 */
export const REQUESTS_TASK = "review-requests";
/** Once an hour is plenty for a wait counted in days. */
export const REQUESTS_SCHEDULE = "0 * * * *";
export const DAYS_DEFAULT = 14;
export const DAYS_MAX = 90;
/** A link in a request email works this long after the email went out. */
export const LINK_DAYS = 60;
/** Emails sent in one hourly run; the rest go out the next hour. */
const RUN_MAX = 25;
/** A request that failed to send this many times is given up on, and the owner's page counts it. */
const TRIES_MAX = 3;
/** An order whose turn passed this long ago (requests were off, or no sender) is no longer asked. */
export const LATE_DAYS = 30;
const DAY_MS = 86_400_000;

const ON = "state:requests-on";
const DAYS = "state:request-days";
const NO_SENDER = "state:no-email-sender";
const NO_ADDRESS = "state:no-site-address";

interface Collection {
  count(where?: Record<string, unknown>): Promise<number>;
  query(options?: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; limit?: number }):
    Promise<{ items: { id: string; data: unknown }[] }>;
  getVersioned(id: string): Promise<{ value: unknown; revision: string } | null>;
  compareAndSet(id: string, expectedRevision: string | null, data: unknown): Promise<{ applied: boolean }>;
}
const shipped = (ctx: PluginContext) => (ctx.storage as unknown as { shipped: Collection }).shipped;

/** Requests are on unless the owner turned them off. */
export async function requestsOn(ctx: PluginContext): Promise<boolean> {
  return (await ctx.kv.get<unknown>(ON)) !== false;
}

/** Days between an order shipping and its request email. */
export async function requestDays(ctx: PluginContext): Promise<number> {
  const days = await ctx.kv.get<unknown>(DAYS);
  return typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= DAYS_MAX ? days : DAYS_DEFAULT;
}

export async function saveRequestSettings(ctx: PluginContext, on: boolean, days: number): Promise<void> {
  await ctx.kv.set(ON, on);
  await ctx.kv.set(DAYS, days);
}

/** A shipped order as kept, in any of its states; null for a row that is not one. */
export function kept(value: unknown): ShippedOrder | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Partial<ShippedOrder>;
  if (typeof row.orderId !== "string" || typeof row.email !== "string" || typeof row.name !== "string" || typeof row.shippedAt !== "string") return null;
  if (!Array.isArray(row.lines) || (row.state !== "waiting" && row.state !== "asked" && row.state !== "failed" && row.state !== "missed")) return null;
  return row as ShippedOrder;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");

/** What is kept of a link's secret: its SHA-256. The secret itself exists only in the buyer's email. */
export async function keyOf(secret: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))));
}

function newSecret(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

/** Whether a link's secret opens this order: asked, inside the link's lifetime, and the secret matches. */
export async function opens(order: ShippedOrder, secret: string, now: number): Promise<boolean> {
  if (order.state !== "asked" || !order.key || !order.askedAt || !/^[0-9a-f]{64}$/.test(secret)) return false;
  if (now - Date.parse(order.askedAt) > LINK_DAYS * DAY_MS) return false;
  const given = await keyOf(secret);
  // Both are SHA-256 hex of the same length; compare every character whatever the first difference.
  let different = 0;
  for (let index = 0; index < given.length; index++) different |= given.charCodeAt(index) ^ order.key.charCodeAt(index);
  return different === 0;
}

const escape = (text: string) => text.replace(/[&<>"']/g, mark => `&#${mark.charCodeAt(0)};`);
/** "Sam" from "Sam Taylor"; the greeting uses the first name only. */
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

/** The address of the store's review page for one product of one shipped order. */
export function reviewLink(ctx: PluginContext, id: string, productId: string, secret: string): string {
  return ctx.url(`${REVIEW_PAGE}?o=${encodeURIComponent(id)}&p=${encodeURIComponent(productId)}&k=${secret}`);
}

/** The request email: every product in the order with its own link, in plain words and in HTML. */
export function requestEmail(ctx: PluginContext, id: string, order: ShippedOrder, secret: string) {
  const store = ctx.site.name || "our store";
  const hello = firstName(order.name) ? `Hi ${firstName(order.name)},` : "Hi,";
  const ask = `Thank you for your order from ${store}. How was it? A review takes a minute and helps other shoppers.`;
  const foot = `Each link works once and for ${LINK_DAYS} days. You are getting this email once, because you bought from ${store}.`;
  const lines = order.lines.map(line => ({ name: line.productName || "Your item", link: reviewLink(ctx, id, line.productId, secret) }));
  const text = [hello, "", ask, "", ...lines.flatMap(line => [`${line.name}`, `Write a review: ${line.link}`, ""]), foot].join("\n");
  const html = `<p>${escape(hello)}</p><p>${escape(ask)}</p>${lines.map(line =>
    `<p><strong>${escape(line.name)}</strong><br><a href="${escape(line.link)}">Write a review</a></p>`).join("")}<p style="color:#666;font-size:13px">${escape(foot)}</p>`;
  return { to: order.email, subject: `How was your order from ${store}?`, text, html };
}

export interface RunResult { sent: number; failed: number; reason?: "off" | "no-sender" | "no-address" }

/**
 * One hourly run: sends the request for each shipped order whose wait is over, oldest first.
 * An order is marked as asked before its email is handed over, by a write that only lands while it
 * still waits, so two runs at once never email one buyer twice. If the handover fails the order
 * waits again, and after three failures it is given up on.
 */
export async function sendDue(ctx: PluginContext, now = Date.now()): Promise<RunResult> {
  if (!(await requestsOn(ctx))) return { sent: 0, failed: 0, reason: "off" };
  const email = ctx.email;
  // No email sender in the store: nothing is sent and nothing is lost; the owner's page says so.
  await ctx.kv.set(NO_SENDER, !email);
  if (!email) return { sent: 0, failed: 0, reason: "no-sender" };
  // The links in the email must be whole web addresses; a site that does not know its own address would send dead links.
  const addressed = /^https?:\/\/[^/]/.test(ctx.url("/"));
  await ctx.kv.set(NO_ADDRESS, !addressed);
  if (!addressed) return { sent: 0, failed: 0, reason: "no-address" };
  const cutoff = now - (await requestDays(ctx)) * DAY_MS;
  const page = await shipped(ctx).query({ where: { state: "waiting" }, orderBy: { shippedAt: "asc" }, limit: RUN_MAX });
  let sent = 0, failed = 0;
  for (const { id } of page.items) {
    const stored = await shipped(ctx).getVersioned(id);
    const order = stored ? kept(stored.value) : null;
    if (!stored || !order || order.state !== "waiting") continue;
    // Oldest first, so the first order still inside its wait ends the run.
    if (!(Date.parse(order.shippedAt) <= cutoff)) break;
    if (Date.parse(order.shippedAt) < cutoff - LATE_DAYS * DAY_MS) {
      // Its turn passed long ago; a request now would arrive months after the order.
      await shipped(ctx).compareAndSet(id, stored.revision, { ...order, state: "missed" });
      continue;
    }
    const secret = newSecret(), tries = (order.tries ?? 0) + 1;
    const asked: ShippedOrder = { ...order, state: "asked", askedAt: new Date(now).toISOString(), key: await keyOf(secret), tries };
    if (!(await shipped(ctx).compareAndSet(id, stored.revision, asked)).applied) continue;
    try {
      await email.send(requestEmail(ctx, id, order, secret));
      sent++;
    } catch {
      failed++;
      // The reason may hold the buyer's address, so it is not logged.
      ctx.log.warn("A review request could not be handed to the store's email sender", { tries });
      const { askedAt: _at, key: _key, ...rest } = asked;
      const again = await shipped(ctx).getVersioned(id);
      if (again) await shipped(ctx).compareAndSet(id, again.revision, { ...rest, state: tries >= TRIES_MAX ? "failed" : "waiting" });
    }
  }
  return { sent, failed };
}

export interface RequestState { on: boolean; days: number; noSender: boolean; noAddress: boolean; waiting: number; asked: number; failed: number }

/** What the owner's page says about review requests. */
export async function requestState(ctx: PluginContext): Promise<RequestState> {
  const [on, days, noSender, noAddress, waiting, asked, failed] = await Promise.all([
    requestsOn(ctx), requestDays(ctx), ctx.kv.get<unknown>(NO_SENDER), ctx.kv.get<unknown>(NO_ADDRESS),
    shipped(ctx).count({ state: "waiting" }), shipped(ctx).count({ state: "asked" }), shipped(ctx).count({ state: "failed" }),
  ]);
  return { on, days, noSender: noSender === true, noAddress: noAddress === true, waiting, asked, failed };
}

/**
 * Makes sure the hourly run is on the site's scheduler. Switching the plugin on always writes it;
 * opening the Reviews page writes it only when it is missing, which covers a store that updated
 * from a version without requests. Never throws: a page must still open if the scheduler is down.
 */
export async function ensureRequestsTask(ctx: PluginContext, activate = false): Promise<void> {
  const cron = ctx.cron;
  if (!cron) return;
  try {
    if (!activate && (await cron.list()).some(task => task.name === REQUESTS_TASK && task.schedule === REQUESTS_SCHEDULE)) return;
    await cron.schedule(REQUESTS_TASK, { schedule: REQUESTS_SCHEDULE });
  } catch {
    ctx.log.warn("The hourly review request run is not scheduled yet; opening Reviews tries again");
  }
}
