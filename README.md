# DinkusKit Reviews

Star ratings and reviews from buyers, for [DinkusKit Commerce](https://github.com/dinkuskit/commerce) stores on [EmDash](https://emdashcms.com).

## Status

Version 0.1.0 is set up to publish to the EmDash Registry as `dinkus-reviews`; the owner approved publishing on 2026-11-23. It needs two pieces from outside this repository: Commerce's courier news (`order.shipped`), which first ships in a Commerce 0.9.0 release, and the DinkusKit store template's courier timer, `/review` page and product-page ratings. Until a store has both, it collects no reviews.

What exists:

- An EmDash Registry plugin, `dinkus-reviews`, that keeps review records and each product's rating in the store's own database (plugin storage `reviews` and `ratings`). It asks for one capability, `email:send`, to hand the review request to the store's own email sender, and for no network host.
- One admin page, **Reviews**, for Editors and Administrators: every review newest first, filters by status, and for each review publish, hide, mark as spam and one public reply. One setting holds every new review until the owner approves it; it starts off. Two more turn review requests on or off (on from install) and set the days to wait after an order ships (14, from 1 to 90). Two more turn the one reminder on or off (on from install) and set the days to wait before it (7, from 1 to 10). Nothing on the page can write a review or change a buyer's stars, words, name or date.
- Two public, read-only routes for the storefront, the store's catalog feed and agents: `GET rating?product=<id>` (the product's rating, or `null`) and `GET list?product=<id>&cursor=<cursor>` (its published reviews, newest first, 20 a page). They never return the order a review came from or a review that is held, hidden or spam.
- The rating rules in `src/rating.ts`: whole stars from 1 to 5, and a product's average (to one decimal place) and review count in UCP's `rating` shape. A product with no published review has no rating. The rating is worked out again from the published reviews each time one is published, hidden or marked as spam.
- A private courier inbox, `POST courier/inbox`, built to the [courier's doors](https://github.com/dinkuskit/courier/blob/main/docs/doors.md). It asks for `order.shipped` from `dinkus-commerce`, keeps each shipped order once (order id, shipped date, the buyer's email and name, the products bought) in plugin storage `shipped`, and refuses any signed-in caller, the store's Administrator included. The Reviews page says when the courier last came by, or that it is missing.

- The review request (`src/requests.ts`). Once an hour, on the site's own scheduler, each shipped order whose wait is over gets one email through the store's email sender: every product in the order with its own link to the store's `/review` page. An order is marked as asked before its email is handed over, so no buyer is emailed twice. The link carries a secret that is kept only as its SHA-256, and works for 60 days. A store with no email sender, or a site that does not know its own address, sends nothing and loses nothing, and the Reviews page says so. Three failed handovers give a request up; an order whose turn passed more than 30 days ago is not asked.
- The reminder (also `src/requests.ts`). The same hourly run sends one reminder to a buyer whose request email went out 7 days ago and who has not reviewed every product of the order. It lists only the products not reviewed yet, with links that work for 60 days from the reminder; the first email's links keep their own 60 days. A buyer who reviewed everything gets none, and nobody gets a second. Reviews does not track whether an email was opened. Three failed handovers give a reminder up; a reminder whose turn passed more than 30 days ago is not sent. Requests and reminders share the run's 25 emails, requests first.
- The stop link (`src/requests.ts`, `src/write.ts`). Every request and reminder ends with "Stop review emails from <store>", a link to the store's `/review` page with `o`, `k` and `stop=1`. `POST write` with those fields answers `stop` (show the button) or `stopped`, and changes nothing, so a mail filter that opens every link stops nothing. `POST send` with them keeps the stop and answers `stopped`. The stop is one record in the `stops` collection whose id is the SHA-256 of the address in lower case; the address is not kept. The hourly run checks it before each request and each reminder: an order not yet asked becomes `stopped`, and an asked order gets no reminder. The stop link works as long as the order's request is kept, past the 60 days of the review links. The Reviews page shows how many buyers stopped, with no addresses and no way to turn emails back on. The published store template draws the stop page from its next version.
- The plugin's side of the buyer's review page (`src/write.ts`). EmDash does not let a plugin serve a web page, so the store draws `/review` itself and its server calls two public routes, the way the store's order lookup page calls Commerce. `POST write` with `{ o, p, k }` from the link answers what it opens: `{ "ok": true, "state": "open", productId, productName, name, anonymousName, bodyMax, nameMax }`, `{ "ok": true, "state": "done" }` when that product was already reviewed from that order, or `{ "ok": false, "error": { "code": "CLOSED" } }`. `POST send` with `{ o, p, k, stars, body, name }` keeps the review once and answers `{ "ok": true, "result": "sent" | "held" | "done" }` (`held` when approve-first is on), or is refused with `CLOSED`, `STARS`, `LONG`, `NAME` or `CHARS`. Neither route ever answers the order or the buyer's email.

Not in the first version: review photos (see the charter).

What is decided, and what is still open, is in [docs/CHARTER.md](docs/CHARTER.md) and [docs/research/product-ratings.md](docs/research/product-ratings.md).

## Install type

Registry only, sandboxed. The listing copy is in `docs/registry-listing/` and its icon in `assets/listing/`.

## Develop

Node 24 (`.nvmrc`).

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

`npm test` builds the plugin, packages it the way the Registry does (failing if the backend passes 128 KiB), and runs the tests.

## Release

`.github/workflows/release.yml` publishes to the EmDash Registry when a `vX.Y.Z` tag matching `package.json`'s version is pushed (Run workflow on the tag retries). It runs the checks, prepares the bundle with the pinned `emdash-plugin release prepare`, signs its build provenance, publishes with the pinned EmDash release-action (listing icon included), waits up to 30 minutes for the owner's approval at releases.emdashcms.com, and passes only when the Registry record carries exactly the prepared bundle. The service accepts releases only from a public repository. [`docs/proof/registry-release-authority/`](docs/proof/registry-release-authority/) shows how the service binds a release to the approved repository and workflow, and checks that authority again before it writes.

## Pull requests

Every pull request to `main` runs CI and gets a ClawSweeper review. Only the reviewed commit may merge.

## License

MIT
