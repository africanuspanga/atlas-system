# ATLAS release readiness

_Updated 3 August 2026 · current through migration `0033`._

## Decision

- **Controlled one-school pilot:** technically ready after production
  deployment and the blocking operational/compliance checklist below.
- **Open paid/self-service onboarding:** no-go today.

The detailed evidence and owner rationale are in
[`GO_LIVE_READINESS_2026-08-03.md`](GO_LIVE_READINESS_2026-08-03.md).

## Engineering gate

| Requirement                                    | Current evidence                                                 | Status |
| ---------------------------------------------- | ---------------------------------------------------------------- | :----: |
| Live database migration                        | `0001`–`0033`                                                    |   ✅   |
| Full schema shadow                             | 71 tables, 60 policies, 217 functions                            |   ✅   |
| Existing-data upgrade rehearsal                | 75 tenants / 422 students / 356 payments upgraded through `0033` |   ✅   |
| High-risk SQL regression                       | transaction passed and rolled back                               |   ✅   |
| Lint / typecheck / unit tests                  | 3/3 · 7/7 · 4/4                                                  |   ✅   |
| API/workers/web production build               | 3/3                                                              |   ✅   |
| Dependency audit                               | no known moderate-or-higher issue                                |   ✅   |
| Product/API smokes                             | 25/25                                                            |   ✅   |
| Tenant/RLS attacks                             | parent, pure teacher, finance, platform escalation passed        |   ✅   |
| Real-provider AI                               | 40/40; security categories 100%                                  |   ✅   |
| Browser/device/assistive-tech field acceptance | pilot execution required                                         |   ⬜   |

The unit layer is small and browser E2E is not comprehensive; smoke and manual
pilot acceptance remain mandatory.

## Blocking operational gate

- [ ] Deploy one synchronized web/API/queue-worker/outbox-drainer release.
- [ ] Set HTTPS public URLs, `NODE_ENV=production`, `WEB_ORIGIN`, exact
      `TRUST_PROXY`, Supabase server keys, and TLS Redis.
- [ ] Set strong `HEALTH_TOKEN`, Sentry, uptime/log alerts, and test paging.
- [ ] Fill the incident-response contacts and pass both required tabletop drills.
- [ ] Configure `SMS_DRIVER=beem`, approved sender ID/credentials, and verify
      delivery on real Tanzanian networks.
- [ ] Verify current-schema backup/PITR and complete a full restore drill.
- [ ] Complete PDPC registration/role analysis, school DPA/privacy notices,
      retention/breach process, and cross-border AI approval using
      `TANZANIA_PRIVACY_CHECKLIST.md`.
- [ ] Obtain Tanzanian accountant approval of the pilot school's statutory
      payroll settings and mark only those reviewed settings verified.
- [ ] Configure EAS production values and physical-device tests if mobile ships
      with the pilot.
- [ ] Import/reconcile the pilot school's data and collect head-teacher/bursar
      signatures.

## Controlled rollout gate

1. Put the school in `training`, not `live`.
2. Walk owner, accountant/bursar/cashier, teacher/class-teacher, and parent
   journeys with real school representatives.
3. Reconcile one invoice/payment/reversal, one report, and one payroll period.
4. Verify real SMS and monitor workers/outbox/Sentry for one school week.
5. Review finance totals, AI usage/latency, support incidents, and permissions.
6. Promote only that tenant to `live`; add the next small cohort afterward.

## Known residual risks

- AI passed the current set but averages 17.5 seconds and consumes meaningful
  tokens; model/prompt changes require reevaluation.
- SMS is at-least-once across the external-provider/DB acknowledgement gap and
  can duplicate in a narrow provider-success/database-failure window.
- Payment gateway webhooks and automatic reconciliation are not built; school
  and SaaS payments are still recorded manually with idempotent app requests.
- Unit/browser/device/load coverage needs continued expansion.

Do not mark a release “live” solely because this repository is green; all
unchecked operational items require named owners and evidence.
