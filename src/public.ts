import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import { listReviews, readRating } from "./reviews.js";
import type { Rating } from "./rating.js";

/**
 * What the storefront, the store's catalog feed and any agent may read: each product's rating and
 * its published reviews. Only what a shopper sees on the product page is here. The order a review
 * came from, held, hidden and spam reviews, and anything about the buyer beyond the name they chose
 * are never returned.
 */
export interface PublicReview {
  id: string;
  stars: number;
  body: string;
  name: string;
  createdAt: string;
  /** Every review comes from a buyer of the product (reviews-who-may-review-20261122). */
  verifiedBuyer: true;
  reply?: { body: string; at: string };
}

export class PublicInputError extends Error {}

function query(url: string, name: string, max: number): string | undefined {
  let value: string | null;
  try {
    value = new URL(url, "https://store.invalid").searchParams.get(name);
  } catch {
    throw new PublicInputError("Invalid address");
  }
  if (value === null || value === "") return undefined;
  if (value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new PublicInputError(`Invalid ${name}`);
  return value;
}

function product(url: string): string {
  const id = query(url, "product", 200);
  if (!id) throw new PublicInputError("Say which product: ?product=<catalog item id>");
  return id;
}

/** `GET rating?product=<id>`: the product's rating in UCP's shape, or null when it has no published review. */
export async function publicRating(route: SandboxedRouteContext, ctx: PluginContext): Promise<{ productId: string; rating: Rating | null }> {
  const productId = product(route.request.url);
  return { productId, rating: await readRating(ctx, productId) };
}

/** `GET list?product=<id>&cursor=<cursor>`: the product's published reviews, newest first, 20 a page. */
export async function publicReviews(route: SandboxedRouteContext, ctx: PluginContext):
  Promise<{ productId: string; rating: Rating | null; reviews: PublicReview[]; cursor?: string }> {
  const productId = product(route.request.url);
  const [page, rating] = await Promise.all([
    listReviews(ctx, { productId, status: "published" }, query(route.request.url, "cursor", 2000)),
    readRating(ctx, productId),
  ]);
  return {
    productId, rating,
    reviews: page.items.map(({ id, review }) => ({
      id, stars: review.stars, body: review.body, name: review.name, createdAt: review.createdAt, verifiedBuyer: true as const,
      ...(review.reply ? { reply: review.reply } : {}),
    })),
    ...(page.cursor ? { cursor: page.cursor } : {}),
  };
}
