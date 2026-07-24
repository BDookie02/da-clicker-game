# Purchase financial ledger and reconciliation

The Android purchase path uses three independent Google records:

1. `purchases.products.get` verifies purchase state, product, quantity, order
   ID, and the account-binding token.
2. `orders.get` supplies the matching line item's actual paid `Money`
   (`currencyCode`, whole `units`, and `nanos`) and current financial state.
3. `purchases.voidedpurchases.list` supplies revocations, refunds, and
   chargebacks that require entitlement action.

Catalog labels and client-formatted prices are never financial evidence.

## Database deployment

Apply `server/migrations/0005_purchase_financials_and_reversals.sql` after
`0004_report_evidence.sql`. The migration adds:

- `purchase_financials`: exact Money, purchase type, region, state, and
  revocation status beside the immutable entitlement ledger;
- `purchase_reversals`: deterministic, idempotent reversal events;
- `purchase_reconciliation_state`: durable void-list window and pagination
  state.

Do not enable paid production verification against a database missing this
migration.

## Google service-account access

`GOOGLE_SERVICE_ACCOUNT_JSON` remains server-only. The service account must
have Android Publisher API access for purchase/order verification and the Play
Console permission required to view financial information for the Voided
Purchases API. Never ship this JSON in the app, a web bundle, Git, screenshots,
or Play Console listing text.

Standard paid purchases fail closed when an exact matching Orders response is
unavailable. License-test (`purchaseType=0`), promo (`1`), and rewarded (`2`)
transactions remain usable for entitlement testing but are labeled and
excluded from real-money totals.

## Scheduled reconciliation

`server/worker.js` exports a Cloudflare `scheduled` handler. A production Cron
Trigger must be attached to the deployed Worker; source code alone does not
activate it. Each invocation:

- reads voided one-time products using a durable 30-day window, six-hour
  overlap, and continuation token;
- hashes each external void signal into an idempotency key before recording it;
- marks the purchase revoked and immediately removes its M grant from the
  authoritative economy calculation;
- refreshes up to 100 oldest Android order states, catching `PENDING_REFUND`,
  `PARTIALLY_REFUNDED`, `REFUNDED`, and `CANCELED` orders even when a refund was
  not returned as a revocation.

Any void or partial refund conservatively revokes the full M grant. Existing
cosmetics remain visible, but the account has zero spendable M and cannot buy
another premium item until later verified earnings cover that premium debt.

## API result

Authenticated `GET /v1/purchases` returns:

- the transaction ledger with delivery, financial, test/promo, and revocation
  statuses;
- `purchasedMentality`, excluding reversed transactions;
- `spendTotals`, grouped by ISO 4217 currency and represented as exact
  `units` plus `nanos`. Only standard, processed, non-revoked Google orders are
  included.

Never add unlike currencies together or treat test/promo transactions as
money spent.

## Platform scope

The schema and response shape are platform-extensible, but automated financial
and refund reconciliation is Android-only in this release. Existing iOS
purchase verification does not yet capture StoreKit price/currency or reconcile
revocations on a schedule. Do not claim iOS financial totals or refund
reconciliation are complete.

Official references:

- [Orders resource](https://developers.google.com/android-publisher/api-ref/rest/v3/orders)
- [Orders get](https://developers.google.com/android-publisher/api-ref/rest/v3/orders/get)
- [ProductPurchase fields](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products)
- [Voided purchases list](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.voidedpurchases/list)
- [Voided Purchases API guide](https://developers.google.com/android-publisher/voided-purchases)
