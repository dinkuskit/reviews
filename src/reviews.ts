import type { PluginContext } from "emdash/plugin";
import { aggregate, stars, type Rating } from "./rating.js";

/**
 * Review records, kept in the store's own database in this plugin's storage
 * (decision reviews-records-in-store-20261122). Nothing here leaves the store.
 */
export const BODY_MAX = 2000;
export const NAME_MAX = 60;
export const REPLY_MAX = 2000;
/** Reviews per page of the public list and of the owner's table. */
export const PAGE = 20;

/**
 * published: shoppers see it and it counts in the rating. pending: held by the approve-first setting.
 * hidden and spam: the owner took it down. Stars never decide a status (reviews-publish-default-20261122).
 */
export type Status = "published" | "pending" | "hidden" | "spam";
export const STATUSES: readonly Status[] = ["published", "pending", "hidden", "spam"];

export interface Review {
  productId: string;
  /** The product's name when the review was written, for the owner's table. */
  productName: string;
  stars: number;
  /** The buyer's words; may be empty, a star rating alone is a review. */
  body: string;
  /** The name shown beside the review, as the buyer chose it. */
  name: string;
  status: Status;
  createdAt: string;
  /** The order the buyer reviewed from; never shown to shoppers. */
  orderId: string;
  /** The owner's one public reply. */
  reply?: { body: string; at: string };
}

interface Collection<T> {
  get(id: string): Promise<T | null>;
  put(id: string, data: T): Promise<void>;
  delete(id: string): Promise<boolean>;
  count(where?: Record<string, unknown>): Promise<number>;
  query(options?: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; limit?: number; cursor?: string }):
    Promise<{ items: { id: string; data: T }[]; cursor?: string; hasMore: boolean }>;
  getVersioned(id: string): Promise<{ value: T; revision: string } | null>;
  compareAndSet(id: string, expectedRevision: string | null, data: T): Promise<{ applied: boolean }>;
}

const reviews = (ctx: PluginContext) => (ctx.storage as unknown as { reviews: Collection<unknown> }).reviews;
const ratings = (ctx: PluginContext) => (ctx.storage as unknown as { ratings: Collection<unknown> }).ratings;

const clean = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value) ? value : null;

/** A stored record as a review, or null for anything that is not one; a bad row is never shown. */
export function review(value: unknown): Review | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const body = clean(row.body, BODY_MAX), name = clean(row.name, NAME_MAX);
  const productId = clean(row.productId, 200), productName = clean(row.productName, 300), orderId = clean(row.orderId, 200);
  const createdAt = typeof row.createdAt === "string" && !Number.isNaN(Date.parse(row.createdAt)) ? row.createdAt : null;
  if (stars(row.stars) === null || body === null || !name || !productId || productName === null || !orderId || !createdAt) return null;
  if (!STATUSES.includes(row.status as Status)) return null;
  const reply = typeof row.reply === "object" && row.reply !== null ? row.reply as Record<string, unknown> : null;
  const replyBody = reply ? clean(reply.body, REPLY_MAX) : null;
  return {
    productId, productName, stars: row.stars as number, body, name, status: row.status as Status, createdAt, orderId,
    ...(replyBody && typeof reply?.at === "string" ? { reply: { body: replyBody, at: reply.at } } : {}),
  };
}

export async function readReview(ctx: PluginContext, id: string): Promise<Review | null> {
  return review(await reviews(ctx).get(id));
}

export interface Listed { id: string; review: Review }

/** Reviews newest first, a page at a time, for one product and/or status. */
export async function listReviews(ctx: PluginContext, where: { productId?: string; status?: Status }, cursor?: string, limit = PAGE):
  Promise<{ items: Listed[]; cursor?: string }> {
  const page = await reviews(ctx).query({ where, orderBy: { createdAt: "desc" }, limit, ...(cursor ? { cursor } : {}) });
  const items: Listed[] = [];
  for (const { id, data } of page.items) {
    const found = review(data);
    if (found) items.push({ id, review: found });
  }
  return { items, ...(page.hasMore && page.cursor ? { cursor: page.cursor } : {}) };
}

export async function countReviews(ctx: PluginContext, status: Status): Promise<number> {
  return reviews(ctx).count({ status });
}

