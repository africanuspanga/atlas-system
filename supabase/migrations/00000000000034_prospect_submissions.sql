-- 0034 — prospect_submissions: the marketing funnel's lead capture.
--
-- NOT a tenant table. A prospect is a school that has not bought yet, so there
-- is no tenant_id to scope by and no membership to check. The table is
-- therefore deny-all under RLS and reachable ONLY through the service role
-- (POST /api/v1/prospects), matching the pattern used by device_tokens (0028).
--
-- The funnel must survive this table being unavailable: the caller always
-- emails the full record to the sales inbox and reports honestly whether the
-- row was stored. See apps/web/src/app/api/public/prospect/route.ts.

begin;

create table if not exists public.prospect_submissions (
  id uuid primary key default gen_random_uuid(),

  -- Denormalised on purpose: the school register is a bundled static dataset,
  -- not a table, so there is no foreign key to point at.
  school_id text,
  school_name text,
  district text,
  region text,

  -- Which tracked SMS link they arrived from, when they arrived from one.
  -- An unknown code is still recorded: codes get truncated by SMS clients and
  -- retyped by hand, and knowing a code was used is worth more than tidiness.
  outreach_code text,

  uses_system boolean,
  contact_name text,
  phone text,
  preferred_day text,
  intent text not null check (intent in ('demo', 'self_tour')),

  status text not null default 'new'
    check (status in ('new', 'contacted', 'booked', 'won', 'lost')),
  notes text,

  created_at timestamptz not null default now()
);

create index if not exists prospect_submissions_created_at_idx
  on public.prospect_submissions (created_at desc);
create index if not exists prospect_submissions_status_idx
  on public.prospect_submissions (status);
create index if not exists prospect_submissions_outreach_code_idx
  on public.prospect_submissions (outreach_code)
  where outreach_code is not null;

alter table public.prospect_submissions enable row level security;

-- Deliberately ZERO policies: deny-all to anon and authenticated alike.
-- Anonymous read and anonymous insert are both refused; the service role
-- bypasses RLS and is the only way in. Leads contain personal contact details
-- and must never be readable from the browser.
revoke all on public.prospect_submissions from anon, authenticated;

comment on table public.prospect_submissions is
  'Marketing funnel leads. Deny-all RLS; written only by the API service role.';

commit;
