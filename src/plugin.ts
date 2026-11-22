import { pluginResponse, type PluginContext, type SandboxedPlugin, type SandboxedRouteContext } from "emdash/plugin";
import { reviewsAdmin } from "./admin.js";
import { courierInbox } from "./inbox.js";
import { PublicInputError, publicRating, publicReviews } from "./public.js";
import { ensureRequestsTask, sendDue, REQUESTS_TASK } from "./requests.js";
import { sendReview, writePage } from "./write.js";

const json = (status: number, body: unknown) => pluginResponse({ status,
  headers: { "Content-Type": "application/json; charset=utf-8", ...(status === 200 ? {} : { "Cache-Control": "no-store" }) },
  body: { kind: "text", value: JSON.stringify(body) } });

/** A public read answered as plain JSON; a bad address is answered 400 in the same shape, never as a server error. */
const read = (answer: (route: SandboxedRouteContext, ctx: PluginContext) => Promise<unknown>) =>
  async (route: SandboxedRouteContext, ctx: PluginContext) => {
    try {
      return json(200, await answer(route, ctx));
    } catch (error) {
      if (!(error instanceof PublicInputError)) throw error;
      return json(400, { error: { code: "INVALID_REQUEST", message: error.message } });
    }
  };

/**
 * DinkusKit Reviews for the EmDash store admin: star ratings and reviews from buyers.
 * It keeps the review records and each product's rating in the store's own database, gives the
 * owner one page to moderate them, and lets the storefront read what is published.
 * Once an order has shipped and the wait is over it asks the buyer by email, through the store's
 * own email sender. The buyer writes the review on the store's /review page, which reads and posts here.
 */
const plugin: SandboxedPlugin = {
  hooks: {
    "plugin:activate": async (_event, ctx) => {
      await ensureRequestsTask(ctx, true);
    },
    // The hourly run hands up to 25 emails to the store's sender, which outlasts EmDash's default 5 seconds.
    cron: { timeout: 25_000, handler: async (event, ctx) => {
      if (event.name === REQUESTS_TASK) await sendDue(ctx);
    } },
  },
  routes: {
    // Editors and Administrators; lower roles do not see Reviews.
    admin: { public: false, permission: "content:edit_any", methods: ["POST"], handler: reviewsAdmin },
    // What any shopper sees on a product page (reviews-public-read-20261122). Read only.
    rating: { public: true, methods: ["GET"], response: "raw", request: { body: "none" }, handler: read(publicRating) },
    // The store's courier only (plugin-communication-rule-20261122): private, and it refuses any signed-in caller.
    "courier/inbox": { public: false, permission: "plugins:manage", methods: ["POST"], handler: courierInbox },
    // What the store's /review page asks and hands over from inside the store's server (reviews-review-page-on-store-20261122).
    // Public, and each needs the secret from the request email.
    write: { public: true, methods: ["POST"], handler: writePage },
    send: { public: true, methods: ["POST"], handler: sendReview },
    list: { public: true, methods: ["GET"], response: "raw", request: { body: "none" }, handler: read(publicReviews) },
  },
};

export default plugin;
