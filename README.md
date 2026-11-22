# DinkusKit Reviews

Star ratings and reviews from buyers, for [DinkusKit Commerce](https://github.com/dinkuskit/commerce) stores on [EmDash](https://emdashcms.com).

## Status

Scaffold. Nothing here collects a review yet and nothing is published.

What exists:

- An EmDash Registry plugin, `dinkus-reviews`, with one admin page, **Reviews**, that says no reviews are collected. It asks for no capability, no network host and no public route.
- The rating rules in `src/rating.ts`: whole stars from 1 to 5, and a product's average (to one decimal place) and review count in UCP's `rating` shape. A product with no reviews has no rating.

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
