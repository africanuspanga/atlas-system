# ATLAS Tanzania privacy go-live checklist

_Updated 3 August 2026 · owner: founder/DPO with Tanzanian counsel._

This is an operational evidence checklist, not legal advice. ATLAS processes
children's identity, guardians, attendance, academic results, fees, staff and
payroll, communications, device identifiers, and limited clinic information.
Do not onboard real school data or enable real-student AI until the accountable
owner has completed this checklist and obtained professional/PDPC guidance.

## Official references

- [Personal Data Protection Act, 2022](https://pdpc.go.tz/the-personal-data-protection-act-2022/)
- [Personal Data Collection and Processing Regulations, 2023](https://pdpc.go.tz/en/policies-legislations/regulations/)
- [PDPC controller/processor registration](https://pdpc.go.tz/en/registration-data-controller-processor/)
- [PDPC controller and processor guidance](https://pdpc.go.tz/en/protection/data-controller-data-processor/)
- [PDPC data-subject rights](https://pdpc.go.tz/en/protection/data-protection/)
- [PDPC cross-border transfer permit](https://pdpc.go.tz/en/services/cross-border-data-transfer-permit/)
- [PDPC compliance templates](https://pdpc.go.tz/en/reports/)
- [PDPC portal and current notices](https://pdpc.go.tz/)

Use the current versions and written professional advice. Record the advice,
decision, date, owner, evidence link, and renewal/review date for every item.

## 1. Accountability and registration

- [ ] Map who determines purposes/means for each flow: ATLAS, the school, or
      both. Document controller/processor roles instead of assuming one role
      for the entire product.
- [ ] Confirm and complete required PDPC registration for the ATLAS operating
      entity and each participating school; retain certificate/reference and
      renewal dates.
- [ ] Appoint/register the required data-protection contact or DPO and publish
      a monitored privacy contact channel.
- [ ] Name a founder-level accountable owner and a deputy. No engineering
      checkbox substitutes for their approval.

## 2. Processing record and lawful basis

- [ ] Inventory each data category, source, purpose, user role, recipient,
      storage location, retention period, deletion method, and transfer.
- [ ] Have counsel record the lawful basis/condition for each school, child,
      guardian, employee/payroll, health, SMS, analytics, and AI flow.
- [ ] Complete and approve a DPIA using current PDPC guidance/templates for
      children's data, clinic data, AI, cross-border providers, platform access,
      and the multi-tenant failure modes identified by the security audit.
- [ ] Minimize mandatory fields. Clinic messages stay generic; AI receives no
      clinical detail or individual salary through the current tool catalogue.
- [ ] Separate operational messages from marketing and document the applicable
      choice/objection process for each.

## 3. Notices, schools, and suppliers

- [ ] Approve plain-language English and Kiswahili privacy notices for school
      staff, guardians/parents, students where appropriate, and the public
      website/application.
- [ ] Sign a school data-processing agreement defining roles, instructions,
      security, incidents, rights requests, retention/return/deletion,
      subprocessors, audit/support access, and exit export.
- [ ] Complete vendor terms and security/privacy review for Supabase, the
      chosen host, Redis, Sentry, Moonshot, Beem, email, Expo/mobile services,
      and every later analytics/payment provider.
- [ ] Maintain and notify an approved subprocessor list with service, entity,
      country/region, purpose, data category, and contract link.

## 4. International transfers and AI

- [ ] Map the actual country/region for every hosted service and support path.
- [ ] Determine with counsel/PDPC which transfers require approval or permit.
      The 2023 regulations include a permit form for transferring personal data
      outside Tanzania; retain the application, permit, conditions, and expiry.
- [ ] Sign model-provider terms covering training use, retention, human access,
      security, deletion, subprocessors, and incident notice.
- [ ] Keep AI disabled for real-student data—or limited to synthetic/scrubbed
      pilot data—until the transfer/lawful-basis/DPA decision is signed.
- [ ] On approval, enable only the current permission-scoped tools and monitor
      prompt/tool audit records, latency, cost, and attempted disclosures.

## 5. Individual rights and retention

- [ ] Publish an identity-verification and request workflow for applicable
      access, correction, objection/restriction, deletion, portability, and
      automated-decision questions; counsel must set response timelines and
      exceptions.
- [ ] Test a guardian request spanning Auth, student links, communications,
      finance, reports, audit requirements, AI records, Storage, and backups.
- [ ] Approve a retention schedule per table/artifact. Financial/audit
      immutability may require retention rather than direct deletion; record
      the legal rule and the safe anonymization/closure approach.
- [ ] Build and verify missing automated retention/deletion jobs before relying
      on them. The repository does not yet provide a comprehensive retention
      engine or a general self-service exit export.

## 6. Security, support access, and incidents

- [ ] Complete the security, isolation, restore, monitoring, and release gates
      linked below; store evidence with the release record.
- [ ] Restrict and review platform staff access. Current support impersonation
      is not built; do not share school credentials as a workaround.
- [ ] Complete `ATLAS_INCIDENT_RESPONSE.md` with named contacts and legally
      reviewed notification decision/timing; verify severity, containment,
      forensics, decision authority, evidence preservation, and communications.
- [ ] Run one tabletop exercise for cross-tenant exposure and one for lost or
      encrypted school data before pilot.

## 7. Sign-off record

All rows must have a named owner and evidence link. “In progress” is not a
release approval.

| Approval                                           | Name | Date | Evidence/reference | Expiry/review | Status |
| -------------------------------------------------- | ---- | ---- | ------------------ | ------------- | ------ |
| ATLAS controller/processor role and registration   |      |      |                    |               | ⬜     |
| Pilot-school role/registration and DPA             |      |      |                    |               | ⬜     |
| DPO/privacy contact                                |      |      |                    |               | ⬜     |
| Lawful-basis/notices/children/health review        |      |      |                    |               | ⬜     |
| Subprocessors and international-transfer permit    |      |      |                    |               | ⬜     |
| AI provider and real-student AI approval           |      |      |                    |               | ⬜     |
| Retention, rights, exit export, and breach process |      |      |                    |               | ⬜     |
| Founder final approval                             |      |      |                    |               | ⬜     |

Related evidence: [security audit](ATLAS_SECURITY_AUDIT.md),
[tenant-isolation audit](ATLAS_TENANT_ISOLATION_AUDIT.md),
[monitoring](ATLAS_MONITORING.md), [restore runbook](ATLAS_RESTORE_RUNBOOK.md),
[pilot runbook](ATLAS_PILOT_RUNBOOK.md), and
[current go-live decision](GO_LIVE_READINESS_2026-08-03.md).
