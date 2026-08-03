# ATLAS controlled-pilot runbook

_Updated 3 August 2026. Use for the first staff-supervised Tanzanian school._

## Entry criteria

Do not start real-data onboarding until every item is evidenced:

- release commit passes `docs/ATLAS_TESTING_GUIDE.md`;
- production web/API, Redis, queue worker, and outbox drainer are deployed;
- migration history ends at `0033`;
- health, worker heartbeats, Sentry, logs, uptime alerts, and restore are tested;
- Beem credentials/sender ID are configured and real-network delivery tested;
- the [Tanzania privacy checklist](TANZANIA_PRIVACY_CHECKLIST.md), including
  PDPC/DPA/retention/breach/cross-border AI decisions, is signed;
- the school names a data owner, head-teacher approver, bursar/accountant
  approver, and ATLAS implementation owner;
- payroll is disabled until that school's rates are professionally reviewed.

The school begins in `configuration`, moves through `data_review`, then
`training`. It is never placed directly into `live`.

## 1. Discovery and data contract

Record school legal/contact details, campuses, academic year/terms, education
levels, class/stream naming, subjects, staff roles, student numbering,
guardians, fee structure, opening balances, instalment policy, payment methods,
attendance/results process, boarding/transport/library/clinic needs, payroll
scheme, language, and SMS consent/notice process.

Agree which data will not be imported. Do not collect extra student/health data
“just in case”. Share files only through the approved private import path—not
email, WhatsApp, public links, or source control.

## 2. Rehearsal in staging

1. Create the school with the real structure but use scrubbed data where
   possible.
2. Invite representative owner, finance, teacher/class-teacher, and parent
   accounts; verify the RBAC matrix.
3. Upload each import domain, map columns, dry run, correct errors, then approve.
4. Re-run the same job/idempotency path and confirm it does not duplicate data.
5. Produce the verification pack:
   - students by sex/class/status;
   - guardians linked/unlinked and invalid contacts;
   - fee items, invoices, payments, opening balances;
   - receivables total reconciled to the trial balance;
   - staff/role list;
   - import error report and accepted exceptions.
6. Run the owner/finance/teacher/parent walkthrough from the testing guide.
7. Send test-only SMS to consenting staff numbers and reconcile provider status.
8. Keep AI on synthetic/scrubbed data until compliance approval covers the
   selected model/provider and processing location.

## 3. School data sign-off

```text
ATLAS pilot data acceptance — <school>
Environment/import job IDs: <ids>             Date: <date>
Students in ATLAS: <n>                        School source: <n>
Guardians linked: <n>                         Invalid/unlinked: <n>
Invoices/opening balances: TZS <amount>        School source: TZS <amount>
Payments imported: TZS <amount>                School source: TZS <amount>
Receivables/trial-balance reconciliation difference: TZS <must be 0>
Accepted discrepancies: <list or none>
Payroll rates approved by: <qualified person / date / source>
Privacy/DPA notices completed: <references>

Head teacher: __________  Bursar/accountant: __________
School data owner: ______  ATLAS implementation owner: ______
```

No production import or payroll verification happens without the appropriate
signatures.

## 4. Production cutover

1. Confirm current backup/PITR and the rollback decision owner.
2. Create/configure the production tenant and keep status `data_review`.
3. Reuse signed mappings/files through the normal import pipeline.
4. Diff production summaries against the signed staging pack; abort on mismatch.
5. Invite users and test each role with temporary credentials/invite links.
6. Verify web/API/worker health and send one staff-only Beem message.
7. Move the tenant to `training`; begin supervised use.

Migrations are forward changes. A code rollback does not undo database DDL.
If cutover fails, suspend the affected tenant, stop external sends, preserve
data/audit evidence, and restore or apply a reviewed forward fix according to
the incident owner—never edit immutable financial rows or hard-delete a tenant.

## 5. Training week

Daily checks:

- missing/late attendance registers and teacher support;
- invoices/payments/receipts vs source documents and ledger balance;
- outbox pending/failed age and provider delivery;
- import/report failures and worker heartbeat;
- 4xx/5xx, Sentry issues, and support request IDs;
- permission complaints (distinguish correct denial from missing role);
- AI answers against deterministic screens/reports, plus latency/token use;
- parent access only to linked children.

Keep a signed incident/decision log. Do not bypass controls to make a demo pass.

## 6. Promotion decision

Promote `training → live` only when:

- five consecutive school days complete without unresolved P0/P1 issue;
- finance and payroll reconciliations are signed;
- real SMS delivery is stable;
- backup/restore and incident contacts are confirmed;
- the school accepts its user/permission/data totals;
- privacy and AI conditions remain satisfied;
- the founder approves the go-live record in the platform audit trail.

If any gate fails, remain in `training` or suspend. Add the next pilot school
only after reviewing the first school's week-one metrics.
