import type { PluginContext } from "emdash/plugin";
import type { ShippedOrder } from "./inbox.js";
import { readReview } from "./reviews.js";

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
/**
 * The reminder (reviews-request-reminder-20261122): one, this many days after the request email, to a
 * buyer who has not reviewed every product of the order. The owner can turn it off or set 1 to 10 days.
 */
export const REMIND_DAYS_DEFAULT = 7;
export const REMIND_DAYS_MAX = 10;
/** A link in a request or reminder email works this long after that email went out. */
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
const REMIND_ON = "state:reminders-on";
const REMIND_DAYS = "state:reminder-days";
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

/** The reminder is on unless the owner turned it off. */
export async function remindersOn(ctx: PluginContext): Promise<boolean> {
  return (await ctx.kv.get<unknown>(REMIND_ON)) !== false;
}

/** Days between the request email and its reminder. */
export async function reminderDays(ctx: PluginContext): Promise<number> {
  const days = await ctx.kv.get<unknown>(REMIND_DAYS);
  return typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= REMIND_DAYS_MAX ? days : REMIND_DAYS_DEFAULT;
}

export async function saveRequestSettings(ctx: PluginContext, on: boolean, days: number, remind: boolean, remindDays: number): Promise<void> {
  await ctx.kv.set(ON, on);
  await ctx.kv.set(DAYS, days);
  await ctx.kv.set(REMIND_ON, remind);
  await ctx.kv.set(REMIND_DAYS, remindDays);
}

const STATES = new Set(["waiting", "asked", "failed", "missed", "reminded", "settled"]);
/** The states of an order whose request email went out. */
const ASKED = new Set(["asked", "reminded", "settled"]);

/** A shipped order as kept, in any of its states; null for a row that is not one. */
export function kept(value: unknown): ShippedOrder | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Partial<ShippedOrder>;
  if (typeof row.orderId !== "string" || typeof row.email !== "string" || typeof row.name !== "string" || typeof row.shippedAt !== "string") return null;
  if (!Array.isArray(row.lines) || !STATES.has(row.state as string)) return null;
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

/** Both are SHA-256 hex of the same length; every character is compared whatever the first difference. */
function same(given: string, key: string): boolean {
  let different = given.length ^ key.length;
  for (let index = 0; index < given.length; index++) different |= given.charCodeAt(index) ^ key.charCodeAt(index);
  return different === 0;
}

/**
 * Whether a link's secret opens this order: asked, and the secret is the request email's or the
 * reminder's, inside that email's own lifetime.
 */
export async function opens(order: ShippedOrder, secret: string, now: number): Promise<boolean> {
  if (!ASKED.has(order.state) || !/^[0-9a-f]{64}$/.test(secret)) return false;
  const given = await keyOf(secret);
  const live = (key?: string, sentAt?: string) => Boolean(key && sentAt) && now - Date.parse(sentAt!) <= LINK_DAYS * DAY_MS && same(given, key!);
  // Both are checked every time, so the answer takes as long for either email's link.
  const request = live(order.key, order.askedAt), reminder = live(order.remindKey, order.remindedAt);
  return request || reminder;
}

/**
 * The id of the one review a product can get from an order (reviews-review-content-20261122). It is
 * a hash because shoppers see a review's id, and they must not see the order's.
 */
export async function reviewIdOf(orderId: string, productId: string): Promise<string> {
  return (await keyOf(JSON.stringify([orderId, productId]))).slice(0, 32);
}

