import { pluginResponse, type PluginContext, type SandboxedPlugin, type SandboxedRouteContext } from "emdash/plugin";
import { reviewsAdmin } from "./admin.js";
import { PublicInputError, publicRating, publicReviews } from "./public.js";

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
 * It does not collect reviews or email buyers yet.
 */
const plugin: SandboxedPlugin = {
  routes: {
    // Editors and Administrators; lower roles do not see Reviews.
    admin: { public: false, permission: "content:edit_any", methods: ["POST"], handler: reviewsAdmin },
    // What any shopper sees on a product page (reviews-public-read-20261122). Read only.
    rating: { public: true, methods: ["GET"], response: "raw", request: { body: "none" }, handler: read(publicRating) },
    list: { public: true, methods: ["GET"], response: "raw", request: { body: "none" }, handler: read(publicReviews) },
  },
};

export default plugin;
