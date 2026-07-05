# ATLAS

Tanzania-first school management SaaS — the operating system of a school:
admissions, students, academics, attendance, assessments, finance with real
double-entry accounting, parent experience, communication and more, on one
multi-tenant platform.

## Repository layout

```
atlas/
├── apps/
│   ├── web/        Next.js 16 dashboard (school + SaaS control centre)
│   ├── api/        NestJS business API — all core business rules live here
│   └── workers/    BullMQ background workers (reports, notifications, imports)
├── packages/
│   ├── config/     Shared tsconfig and tooling config
│   ├── contracts/  Shared domain types and API contracts
│   └── validation/ Shared Zod schemas
├── supabase/
│   ├── migrations/ Version-controlled SQL (schema, RLS, functions)
│   └── seed.sql    System roles, permissions, starter plan
└── docs/           Architecture, product, accounting, security, API docs
```

## Stack

- **Web**: Next.js 16 (App Router), React 19, TypeScript strict, Tailwind v4, shadcn/ui
- **API**: NestJS 11 — core accounting, grading, payment and promotion rules live here, never in React
- **Data**: Supabase Postgres (RLS on every tenant-owned table), Auth, Storage, Realtime
- **Jobs**: Redis + BullMQ (`apps/workers`)
- **Mobile** (later phase): Expo React Native parent app

## Getting started

```bash
pnpm install

# Database — either connect a Supabase project or run locally:
#   supabase start          (requires the Supabase CLI + Docker)
#   supabase db reset       (applies migrations + seed)
cp .env.example .env        # then fill in Supabase keys

pnpm dev                    # runs web + api + workers via turbo
```

Web runs on http://localhost:3000, API on http://localhost:4000.

## Non-negotiable architecture rules

1. Every tenant-owned table includes `tenant_id`; RLS is enabled on all of them.
2. Never trust a `tenant_id` sent by a client — membership is resolved server-side.
3. The Supabase service-role key is used only by `apps/api` and `apps/workers`.
4. Business logic (fees, grading, promotion, accounting) lives in NestJS services
   and Postgres constraints — not in React components.
5. Financial records are reversed, never edited or deleted. Debits equal credits.
6. Sensitive changes are written to the append-only `audit_logs` table.
7. Both English and Kiswahili are first-class languages.

See `docs/architecture/overview.md` for the full picture and the product
blueprint for the roadmap (Phase 1: platform foundation → Phase 5: parent
experience → Phase 6: full accounting).
