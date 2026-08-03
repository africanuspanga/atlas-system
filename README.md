# ATLAS

Tanzania-first, multi-tenant school SaaS for admissions, students, academics,
attendance, assessments, fees and double-entry accounting, payroll, parents,
communication, operations, reporting, and a permission-scoped AI agent.

## Current release status

The repository and live Supabase schema are technically ready for a controlled,
staff-supervised pilot. Open paid onboarding remains blocked on production
deployment, persistent workers, monitoring, Beem SMS credentials/testing,
Tanzania privacy sign-off, and school-specific payroll verification.

Read the [current go-live report](docs/audit/GO_LIVE_READINESS_2026-08-03.md)
before deploying or onboarding a school. Older dated audit files are historical
evidence, not current operating instructions.

## Repository layout

```text
apps/
  web/       Next.js 16 school dashboard, parent portal, control centre
  api/       NestJS 11 business API and AI agent
  workers/   BullMQ workers and the standalone SMS outbox drainer
  mobile/    Expo SDK 57 staff and parent app
packages/
  i18n/      Shared English/Kiswahili dictionary
  config/    Shared TypeScript/tooling configuration
  contracts/ Shared domain contracts
  validation/ Shared validation
supabase/
  migrations/ Versioned schema, RLS, constraints, triggers, and RPCs
  seed.sql    Roles, permissions, plans, and reference data
docs/         Architecture, operations, testing, product, audit, and sales docs
```

The database source of truth is migrations `0001`–`0033`. The linked live
project was verified at migration `0033` on 3 August 2026.

## Stack

- Web: Next.js 16 App Router, React 19, TypeScript, Tailwind CSS v4
- API: NestJS 11 with Zod validation, tenant/permission guards, and Pino logs
- Data: Supabase Postgres/Auth/Storage with tenant-aware RLS
- Jobs: Redis + BullMQ plus database-backed pollers
- Mobile: Expo SDK 57 / React Native
- AI: Moonshot Kimi through a fixed, server-authorized tool catalogue

## Local setup

Prerequisites: Node 22+, pnpm 10.28+, Supabase CLI, and Redis.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
# Fill the local Supabase, Redis, and optional AI/SMS values.

pnpm dev
```

Web defaults to `http://localhost:3000`; API defaults to
`http://localhost:4000`. See the app-specific READMEs for running one surface.

For a local Supabase stack:

```bash
pnpm exec supabase start
pnpm exec supabase db reset
```

For a linked remote project, never hand-apply an arbitrary migration range.
Rehearse the complete chain, inspect the dry run, then let the CLI apply only
missing migrations:

```bash
./scripts/shadow-migrations.sh
set -a && source .env && set +a
pnpm exec supabase db push --dry-run --include-all
pnpm exec supabase db push --include-all
```

## Required verification

Next build and type generation both use `.next`, so keep these gates sequential:

```bash
pnpm --filter @atlas/web exec next typegen
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm audit --audit-level moderate
```

Live-connected smoke suites and the real-provider AI evaluation are documented
in [the testing guide](docs/ATLAS_TESTING_GUIDE.md).

## Non-negotiable rules

1. Every tenant-owned record is tenant-scoped; tenant context is resolved and
   authorized on the server. Browser filtering is never a security boundary.
2. Service-role credentials stay in the API/workers. Never expose them through
   `NEXT_PUBLIC_*` or `EXPO_PUBLIC_*`.
3. Financial records are immutable. Corrections are append-only reversals and
   every money movement must create balanced journal entries.
4. Sensitive mutations and platform actions are audited.
5. AI tools inherit the user's tenant and permissions. Writes are proposals
   until a human confirms through the separate confirmation endpoint.
6. English and Kiswahili are first-class; dates use `Africa/Dar_es_Salaam`.

Start with the [documentation index](docs/README.md),
[architecture overview](docs/architecture/overview.md),
[administrator guide](docs/ADMIN_GUIDE.md),
[testing guide](docs/ATLAS_TESTING_GUIDE.md), and
[pilot runbook](docs/audit/ATLAS_PILOT_RUNBOOK.md).
