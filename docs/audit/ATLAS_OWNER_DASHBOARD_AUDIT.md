# ATLAS Owner / Platform Dashboard Audit

_Audit date: 2026-07-05 · Status: **NOT BUILT** — this is a gap analysis + spec_

## Finding

There is **no ATLAS SaaS owner/platform control centre**. The control-plane
*tables* exist (`plans`, `plan_features`, `subscriptions`, `feature flags`,
`tenants`, `audit_logs`), but there is no `/platform` app, no platform-staff
auth, no subscription enforcement, and no tenant-lifecycle management UI. This
is the biggest single gap between the current build and the CTO's target.

The end-to-end flow the CTO letter §7 asks to test —
`website registration → tenant → subscription → control centre → onboarding →
usage → plan enforcement → renewal` — **cannot pass today** because the website,
the control centre, and the enforcement layer do not exist.

## What exists that the platform layer can build on

- `tenants` with `status` (configuration/active/suspended/archived) and the
  archive-never-delete rule (audit_logs FK). Isolation is proven.
- `plans` + `plan_features` + `subscriptions` schema (unused by any code path).
- Append-only `audit_logs` per tenant.
- A working onboarding RPC and invitation system to reuse.

## Required build (specification)

### Route & auth
- `/platform` (or `/control-centre`), gated by a **platform-staff** identity
  that is distinct from tenant membership — a separate `platform_users` table +
  guard, never a row in `tenant_memberships`. All platform actions audited to a
  platform-scoped log.

### Platform overview (read models)
Totals across all tenants: schools by status, campuses, students, staff,
parents, active users, new tenants this month, MRR, outstanding subscription
invoices, SMS/storage/AI/API usage, failed jobs, failed webhooks, platform
errors, support tickets. These are cross-tenant aggregates — must run under the
service role in a dedicated platform service, never leak per-tenant PII into the
overview.

### Tenant management
Create/approve school, view info + onboarding progress, assign/change plan,
extend trial, enable/disable modules, set usage limits, suspend/reactivate,
view usage + billing history, request data export, initiate compliant deletion
(archive + retention, honouring the audit_logs FK).

### Subscription enforcement (the missing spine)
`Plan → Subscription → Feature Entitlements → Usage Limits → Billing Status →
School Access`. Changing a plan must immediately change available modules,
campus/user/student caps, storage, SMS, AI, report features, API access —
**enforced in the API guard layer**, not by hiding menu items. Today none of
this is enforced (`POST /onboarding` lets any account create unlimited tenants —
AUD-016).

### Support impersonation
Requires a platform permission + written reason + expiry; shows an impersonation
banner; records original + impersonated user + tenant + every action; instantly
revocable; never exposes passwords. Not built.

## Recommended sequencing

1. `platform_users` + platform guard + `/platform` shell.
2. Subscription entitlement model + **API enforcement** (caps on onboarding,
   students, campuses) — this closes AUD-016 and is a prerequisite for charging.
3. Tenant lifecycle UI (suspend/reactivate/extend).
4. Usage metering (SMS/AI/storage counters feeding the overview).
5. Support impersonation with full audit.
6. Marketing website + self-serve registration → wire the full §7 flow → add an
   end-to-end test mirroring the acceptance list.

## Verdict

Platform layer is **greenfield**. It does not block a *manually onboarded*
single-school pilot (an operator runs onboarding directly), but it blocks
self-serve SaaS operation and paid subscriptions. Prioritise the subscription
enforcement spine first — it is both the revenue mechanism and the closure of
the tenant-creation-spam risk.