const escape = (text: string) => text.replace(/[&<>"']/g, mark => `&#${mark.charCodeAt(0)};`);
/** "Sam" from "Sam Taylor"; the greeting uses the first name only. */
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

/** The address of the store's review page for one product of one shipped order. */
export function reviewLink(ctx: PluginContext, id: string, productId: string, secret: string): string {
  return ctx.url(`${REVIEW_PAGE}?o=${encodeURIComponent(id)}&p=${encodeURIComponent(productId)}&k=${secret}`);
}

type Line = ShippedOrder["lines"][number];

function email(ctx: PluginContext, id: string, order: ShippedOrder, lines: Line[], secret: string, words: { subject: string; ask: string; foot: string }) {
  const hello = firstName(order.name) ? `Hi ${firstName(order.name)},` : "Hi,";
  const links = lines.map(line => ({ name: line.productName || "Your item", link: reviewLink(ctx, id, line.productId, secret) }));
  const text = [hello, "", words.ask, "", ...links.flatMap(line => [`${line.name}`, `Write a review: ${line.link}`, ""]), words.foot].join("\n");
  const html = `<p>${escape(hello)}</p><p>${escape(words.ask)}</p>${links.map(line =>
    `<p><strong>${escape(line.name)}</strong><br><a href="${escape(line.link)}">Write a review</a></p>`).join("")}<p style="color:#666;font-size:13px">${escape(words.foot)}</p>`;
  return { to: order.email, subject: words.subject, text, html };
}

/** The request email: every product in the order with its own link, in plain words and in HTML. */
export function requestEmail(ctx: PluginContext, id: string, order: ShippedOrder, secret: string) {
  const store = ctx.site.name || "our store";
  return email(ctx, id, order, order.lines, secret, {
    subject: `How was your order from ${store}?`,
    ask: `Thank you for your order from ${store}. How was it? A review takes a minute and helps other shoppers.`,
    foot: `Each link works once and for ${LINK_DAYS} days. You are getting this email because you bought from ${store}.`,
  });
}

/** The reminder: the same email for the products the buyer has not reviewed yet, and it says it is the last. */
export function reminderEmail(ctx: PluginContext, id: string, order: ShippedOrder, lines: Line[], secret: string) {
  const store = ctx.site.name || "our store";
  return email(ctx, id, order, lines, secret, {
    subject: `A reminder: how was your order from ${store}?`,
    ask: `A while ago we asked how your order from ${store} was. If you have a minute, a review helps other shoppers.`,
    foot: `Each link works once and for ${LINK_DAYS} days. This is the only reminder. You are getting it because you bought from ${store}.`,
  });
}

export interface RunResult { sent: number; failed: number; reminded: number; reason?: "off" | "no-sender" | "no-address" }

/**
 * One hourly run: sends the request for each shipped order whose wait is over, oldest first.
 * An order is marked as asked before its email is handed over, by a write that only lands while it
 * still waits, so two runs at once never email one buyer twice. If the handover fails the order
 * waits again, and after three failures it is given up on. What is left of the hour's emails goes
 * to reminders.
 */
export async function sendDue(ctx: PluginContext, now = Date.now()): Promise<RunResult> {
  if (!(await requestsOn(ctx))) return { sent: 0, failed: 0, reminded: 0, reason: "off" };
  const sender = ctx.email;
  // No email sender in the store: nothing is sent and nothing is lost; the owner's page says so.
  await ctx.kv.set(NO_SENDER, !sender);
  if (!sender) return { sent: 0, failed: 0, reminded: 0, reason: "no-sender" };
  // The links in the email must be whole web addresses; a site that does not know its own address would send dead links.
  const addressed = /^https?:\/\/[^/]/.test(ctx.url("/"));
  await ctx.kv.set(NO_ADDRESS, !addressed);
  if (!addressed) return { sent: 0, failed: 0, reminded: 0, reason: "no-address" };
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
      await sender.send(requestEmail(ctx, id, order, secret));
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
  const reminders = await remindDue(ctx, sender, now, RUN_MAX - sent - failed);
  return { sent, failed: failed + reminders.failed, reminded: reminders.sent };
}

/**
 * The reminder half of the hourly run: for each order asked long enough ago, oldest first, one
 * reminder listing the products the buyer has not reviewed. An order is marked as reminded before
 * its email is handed over, as a request is, so two runs at once never remind one buyer twice.
 */
async function remindDue(ctx: PluginContext, sender: NonNullable<PluginContext["email"]>, now: number, room: number): Promise<{ sent: number; failed: number }> {
  let sent = 0, failed = 0;
  if (room <= 0 || !(await remindersOn(ctx))) return { sent, failed };
  const cutoff = now - (await reminderDays(ctx)) * DAY_MS;
  const page = await shipped(ctx).query({ where: { state: "asked" }, orderBy: { askedAt: "asc" }, limit: room });
  for (const { id } of page.items) {
    const stored = await shipped(ctx).getVersioned(id);
    const order = stored ? kept(stored.value) : null;
    if (!stored || !order || order.state !== "asked" || !order.askedAt) continue;
    if (!(Date.parse(order.askedAt) <= cutoff)) break;
    const late = Date.parse(order.askedAt) < cutoff - LATE_DAYS * DAY_MS;
    const open: Line[] = [];
    if (!late) for (const line of order.lines) if (!(await readReview(ctx, await reviewIdOf(order.orderId, line.productId)))) open.push(line);
    if (open.length === 0) {
      // Everything is reviewed, or the reminder's turn passed long ago: nothing more is sent for this order.
      await shipped(ctx).compareAndSet(id, stored.revision, { ...order, state: "settled" });
      continue;
    }
    const secret = newSecret(), remindTries = (order.remindTries ?? 0) + 1;
    const reminded: ShippedOrder = { ...order, state: "reminded", remindedAt: new Date(now).toISOString(), remindKey: await keyOf(secret), remindTries };
    if (!(await shipped(ctx).compareAndSet(id, stored.revision, reminded)).applied) continue;
    try {
      await sender.send(reminderEmail(ctx, id, order, open, secret));
      sent++;
    } catch {
      failed++;
      ctx.log.warn("A review reminder could not be handed to the store's email sender", { tries: remindTries });
      const { remindedAt: _at, remindKey: _key, ...rest } = reminded;
      const again = await shipped(ctx).getVersioned(id);
      if (again) await shipped(ctx).compareAndSet(id, again.revision, { ...rest, state: remindTries >= TRIES_MAX ? "settled" : "asked" });
    }
  }
  return { sent, failed };
}

export interface RequestState { on: boolean; days: number; remind: boolean; remindDays: number; noSender: boolean; noAddress: boolean; waiting: number; asked: number; reminded: number; failed: number }

/** What the owner's page says about review requests. */
export async function requestState(ctx: PluginContext): Promise<RequestState> {
  const [on, days, remind, remindDays, noSender, noAddress, waiting, asked, reminded, settled, failed] = await Promise.all([
    requestsOn(ctx), requestDays(ctx), remindersOn(ctx), reminderDays(ctx), ctx.kv.get<unknown>(NO_SENDER), ctx.kv.get<unknown>(NO_ADDRESS),
    shipped(ctx).count({ state: "waiting" }), shipped(ctx).count({ state: "asked" }), shipped(ctx).count({ state: "reminded" }),
    shipped(ctx).count({ state: "settled" }), shipped(ctx).count({ state: "failed" }),
  ]);
  // Every buyer whose request went out was asked, whatever happened with the reminder.
  return { on, days, remind, remindDays, noSender: noSender === true, noAddress: noAddress === true, waiting, asked: asked + reminded + settled, reminded, failed };
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
