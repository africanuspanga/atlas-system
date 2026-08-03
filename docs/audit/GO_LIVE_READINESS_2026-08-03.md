# ATLAS go-live readiness — 3 August 2026

## Executive decision

**Decision: GO for a controlled, staff-supervised pilot after deployment; NO-GO for open paid-customer onboarding today.**

The repository and live Supabase database have passed the technical release
gates described below. The remaining blockers are production infrastructure,
monitoring/SMS credentials, worker deployment, Tanzania privacy compliance,
and school acceptance of payroll settings. Those items require owner accounts,
contracts, or business decisions and cannot be completed from this repository.

“100% bug-free” cannot be proved for any non-trivial system. This review instead
used migration rehearsals, live-connected end-to-end suites, adversarial tenant
tests, a real-model AI evaluation, dependency scanning, and production builds.

## What was hardened

- **Multi-tenancy and RBAC:** active-tenant selection is explicit in web and API
  requests; tenant switching is supported; guards fail closed; parent reads are
  limited to linked children; teacher, class-teacher, finance, owner, and
  platform roles were attacked with live JWTs; users cannot self-promote to a
  platform role.
- **Owner control centre:** platform operations remain separated from school
  roles. Revenue and headcount metrics now use each non-archived school's latest
  subscription, so archived tests and historical subscriptions cannot inflate
  MRR or operational totals.
- **Onboarding:** school, owner membership, academic structure, and 30-day trial
  are created atomically. Partial schools are rolled back. Rate limiting and
  lifecycle/plan caps are enforced.
- **Finance:** payment requests carry idempotency keys, retries return the same
  receipt, conflicting retries fail, future/pre-invoice dates fail, journal
  dates match the financial event, and debtor/instalment history respects the
  requested cutoff.
- **Payroll:** a payroll run is blocked until the school reviews and verifies
  its statutory settings. Rate shapes and PAYE bands are validated; invalid net
  pay is rejected; changing rates clears verification; employee and employer
  journals are separately balanced. Existing and future schools receive an
  unverified settings row.
- **Tanzania academic rules:** dates use `Africa/Dar_es_Salaam`; A-Level
  aggregation uses the best three principal subjects, excludes General Studies,
  and applies the tested division bands.
- **AI agent:** production cannot start with the mock provider or a missing
  Moonshot key. Tools enforce the user's permission and tenant on the server;
  write tools create proposals that require a separate human confirmation;
  tool output is bounded; clinical AI data was de-identified; payroll tools
  return aggregates rather than salaries.
- **SMS and background work:** outbox rows are claimed atomically, stale claims
  recover, retries are bounded with backoff, plan caps are enforced during
  claiming, Tanzanian phone numbers are validated, provider calls time out, and
  production cannot use the console-only SMS driver.
- **Web/mobile:** pages no longer choose an arbitrary first tenant; network
  failures have visible retry states; the shell has a skip link and semantic
  main region; broad transition animations were removed; mobile auth sessions
  use chunked SecureStore with legacy migration; production mobile builds
  require an HTTPS API URL.
- **Supply chain:** Next.js/shadcn and vulnerable transitive packages were
  upgraded or overridden; the SheetJS-supported package is used. A sequential
  quality workflow now runs on pushes and pull requests.

## Verification evidence

| Gate                                | Result                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| Live Supabase migrations            | `0001` through `0033` applied                                                     |
| Full shadow migration               | 33/33; 71 tables, 60 RLS policies, 217 functions                                  |
| RLS deny-all scan                   | No unintended table found                                                         |
| Restored-live-data rehearsal        | 75 tenants, 422 students, and 356 payments migrated successfully before live push |
| High-risk SQL regression            | Passed and rolled back cleanly                                                    |
| Live-connected product smoke suites | 25/25 passed                                                                      |
| Real Moonshot AI evaluation         | 40/40 passed; security categories 100%                                            |
| AI evaluation performance           | 17,461 ms mean; 388,805 tokens for 40 cases                                       |
| Lint                                | 3/3 workspace tasks passed                                                        |
| Typecheck                           | 7/7 workspace tasks passed                                                        |
| Unit tests                          | 4/4 passed                                                                        |
| Production builds                   | API, workers, and 32-route Next.js web build passed                               |
| Dependency audit                    | No known vulnerabilities at moderate-or-higher threshold                          |
| Diff integrity                      | `git diff --check` clean                                                          |

The real-model evaluation is a strong starter gate, not a complete proof of all
possible model behavior. Keep its security categories at 100% on every model or
prompt change and expand the dataset with real school language over time.

## Live project state after the audit

- 105 total tenant records: 104 archived test/historical records, one school in
  `configuration`, and zero schools in `live` status.
- The operating-portfolio view correctly reports one school, 258 active
  students, five active staff memberships, 230 guardians, one linked parent,
  and TZS 0 MRR.
- All 105 tenants have payroll settings; the current configuration school still
  needs its own verified settings before a payroll can run.
