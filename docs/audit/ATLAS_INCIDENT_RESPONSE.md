# ATLAS incident-response runbook

_Updated 3 August 2026 · complete the contact table before pilot._

Use this runbook for production or pilot incidents. It coordinates technical
response; the DPO and Tanzanian counsel decide regulatory notices and timing.
Never hide, rewrite, or delete audit/financial evidence to make an incident
appear resolved.

## Severity and immediate owner

| Severity    | Examples                                                                                                                                            | Response                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| P0 critical | cross-tenant exposure; lost/corrupted school data; unbalanced ledger; unauthorized platform/payroll action; confirmed credential compromise         | page incident commander and DPO now; contain immediately; founder owns decisions |
| P1 high     | customer login broadly unavailable; payments/attendance/SMS materially wrong; repeated duplicate sends; restore/worker failure with customer impact | page engineering/operations; contain within the active response window           |
| P2 medium   | one tenant/workflow degraded with safe workaround and no known integrity/privacy impact                                                             | assign owner, communicate workaround, fix under change control                   |
| P3 low      | cosmetic/localized issue without data, security, or core-workflow impact                                                                            | backlog with evidence and regression test                                        |

If facts are incomplete, classify upward until privacy and integrity are ruled
out. Every incident gets an ID, UTC and `Africa/Dar_es_Salaam` timestamps,
environment, affected tenant(s), reporter, request IDs, severity, and commander.

## First 15 minutes

1. Start the incident record and response channel; name commander, technical
   lead, DPO/privacy lead, communications lead, and scribe.
2. Preserve logs, request IDs, audit rows, provider IDs, release SHA, database
   timestamps, and relevant configuration metadata. Restrict access to the
   evidence; do not copy student data into chat.
3. Determine scope: environment, tenant(s), users/roles, data categories,
   financial entries, external messages/providers, start time, and whether the
   issue is ongoing.
4. Contain with the narrowest safe action: suspend an affected tenant/account,
   disable an endpoint/AI/SMS worker, revoke a token, or roll traffic away from
   a bad release. Do not hard-delete tenants or edit immutable finance rows.
5. For suspected cross-tenant access or credential compromise, stop affected
   access first and notify the DPO/founder immediately.

## Investigation and containment

- Correlate API logs by `request_id`, user, tenant, route, status, and release.
- Review `audit_logs`, `platform_audit_logs`, AI tool/action logs, job/outbox
  state, Auth events, and provider/Sentry records without broadening access.
- Check whether RLS/API guards, tenant header/cookie, cached state, imports,
  reports, Storage links, or platform operations crossed the boundary.
- For finance/payroll, reconcile journal entries and tenant ledger before and
  after the event. Correct only through reviewed reversal/forward-fix paths.
- For SMS, stop the drainer if duplicates or sensitive content may continue;
  reconcile ATLAS rows with provider identifiers/status before retrying.
- For secrets, revoke/rotate the exact exposed credential, update the secret
  manager/deployments, and verify it is absent from client artifacts and logs.
- Keep a timestamped decision log including rejected hypotheses and evidence.

## Communications and privacy decision

The communications lead issues only approved facts: what is known, customer
impact, containment, safe customer action, next update time, and contact path.
Do not speculate or expose another tenant in a school notification.

The DPO and counsel use the
[Tanzania privacy checklist](TANZANIA_PRIVACY_CHECKLIST.md) and current PDPC
requirements to decide whether the event is a personal-data breach, who must be
notified, in what form, and by when. Record that decision even when the outcome
is “notification not required.”

## Recovery gate

Do not reopen traffic or workers until:

- the root trigger is removed or safely isolated;
- tenant/privacy scope is bounded and evidence preserved;
- database/ledger integrity and RLS attacks pass for the affected path;
- credentials/configuration are rotated where needed;
- queues/outbox are reconciled so restart will not duplicate work;
- health, Sentry, workers, and smoke/regression checks pass on the release;
- incident commander, technical lead, and DPO approve recovery;
- affected schools have an approved update and support route.

A code rollback does not reverse database migrations. Use a reviewed forward
fix or the restore procedure; never restore over production as an experiment.

## Closure and follow-up

Within the agreed review window, record timeline, impact, data/tenants, root
cause, detection gap, response effectiveness, customer/regulatory notices,
recovery evidence, and corrective actions with owners/dates. Add a regression
test or monitoring control where possible. Founder and DPO sign P0/P1 closure.

## Contact and exercise record

| Role                                  | Primary | Backup | Secure contact | Authority                         |
| ------------------------------------- | ------- | ------ | -------------- | --------------------------------- |
| Founder/accountable executive         |         |        |                | customer/business decisions       |
| Incident commander                    |         |        |                | containment/recovery coordination |
| Technical lead                        |         |        |                | application/database changes      |
| DPO/privacy lead                      |         |        |                | breach/regulatory decision        |
| Tanzanian counsel                     |         |        |                | legal advice/notification review  |
| Communications lead                   |         |        |                | school/public messages            |
| Supabase/hosting/Beem/Sentry contacts |         |        |                | provider escalation               |

Run tabletop exercises for cross-tenant exposure and restore/data loss before
the first pilot, then at least annually and after a material architecture or
provider change. Link exercise evidence from the release record.

Related runbooks: [monitoring](ATLAS_MONITORING.md),
[restore](ATLAS_RESTORE_RUNBOOK.md), [security](ATLAS_SECURITY_AUDIT.md),
[pilot](ATLAS_PILOT_RUNBOOK.md), and
[release readiness](ATLAS_RELEASE_READINESS.md).
