# Charter

DinkusKit Reviews lets a store's buyers rate and review what they bought, and
gives every product two numbers the rest of the store can use: an average
rating and a review count.

## Decided

- **Its own plugin, separate from Commerce** (owner, 15 Nov 2026). An owner
  gets reviews from DinkusKit without choosing a third-party app, and Commerce
  stays small.
- **The rating a product carries is an average and a count**, in the shape UCP
  uses for `rating`. This is what Shopify, WooCommerce and BigCommerce all
  expose.

- **Only buyers review** (owner, 22 Nov 2026). A buyer reviews through a
  one-time link in the email sent after their order ships. The link proves the
  purchase, so no account is needed. There is no open "write a review" form in
  the first version; if one is ever added, a review from it stays hidden until
  the reviewer confirms by email.
- **A review is published straight away, whatever its stars** (owner, 22 Nov
  2026). The owner can hide spam and abuse afterwards and reply. A store
  setting switches to approve-first, and then every review waits. Stars never
  decide what is held back.
- **Each store keeps its own rating in the cross-store catalog** (owner, 22 Nov
  2026). The rating rides on that store's offer and is never blended with
  another store's. Sharing reviews between stores owned by one business is
  left for later.
- **No photos in the first version** (owner, 22 Nov 2026). Stars with optional
  words first. Photos, and any reward for adding one, come later on the
  owner's word.
- **Reviews are kept in the store** (owner, 22 Nov 2026): in the store's own
  EmDash database, in this plugin's storage. Nothing about a review or its
  buyer is kept on a DinkusKit server.
- **The buyer is asked 14 days after the order ships** (owner, 22 Nov 2026).
  The owner can change the number of days.

- **Reviews hears about a shipped order through the store** (owner, 22 Nov
  2026). EmDash plugins cannot call each other, so the store's own server code
  carries the news from Commerce about once a minute, and buyer details stay in
  the store. That carrying part is not built yet.

- **What a review holds** (owner, 22 Nov 2026). Whole stars from 1 to 5 are
  required. Words are optional, up to 2,000 characters, with no title. The
  name shown is the buyer's first name and last initial from the order; the
  buyer can change it or choose "Verified buyer". One review per product per
  order, and the buyer cannot edit it afterwards in the first version.
- **The rating and published reviews can be read without signing in** (owner,
  22 Nov 2026), through two read-only routes that return only what a shopper
  sees on the product page: never the order, the buyer's email, or a held,
  hidden or spam review.

## Built

Review records and each product's rating in the store, the owner's Reviews
page (publish, hide, mark as spam, one public reply, and the approve-first
setting), and two public read-only routes for the rating and the published
reviews.

## Not decided

Not designed yet, and it needs the owner's answer before it is built: how the
review request email is sent.

## Out of scope

Store-wide ratings, importing reviews from another platform, questions and
answers, and Google's product ratings programme. None is ruled out for later.
