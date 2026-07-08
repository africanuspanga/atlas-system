-- ATLAS migration 0015 — AI proposed actions (CTO §9 "AI write actions").
--
-- The assistant can PROPOSE a small catalogue of write actions but can never
-- execute one: a proposal row is created with a server-built preview, the
-- user confirms it in the UI, the API re-checks permissions at confirm time
-- and executes through the SAME RPCs the app uses (ledger, caps and
-- immutability invariants all hold). Single-use, user-bound, 10-minute
-- expiry. Everything is audited.
--
-- Hard-blocked forever (not in the catalogue, documented in
-- ATLAS_AI_ASSISTANT_SPEC.md): deleting/archiving students, modifying or
-- reversing payments, publishing results, changing grades, payroll,
-- suspending accounts, changing subscription plans.

create table public.ai_proposed_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  conversation_id uuid references public.ai_conversations(id),
  user_id uuid not null references public.profiles(id),
  action_name text not null,
  arguments jsonb not null default '{}'::jsonb,
  preview jsonb not null default '{}'::jsonb,
  status text not null default 'proposed' check (status in
    ('proposed','executed','failed','rejected','expired')),
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  resolved_at timestamptz
);
create index ai_proposed_actions_tenant_idx
  on public.ai_proposed_actions (tenant_id, created_at desc);
create index ai_proposed_actions_open_idx
  on public.ai_proposed_actions (user_id, status) where status = 'proposed';

alter table public.ai_proposed_actions enable row level security;
-- The proposing user sees their own proposals; writes are service-role only.
create policy "own proposed actions" on public.ai_proposed_actions
  for select using (user_id = auth.uid() and app.is_tenant_member(tenant_id));
