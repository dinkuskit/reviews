import type { SandboxedPlugin } from "emdash/plugin";
import { reviewsAdmin } from "./admin.js";

/**
 * DinkusKit Reviews for the EmDash store admin: star ratings and reviews from buyers.
 * This is the scaffold. It has one admin page and keeps no data.
 */
const plugin: SandboxedPlugin = {
  routes: {
    // Editors and Administrators; lower roles do not see Reviews.
    admin: { public: false, permission: "content:edit_any", methods: ["POST"], handler: route => reviewsAdmin(route) },
  },
};

export default plugin;
