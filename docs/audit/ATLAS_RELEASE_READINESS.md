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
| 10 | Import tests pass | staged pipeline BUILT (mig 0011); `smoke-imports` written, needs mig live | 🟡 | 🟡 |
| 11 | Payment tests pass | `smoke-finance` + immutability | ✅ | 🟡 no webhook layer yet |
| 12 | Accounting reconciliation | ledger balanced asserts + report RPCs now REFUSE on mismatch (mig 0012) | ✅ | ✅ |
| 13 | AI permission tests | ✅ `smoke-ai` green live; `eval-ai` (real provider) **28/28, security categories 100%** | ✅ | 🟡 grow eval set to full CTO §11 size before AI GA |
| 14 | PDF/CSV exports | BUILT (mig 0012); `smoke-reports` written, needs mig live | 🟡 | 🟡 |
| 15 | Owner dashboard workflows | BUILT (mig 0013, /platform + enforcement); `smoke-platform` written, needs mig live | 🟡 | 🟡 |
| 16 | Mobile responsiveness | shadcn responsive; not device-tested | 🟡 | 🟡 |
| 17 | Staging restore tested | ✅ PERFORMED 2026-07-08, all gates passed (ATLAS_RESTORE_RUNBOOK.md) | ✅ | 🟡 repeat quarterly |
| 18 | Monitoring & alerts active | health endpoints + structured logs + heartbeats live; Sentry DSN + uptime checks are ops steps (ATLAS_MONITORING.md) | 🟡 | 🟡 |
| 19 | Rollback documented | tag `v0.1.0-pre-audit` + migration notes | 🟡 | 🟡 |
| 20 | Pilot data imported in staging | ❌ | ❌ | ❌ |
| 21 | School approved imported totals | ❌ | ❌ | ❌ |
| 22 | Written sign-off | this document | 🟡 | ❌ |

## Live verification — 2026-07-08 (operator approved)

Migrations **0011–0014 applied to the Supabase project** and recorded in
migration history (14/14). Full smoke pass on the migrated DB with the new
API build: **all 13 suites green** — the 9 original suites (onboarding,
students, attendance, assessments, finance, communication, parents,
isolation, health) confirm the entitlement-enforcing TenantGuard broke
nothing, and the 4 new suites (imports, reports, platform, ai) verify the
new pillars end-to-end, including: idempotent import re-run, opening-balance
ledger reconciliation, CSV formula-injection escaping, tampered-ledger report
refusal, suspend/reactivate lockout, plan caps, onboarding 429, AI permission
denial without leakage, prompt-injection refusal, and full audit trails.
Two live-only bugs found by the smokes and fixed during the pass
(class_sections `stream`→`name` column in the imports validator and the
outstanding-balances SQL; permission-catalogue FK for the two new permission
keys — migration files corrected for fresh deploys).

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

## Recommendation (updated 2026-07-08)

The system is **pilot-ready from an engineering standpoint**: restore test
performed, monitoring endpoints live, all 13 smoke suites green against the
migrated database, the AI eval starter set at 100%, and every former
greenfield pillar built and live-verified. What remains before a real pilot
school goes live is **operational, not code**: (i) set a Sentry DSN + point
uptime checks at the health endpoints (ATLAS_MONITORING.md), (ii) run the
pilot school's real data through the staging rehearsal and obtain the written
sign-off (ATLAS_PILOT_RUNBOOK.md). Before **self-serve SaaS**: marketing
website + registration flow, payment webhooks with idempotency, the full
230-question AI eval suite, and closure of the P3 backlog (pagination,
backoff, tenant switcher).

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
