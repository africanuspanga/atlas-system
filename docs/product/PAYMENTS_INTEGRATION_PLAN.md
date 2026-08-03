# ATLAS Payments Integration Plan

Status: **external provider integration planned**. Internal payment recording,
idempotency, receipts, reversals, dates, and ledger posting are built and live-
verified; provider contracts/credentials/webhooks/reconciliation are not.
Written 2026-07-10; updated 2026-08-03. Owner: platform.

## Goal

Parents pay school fees from their phone or a bank branch; the payment lands
on the right invoice in ATLAS **without anyone re-typing it**. The bursar's
job becomes reviewing exceptions, not entering receipts.

## Context (why this wins deals)

- Payment reality in Tanzania: M-Pesa (Vodacom), Mixx by Yas, Airtel Money,
  and HaloPesa are common rails; banks such as NMB and CRDB offer school-fee
  collection products. Confirm current product names, APIs, and reference/
  control-number support during procurement.
- Today ATLAS records payments manually (`POST /finance/invoices/:id/payments`,
  immutable + ledger-posted). Requests carry an idempotency key: an exact retry
  returns the original receipt, while a changed retry conflicts. Future and
  pre-invoice dates are rejected. Provider integration should feed this same
  path with a deterministic provider-event idempotency key.

## Architecture

```
Aggregator/Bank webhook ──▶ POST /api/v1/payments/webhooks/:provider
                              │  (signature check, raw payload stored)
                              ▼
                     payment_events (append-only, UNIQUE provider+external_id)
                              │  poller/worker (BullMQ kick + DB poll, --once)
                              ▼
                     matcher: reference → invoice (control number)
                       │ matched: existing record-payment RPC (idempotent)
                       ▼ unmatched: exceptions queue for bursar UI
```

Key decisions (all consistent with iron rules):

1. **Ingestion ≠ posting.** Webhooks only append to `payment_events` and ACK
   fast. A worker (same pattern as outbox/imports: DB poller + BullMQ kick +
   `--once` smoke mode) does matching and posts via the existing
   `record_payment` RPC so ledger/journal/receipt behavior is identical to a
   manual payment.
2. **Idempotency.** `payment_events` has `unique(provider, external_id)` and
   passes a deterministic key into the already-idempotent payment RPC; replayed
   webhooks are no-ops at both layers. The matcher marks events
   `pending → matched|unmatched|posted|failed` with atomic conditional claims.
3. **Control numbers.** Every invoice gets a short human reference
   (e.g. `SARW-INV-00042`, derived from tenant slug prefix + invoice number,
   stored on the invoice, printed on the invoice PDF and in fee-reminder SMS).
   Parents key it into the paybill/bank slip. Matching order:
   control number → phone number of a primary guardian with a single unpaid
   invoice → manual exception.
4. **Never trust amounts.** Overpayment/underpayment rules already exist in
   the RPC (`PAYMENT_EXCEEDS_BALANCE`); partial payments simply post partially.
   Overpaid events go to the exceptions queue (future: credit balance).
5. **Reconciliation report.** Daily per-provider totals (events received vs
   posted vs exceptions) reconciled against the ledger's mobile-money/bank
   accounts; mismatch raises like `REPORT_RECONCILE_FAILED`.

## Candidate provider sequence

These are procurement candidates, not a current commercial recommendation.
Before selecting one, re-verify Tanzania wallet coverage, webhook signatures,
idempotency/status APIs, settlement model, support, uptime, security/privacy,
fees, tax/regulatory position, and current contract terms.

| Phase | Provider                                                                | Why first                                   | Prereqs                                          |
| ----- | ----------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------ |
| 1     | **Selcom or Azampay aggregator** (single API → all four mobile wallets) | one integration, C2B collections, USSD push | merchant KYC, API keys, settlement account       |
| 2     | **NMB / CRDB school collections**                                       | boarding/urban schools bank-heavy           | per-school bank onboarding, bank file/API access |
| 3     | Direct M-Pesa OpenAPI (cost optimisation)                               | cut aggregator fees at volume               | Vodacom merchant contract                        |
| 4     | **USSD self-service** (`*150*XX#`-style balance check + pay prompt)     | non-smartphone parents                      | aggregator USSD short code lease                 |

Also phase 1: **pay-the-SaaS** — the same rails collect ATLAS subscription
fees from schools (control number per tenant subscription).

## Data model (migration sketch, additive)

- `payment_events` — `id`, `provider`, `external_id`, raw payload, MSISDN,
  amount/currency, reference, timestamps/status, matched invoice/payment, error,
  and a tenant id that remains null until safely matched. RLS: platform and
  authorized tenant finance roles read the tenant's own matched events.
- `invoices.control_number` (unique per tenant, backfilled).
- `tenant_settings` keys: enabled providers, settlement account labels.

## API surface

- `POST /api/v1/payments/webhooks/:provider` — unauthenticated but
  signature-verified (per-provider HMAC/cert), IP-allowlisted, rate-limited,
  stores + 200s. NEVER tenant-guarded (tenant resolved by matching).
- `GET /finance/payment-events?status=unmatched` + `POST .../:id/match`
  (bursar, `finance.payments.receive`) — exceptions queue UI.
- Worker: `apps/workers/src/process-payment-events.ts` (+ `--once`).

## Instalments & debtors (built separately — no external dependency)

Instalment schedules and the debtors (wadaiwa) report are built and live
(migration `0017`, hardened in `0031`): `invoice_instalments` with due dates,
historical as-of reporting, debtors-by-class, and reminder integration.
Webhooks would simply move the same balances through the existing payment RPC.

## Security & compliance checklist

- Store raw payloads append-only; never mutate (audit).
- Verify signatures before parse; reject clock-skewed replays.
- Confirm TCRA/provider sender-ID and message requirements; retain written
  approval before sending receipts/reminders.
- Treat MSISDN and raw provider payloads as personal data: minimize fields,
  confirm storage encryption/region/retention contractually, restrict reads to
  authorized finance/platform users, and complete the Tanzania privacy gate.
- Receipts SMS on successful match ("Malipo ya TZS X yamepokelewa, risiti
  RCT-…") through the existing outbox.

## Smoke/eval plan

- `smoke-payment-events.mjs`: post signed fake webhook → event stored →
  worker `--once` → payment posted → ledger balanced → replay is no-op →
  unmatched event lands in exceptions.
- AI: read tool `getUnmatchedPayments`; no AI action may post/match payments.

## Open questions for the founder

1. Which aggregator do we sign first (Selcom vs Azampay pricing)?
2. Settlement: per-school merchant accounts vs an ATLAS collection account and
   payouts. Obtain Tanzanian payments/legal advice before selecting or holding
   school funds; do not infer regulatory status from this technical plan.
3. Who owns provider fees — school or parent surcharge?