/**
 * The kept answer for one product. `count` 0 means no published review; the record stays so that
 * every refresh is a conditional write on the one before it. `turn` goes up by one each time,
 * so two answers are never the same bytes.
 */
interface Kept { value: number; count: number; turn: number }

function kept(value: unknown): Kept | null {
  if (typeof value !== "object" || value === null) return null;
  const { value: average, count, turn } = value as Record<string, unknown>;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
  if (count > 0 && !(typeof average === "number" && average >= 1 && average <= 5)) return null;
  return { value: count > 0 ? average as number : 0, count, turn: typeof turn === "number" && Number.isInteger(turn) ? turn : 0 };
}

/** A product's rating as last worked out, or null when it has no published review. */
export async function readRating(ctx: PluginContext, productId: string): Promise<Rating | null> {
  const found = kept(await ratings(ctx).get(productId));
  return found && found.count > 0 ? { value: found.value, scale_min: 1, scale_max: 5, count: found.count } : null;
}

/** How often a refresh starts again when another one finished first. Each retry means another refresh landed. */
const REFRESH_TRIES = 8;

/**
 * Works a product's rating out again from every published review of it and keeps the answer,
 * so the storefront reads one small record. Safe to repeat: it always starts from the reviews.
 *
 * Two owners can moderate the same product at once. The kept answer's revision is read before the
 * reviews are, and the write only lands on that revision; a refresh that read the reviews before
 * another one's change loses the write and starts again, so an older answer never replaces a newer one.
 */
export async function refreshRating(ctx: PluginContext, productId: string): Promise<Rating | null> {
  for (let attempt = 0; attempt < REFRESH_TRIES; attempt++) {
    const before = await ratings(ctx).getVersioned(productId);
    const published: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await reviews(ctx).query({ where: { productId, status: "published" }, limit: 100, ...(cursor ? { cursor } : {}) });
      for (const { data } of page.items) {
        const found = review(data);
        if (found) published.push(found.stars);
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    const rating = aggregate(published);
    const next: Kept = { value: rating?.value ?? 0, count: rating?.count ?? 0, turn: (kept(before?.value)?.turn ?? 0) + 1 };
    if ((await ratings(ctx).compareAndSet(productId, before?.revision ?? null, next)).applied) return rating;
  }
  throw new Error("The product's rating could not be brought up to date; try again.");
}

/**
 * Changes one review with a write that only lands if nobody changed it meanwhile, then brings the
 * product's rating up to date. Returns the review as saved, or null when it is gone or just changed.
 */
async function change(ctx: PluginContext, id: string, edit: (current: Review) => Review): Promise<Review | null> {
  const stored = await reviews(ctx).getVersioned(id);
  const current = stored ? review(stored.value) : null;
  if (!stored || !current) return null;
  const next = edit(current);
  if (!(await reviews(ctx).compareAndSet(id, stored.revision, next)).applied) return null;
  if (next.status !== current.status) await refreshRating(ctx, next.productId);
  return next;
}

/**
 * The owner's whole power over a review's visibility: publish it, hide it, or mark it as spam.
 * The stars, the words, the name and the date are copied over untouched; no owner action can change them.
 */
export const setStatus = (ctx: PluginContext, id: string, status: Exclude<Status, "pending">) =>
  change(ctx, id, current => ({ ...current, status }));

/** The owner's one public reply; saving again replaces it, and empty text takes it away. */
export function setReply(ctx: PluginContext, id: string, text: string, now: string): Promise<Review | null> {
  const body = clean(text.trim(), REPLY_MAX);
  if (body === null) return Promise.resolve(null);
  return change(ctx, id, current => {
    const { reply: _old, ...rest } = current;
    return body ? { ...rest, reply: { body, at: now } } : rest;
  });
}

const APPROVE_FIRST = "state:approve-first";

/** Whether every new review waits for the owner's approval. Off unless the owner turned it on. */
export async function approveFirst(ctx: PluginContext): Promise<boolean> {
  return (await ctx.kv.get<unknown>(APPROVE_FIRST)) === true;
}

export async function setApproveFirst(ctx: PluginContext, on: boolean): Promise<void> {
  await ctx.kv.set(APPROVE_FIRST, on);
}
