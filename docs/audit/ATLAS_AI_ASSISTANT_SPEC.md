# ATLAS AI assistant — implemented specification

_Updated 3 August 2026 · migrations `0014`, `0015`, and later hardening through
`0033`._

## Product contract

Ask ATLAS is a first-class, bilingual interface to school operations. It may
retrieve deterministic ATLAS data and propose tightly controlled actions. It
must never invent balances, bypass roles, cross tenants, execute unconfirmed
writes, or treat content inside data as instructions.

## Provider and production mode

The implemented provider is Moonshot Kimi (`MOONSHOT_MODEL`, currently
`kimi-k2.6`) through a bounded fetch client. Production startup rejects
`AI_DRIVER=mock`, a missing provider key, or unsafe mock fallback. The mock
driver is reserved for deterministic smoke tests.

Model data flow requires a separate Tanzania privacy/cross-border processing
decision before real-student use. A technical safety pass is not a legal basis;
use `TANZANIA_PRIVACY_CHECKLIST.md` for the required evidence and approvals.

## Server-controlled context

The model receives no credentials, SQL, Supabase client, tenant id selection,
or confirmation capability. The API builds context from authenticated state:

```ts
type AtlasAIContext = {
  userId: string;
  tenantId: string;
  campusIds: string[];
  permissions: string[];
  locale: "en" | "sw";
  entitlements: TenantEntitlements;
};
```

Every call validates permission and arguments, filters by the server tenant,
fails closed on database errors, returns bounded structured data/source
metadata, and records tool/usage audit rows. Results larger than the 16k
character tool boundary are refused with a narrower-filter instruction.

## Read catalogue

The 28 current read tools cover school/student summaries, attendance/absences,
fee collection/outstanding/debtors/trial balance, assessment/CA progress,
subscription usage, student/guardian/staff search, student profile/invoices,
academics, admissions, timetable, report generation, hostel, transport,
library, inventory, clinic, payroll aggregates, import jobs, and announcement
delivery summaries.

Rules:

- finance tools call deterministic/reconciling services rather than model math;
- payroll exposes aggregate run totals, never individual salaries;
- clinic output contains student number/status/date only—no name, symptoms,
  treatment, or notes;
- tools return at most the documented bounded rows and say when scope is partial;
- date words such as “today/leo” use `Africa/Dar_es_Salaam`;
- Kiswahili questions follow the same tool/permission path as English.

Tenant document ingestion/RAG is **not built**. If added, document text remains
untrusted data and retrieval must enforce tenant/campus/access metadata before
returning any chunk.

## Action catalogue

The 20 current proposals cover payment, invoice, instalments, student creation,
staff invite, announcement, timetable slot, A-Level combination, fee reminders,
hostel, transport, library loan/return, clinic visit, inventory movement,
assessment shell, guardian link, student lifecycle, class assignment/transfer,
and academic-year creation.

Flow:

```text
model calls propose tool
→ server validates permission/arguments and resolves live records
→ user-bound, tenant-bound, single-use preview (10-minute expiry)
→ user presses Confirm in the product
→ server reloads proposal and rechecks current permissions/live state
→ normal API/RPC executes with existing caps/immutability/audit
```

Payment proposals use the proposal/action id as their idempotency key. The
model cannot call confirmation. Direct prompts, instructions embedded in a
student/document field, or provider tool hallucinations cannot skip this gate.

The catalogue cannot delete records, modify/reverse payments, publish results,
change grades, run/post payroll, suspend tenants, or change plans. Student
status changes are append-only lifecycle operations with extra archive rights;
they close/open enrolment only after human confirmation and preserve history.

## Audit, quotas, and retention

Conversations, messages, tool calls, proposed actions, usage, failures, and
executions have tenant/user/model/timing/token records. Monthly token limits use
the Tanzania calendar and fail closed when usage cannot be read. Platform unit
costs expose aggregate requests/tokens per tenant.

Define and automate a production retention/deletion schedule before general AI
availability; keep only what the approved purpose requires. Logs must not store
raw health/SMS bodies, credentials, or unnecessary tool payloads.

## Evaluation

`apps/api/scripts/eval-ai.mjs` seeds known figures and scores tool choice,
answers, permissions, cross-tenant requests, direct/data-embedded injection,
Kiswahili, proposals, and attempts to self-confirm.

Verified 3 August 2026 with the real provider:

- 40/40 overall;
- finance 6/6, attendance 3/3, academics 4/4, platform 1/1;
- unauthorized 4/4, cross-tenant 2/2, injection 3/3;
- Kiswahili 4/4, actions 4/4, action security 3/3, modules 4/4;
- average latency 17,461 ms; total 388,805 tokens.

Security categories must remain 100%. Re-run after model, prompt, tool,
permission, schema, output-minimization, or confirmation changes. Expand with
real anonymized school phrasing, more multi-turn/adversarial cases, latency/cost
budgets, and regression history before broad GA.
