# Agent Contract

This public repository owns DinkusKit Reviews: star ratings and reviews from
buyers, for DinkusKit Commerce stores on EmDash. Keep it generic: site copy,
customer data, branding, credentials, and production configuration do not
belong here. Assume every committed byte is public.

## Direction and research

Read the organization [vision](https://github.com/dinkuskit/.github/blob/main/VISION.md)
and [scope and planning](https://github.com/dinkuskit/.github/blob/main/ROADMAP.md)
with [docs/CHARTER.md](docs/CHARTER.md). They describe direction; they do not
establish implemented capabilities.

[docs/research/product-ratings.md](docs/research/product-ratings.md) compares
Shopify, WooCommerce and BigCommerce and records the owner's answers. It
is research. A recommendation there is not a decision until the owner answers
it and it is recorded in the GrillTrack ledger.

Use the installed `emdash-commerce` skill for material product or architecture
questions. Research alone does not authorize implementation.

## Running GrillTrack

Run `./scripts/agent-skills` first; it installs the pinned SaariusSkills
skills into ignored `.cursor/skills/`. Use
`./scripts/grilltrack --project . validate` or `show` for ledger reads. Only
the CLI changes `.grilltrack/`; never edit it by hand.

In Claude Code cloud sessions `.claude/hooks/session-start.sh` checks Node
against `.nvmrc` and runs `npm ci`, then reports anything missing; read that
report before running project scripts.

## Boundary

- This repository owns review records, how reviews are collected and
  moderated, and each product's rating: the average and the number of reviews.
- DinkusKit Commerce remains the sole owner of products, prices, checkout,
  orders and money. Reviews never writes any of them. Reviews hears about a
  shipped order through the store's courier, at its private `courier/inbox`
  route (`src/inbox.ts`), which refuses every signed-in caller;
  do not read Commerce's data directly or assume cross-plugin access.
- The buyer's email goes to the store's own email sender (`ctx.email`) and
  nowhere else. EmDash does not let a plugin serve a web page, so the buyer's
  review page is the store's `/review` page; this plugin only answers it
  (`write`) and takes its form (`send`). Neither may answer the order or the
  buyer's email, and a review's id must not give the order away.
- The storefront, the store's catalog feed and the cross-store agent catalog
  read the rating. They do not need to know how reviews were collected.
- An owner can hide spam and abuse and reply to a review. Nothing here may let
  an owner write a review, change a buyer's stars or words, or reward only
  good reviews (see "Rules that shape the design" in the research).
- Admin screens are Block Kit only. No React admin.
- The plugin is Registry-enabled and sandboxed with no native escape. It asks
  for a capability, a network host or a public route only when a recorded
  decision needs one; `scripts/check-registry-bundle.mjs` fails the build
  otherwise.

## Bootstrap state

This is the first build. `src/reviews.ts` keeps review records and each
product's rating in plugin storage (`reviews`, `ratings`); `src/admin.ts` and
`src/pages.ts` are the owner's Reviews page; `src/public.ts` is the two public
read-only routes, `rating` and `list`; `src/inbox.ts` is the courier inbox
that keeps shipped orders in `shipped`; `src/rating.ts` holds the rating rules;
`src/requests.ts` is the hourly review request email; `src/write.ts` is what
the store's `/review` page reads and where its form posts. No store collects
reviews yet: the courier and the store template's `/review` page are not
released, and the plugin is not published. There is no release workflow or changeset setup
yet; each arrives in its own pull request.

A public route returns only what a shopper sees on the product page. Never
return the order id, a buyer's contact details, or a review that is not
published. A buyer's email is kept only in `shipped`, never shown on the
Reviews page, and never leaves the store.

`.github/workflows/clawsweeper-dispatch.yml` sends non-draft pull requests to
`main` for a ClawSweeper review, as in the other DinkusKit repositories. It
does nothing until the repository variable `CLAWSWEEPER_SPARK_ENABLED` is
`true` and the review runner has enrolled this repository.

Run `npm ci --ignore-scripts`, `npm run typecheck` and `npm test` before
pushing. `npm test` builds the plugin, runs the official Registry packaging
with its 128 KiB per-file limit, then runs the tests.

## Gates

Do not publish to npm, list in the EmDash Registry, deploy, merge, or change a
live store without the owner's explicit approval.
