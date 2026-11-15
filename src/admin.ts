import type { BlockResponse } from "@emdash-cms/blocks/server";
import type { SandboxedRouteContext } from "emdash/plugin";

/** EmDash's Editor role; Administrators are above it. Lower roles never see Reviews. */
const EDITOR = 40;

/**
 * The Reviews page in the store admin. The scaffold collects nothing, so the page says so
 * plainly instead of showing an empty list that looks broken.
 */
export async function reviewsAdmin(route: SandboxedRouteContext): Promise<BlockResponse> {
  const user = route.user;
  if (route.ui?.surface !== "admin-page" || typeof user?.role !== "number" || user.role < EDITOR) {
    return { blocks: [{ type: "banner", variant: "error", title: "Reviews is for Editors and Administrators", description: "Ask an Administrator of this site to manage reviews." }] };
  }
  return {
    blocks: [
      { type: "header", text: "Reviews" },
      { type: "banner", variant: "default", title: "No reviews yet", description: "This version of DinkusKit Reviews does not collect reviews. Nothing is sent to your buyers." },
    ],
  };
}
