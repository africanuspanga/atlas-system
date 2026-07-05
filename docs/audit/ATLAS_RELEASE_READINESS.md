# ATLAS Release Readiness

_Audit date: 2026-07-05 · Branch: `audit/production-readiness`_

Assessed against the CTO §21 checklist. Two verdicts are tracked separately
because they are genuinely different bars:

- **A. Controlled single-school pilot** (operator-onboarded, real data, close support)
- **B. Self-serve multi-tenant SaaS** (public signup, paid subscriptions, scale)

| # | Requirement | Status | For pilot (A) | For SaaS (B) |
|---|-------------|--------|:---:|:---:|
| 1 | All P0 bugs closed | 0 found | ✅ | ✅ |
| 2 | All P1 bugs closed | AUD-002 fixed; 0 open | ✅ | ✅ |
| 3 | Lint passes | 11/11 turbo tasks green | ✅ | ✅ |
| 4 | Typecheck passes | green | ✅ | ✅ |
| 5 | Production build passes | green | ✅ | ✅ |
| 6 | Unit tests pass | minimal (1 API spec) | 🟡 | 🟡 |
| 7 | Integration tests pass | 7 module smokes green | ✅ | ✅ |
| 8 | RLS / isolation tests pass | `smoke-isolation` green | ✅ | ✅ |
| 9 | E2E workflow tests | via smokes (API-level), no browser E2E | 🟡 | 🟡 |
| 10 | Import tests pass | students only (`smoke-students`) | 🟡 | ❌ staging pipeline unbuilt |
| 11 | Payment tests pass | `smoke-finance` + immutability | ✅ | 🟡 no webhook layer yet |
| 12 | Accounting reconciliation | ledger balanced asserts in smokes + demo | ✅ | ✅ |
| 13 | AI permission tests | ❌ AI unbuilt | N/A | ❌ |
| 14 | PDF/CSV exports | ❌ unbuilt | 🟡 print-only | ❌ |
| 15 | Owner dashboard workflows | ❌ unbuilt | 🟡 operator runs onboarding | ❌ |
| 16 | Mobile responsiveness | shadcn responsive; not device-tested | 🟡 | 🟡 |
| 17 | Staging restore tested | ❌ not performed | ❌ | ❌ |
| 18 | Monitoring & alerts active | ❌ pino logs only, no APM | 🟡 | ❌ |
| 19 | Rollback documented | tag `v0.1.0-pre-audit` + migration notes | 🟡 | 🟡 |
| 20 | Pilot data imported in staging | ❌ | ❌ | ❌ |
| 21 | School approved imported totals | ❌ | ❌ | ❌ |
| 22 | Written sign-off | this document | 🟡 | ❌ |

## Blocking gaps

**For a controlled pilot (A):** the operational core is solid and isolation is
proven, but before real pilot data: (i) perform a **staging restore test**
(§19), (ii) stand up **basic monitoring/alerting** (error rate, failed jobs,
RLS denials), (iii) import the pilot school's data in **staging** and have the
school **approve the totals** (§20–21). No code blocker; these are ops steps.

**For SaaS (B):** additionally requires the **platform/subscription-enforcement
layer**, the **staging-based import pipeline**, **payment webhooks with
idempotency**, the **reporting/export system**, and the **AI assistant with its
eval suite** — all specced in this folder, none built.

## Recommendation

Do **not** call the system production-ready yet. It is **pilot-capable pending
the three ops steps above**. Keep the feature freeze until: staging restore is
proven, monitoring is live, and one real school's imported totals are signed
off. Treat the platform/AI/reporting pillars as the next build epics, each
gated by its spec's test bar.

## Accounting & academic integrity (verified invariants)

Proven by automated tests, satisfying CTO §13–14 for the built scope:
- Every journal balances; total debits = total credits (`smoke-finance`,
  `smoke-isolation`, demo seed all assert this).
- Posted payments and journal entries are **immutable at the DB level**
  (AUD-002; `smoke-isolation` step 7). Corrections are reversals only.
- Payment cannot exceed invoice balance (`PAYMENT_EXCEEDS_BALANCE`); receipt and
  invoice numbers unique per tenant; reversal preserves the original and cannot
  be re-reversed.
- Marks 0–100 enforced; teachers limited to `marks.enter`; published assessments
  locked (`SCORES_ASSESSMENT_PUBLISHED`); grade bands non-overlapping; Division
  from best-7; report-card totals + position asserted in `smoke-assessments`.

**Not yet covered** (needs building/tests): payment **webhook** idempotency
(no provider integration yet), financial-period locking (`finance.periods.lock`
permission exists, no enforcement), credit notes / discounts / refunds beyond
reversal.
