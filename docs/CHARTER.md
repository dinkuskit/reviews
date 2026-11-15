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

## Not decided

These are open questions for the owner, with recommendations in
[research/product-ratings.md](research/product-ratings.md):

- Who may review: buyers only, or anyone.
- Whether a review is published straight away or waits for approval.
- Whether the same product sold by several stores shows one blended rating in
  the cross-store catalog or each store's own.
- Review photos.

Also not designed: where review records are kept, how Reviews learns about a
shipped order, and how the review request email is sent.

## Out of scope

Store-wide ratings, importing reviews from another platform, questions and
answers, and Google's product ratings programme. None is ruled out for later.