- Ten failed/incomplete `Smoke …` tenants left by older interrupted tests were
  archived and 20 memberships revoked. No tenant or school records were
  deleted.
- The only pending outbox rows belong to archived test tenants; the operating
  school has no pending SMS.
- A temporary local pre-migration dump containing school data was removed after
  the live migration and regression checks completed. The live
  database was not deleted or reset.

## Blocking items before customer traffic

1. **Deploy one synchronized release.** There is no production target or public
   domain in the repository, and the configured API URL is localhost. Deploy
   the current web, API, queue-worker, and outbox-drainer code together because
   the live database now uses the hardened payment RPC contract.
2. **Set production secrets and controls.** At minimum: `NODE_ENV=production`,
   `WEB_ORIGIN`, `TRUST_PROXY`, Supabase server keys, TLS Redis, a strong
   `HEALTH_TOKEN`, `SENTRY_DSN`, Moonshot credentials/model, `SMS_DRIVER=beem`,
   Beem credentials/sender ID, and HTTPS public API/web URLs. Rotate any secret
   that has ever appeared in a log or shared file.
3. **Run persistent workers.** Deploy both `pnpm --filter @atlas/workers start`
   and `pnpm --filter @atlas/workers drain`. The current health result is
   degraded because no persistent worker heartbeat is running.
4. **Enable operations.** Add uptime checks for `/api/v1/health`, authenticated
   checks for its detailed subroutes, Sentry alerts, Redis/DB/outbox alarms,
   Supabase point-in-time recovery or tested scheduled backups, and an incident
   owner/on-call rota. Complete the contacts and exercises in the
   [incident-response runbook](ATLAS_INCIDENT_RESPONSE.md).
5. **Complete Tanzania privacy work.** Confirm controller/processor roles,
   register with the Personal Data Protection Commission where required, sign
   school DPAs and a model-provider agreement, document lawful basis/parental
   notices for children's and health data, define retention/deletion, complete
   a breach process, and obtain the required approval/permit before sending
   personal data to a provider outside Tanzania. See the official PDPC pages
   for [controller/processor registration](https://pdpc.go.tz/en/registration-data-controller-processor/),
   [controller and processor responsibilities](https://pdpc.go.tz/en/protection/data-controller-data-processor/),
   and [cross-border transfer permits](https://pdpc.go.tz/en/services/cross-border-data-transfer-permit/).
   Until this is signed off, keep AI limited to synthetic/pilot data or disable
   it for real students. Record owners and evidence in the
   [Tanzania privacy checklist](TANZANIA_PRIVACY_CHECKLIST.md).
6. **Have a Tanzanian accountant approve payroll.** The code intentionally
   blocks unverified settings. Review PAYE bands and the applicability of NSSF,
   WCF, SDL, HESLB, and other schemes for each school before verification. Use
   current primary sources such as [NSSF contribution guidance](https://www.nssf.go.tz/pages/rate-of-contributions),
   the [Tanzania Revenue Authority](https://www.tra.go.tz/), the
   [Ministry of Finance](https://www.mof.go.tz/), and current written WCF/HESLB
   guidance applicable to the school. Do not treat seeded defaults or this
   report as tax advice.
7. **Configure mobile release separately.** Put the HTTPS API/Supabase public
   values into the EAS production environment, configure signing/store records,
   and perform physical-device tests. A web-only pilot does not need to wait for
   store approval.
8. **Run school acceptance.** With one real pilot school, test owner,
   accountant, teacher, class-teacher, and parent journeys; import a scrubbed
   copy of their structure; reconcile one invoice/payment and one payroll
   period; verify a real Beem SMS on Vodacom, Airtel, Yas, and Halotel; then have
   the school sign the acceptance checklist.

## Release sequence

1. Merge and tag this audited change set; let the quality workflow pass.
2. Provision production web/API, Redis, queue worker, and outbox drainer.
3. Set production environment variables and confirm fail-fast startup.
4. Verify `/health`, worker heartbeats, Sentry, and a restore procedure.
5. Complete PDPC/DPA/cross-border and payroll sign-offs.
6. Configure the existing school, verify permissions, and run acceptance.
7. Move only that tenant from `configuration` to `training`; operate under
   supervision for one school week.
8. Reconcile finance/payroll/SMS/AI usage, then promote it to `live` and open the
   next small cohort. Do not enable unrestricted self-service onboarding in the
   first cohort.

## Known residual risks

- AI quality passed the current 40-case set, but 17.5-second average latency and
  token consumption need budgets, dashboards, and model-change regression.
- SMS is at-least-once across the external-provider boundary: if Beem accepts a
  message and the database becomes unavailable before the sent marker, a retry
  can duplicate it. Reconcile with provider message IDs when that API supports
  idempotency/status lookup.
- The fast unit-test layer is small (four tests). The 25 live-connected smoke
  suites provide broad coverage, but new business logic should receive focused
  unit/integration tests as it is added.
- The UI review was code/build based. Physical phones, low-bandwidth networks,
  assistive technology, printers, and each supported browser still need pilot
  acceptance testing.
