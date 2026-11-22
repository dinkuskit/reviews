# DinkusKit Reviews

Star ratings and reviews from buyers, for [DinkusKit Commerce](https://github.com/dinkuskit/commerce) stores on [EmDash](https://emdashcms.com).

## Status

First build. The plugin keeps reviews and lets the owner moderate them. It does not ask buyers for reviews yet, so a store has no reviews until that part lands, and nothing is published to the Registry.

What exists:

- An EmDash Registry plugin, `dinkus-reviews`, that keeps review records and each product's rating in the store's own database (plugin storage `reviews` and `ratings`). It asks for no capability and no network host.
- One admin page, **Reviews**, for Editors and Administrators: every review newest first, filters by status, and for each review publish, hide, mark as spam and one public reply. One setting holds every new review until the owner approves it; it starts off. Nothing on the page can write a review or change a buyer's stars, words, name or date.
- Two public, read-only routes for the storefront, the store's catalog feed and agents: `GET rating?product=<id>` (the product's rating, or `null`) and `GET list?product=<id>&cursor=<cursor>` (its published reviews, newest first, 20 a page). They never return the order a review came from or a review that is held, hidden or spam.
- The rating rules in `src/rating.ts`: whole stars from 1 to 5, and a product's average (to one decimal place) and review count in UCP's `rating` shape. A product with no published review has no rating. The rating is worked out again from the published reviews each time one is published, hidden or marked as spam.

Not built yet: hearing that an order shipped, the review request email, the buyer's review page, and the stars on the storefront.

What is decided, and what is still open, is in [docs/CHARTER.md](docs/CHARTER.md) and [docs/research/product-ratings.md](docs/research/product-ratings.md).

## Install type

Registry only. The plugin is built for the EmDash plugin Registry and runs sandboxed. It is not listed in the Registry yet.

## Develop

Node 24 (`.nvmrc`).

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

`npm test` builds the plugin, packages it the way the Registry does (failing if the backend passes 128 KiB), and runs the tests.

## Pull requests

Every pull request to `main` runs CI and gets a ClawSweeper review. Only the reviewed commit may merge.

## License

MIT
