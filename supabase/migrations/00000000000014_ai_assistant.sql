-- ATLAS migration 0014 — AI assistant audit tables (CTO §9).
--
-- The AI layer itself lives in the API: a fixed read-only tool catalogue that
-- calls the SAME deterministic SQL functions as the reporting module (mig
-- 0012), with server-verified tenant context — the model never supplies a
-- tenantId and never executes SQL. These tables are the audit trail: every
-- conversation, message and tool call is recorded per tenant.
--
-- Retention: conversation content is user data — schedule a purge of
-- ai_messages older than 90 days (workers cron) before GA; tool-call audit
-- rows (no content) are kept like other audit logs.

create table public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  user_id uuid not null references public.profiles(id),
  title text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ai_conversations_tenant_user_idx
  on public.ai_conversations (tenant_id, user_id, updated_at desc);
create trigger ai_conversations_updated_at before update on public.ai_conversations
  for each row execute function app.set_updated_at();

create table public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  conversation_id uuid not null references public.ai_conversations(id),
  role text not null check (role in ('user','assistant','tool')),
  content text not null,
  tool_name text,
  created_at timestamptz not null default now()
);
create index ai_messages_conversation_idx
  on public.ai_messages (conversation_id, created_at);

create table public.ai_tool_calls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  conversation_id uuid references public.ai_conversations(id),
  user_id uuid not null references public.profiles(id),
  role_keys text[] not null default '{}',
  tool_name text not null,
  arguments jsonb not null default '{}'::jsonb,
  status text not null check (status in ('ok','denied','error')),
  row_count integer,
  duration_ms integer,
  model text,
  error text,
  created_at timestamptz not null default now()
);
create index ai_tool_calls_tenant_idx on public.ai_tool_calls (tenant_id, created_at desc);

create table public.ai_usage_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  conversation_id uuid references public.ai_conversations(id),
  model text not null,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  created_at timestamptz not null default now()
);
create index ai_usage_records_tenant_idx on public.ai_usage_records (tenant_id, created_at desc);

-- RLS: a user reads their own conversations/messages; tool-call and usage
-- audit is readable by members holding audit.view (writes: service role).
alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;
alter table public.ai_tool_calls enable row level security;
alter table public.ai_usage_records enable row level security;

create policy "own conversations" on public.ai_conversations
  for select using (user_id = auth.uid() and app.is_tenant_member(tenant_id));
create policy "own conversation messages" on public.ai_messages
  for select using (
    exists (select 1 from public.ai_conversations c
            where c.id = ai_messages.conversation_id
              and c.user_id = auth.uid()
              and app.is_tenant_member(c.tenant_id))
  );
create policy "members read ai tool audit" on public.ai_tool_calls
  for select using (app.is_tenant_member(tenant_id));
create policy "members read ai usage" on public.ai_usage_records
  for select using (app.is_tenant_member(tenant_id));
