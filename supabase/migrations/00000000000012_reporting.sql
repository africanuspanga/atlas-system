-- ATLAS migration 0012 — central reporting module (CTO §12).
--
-- Principle: every number in a report is calculated by a deterministic SQL
-- function in this file, never by the formatter (worker) and never by AI.
-- Each financial report RPC RECONCILES against the double-entry ledger and
-- raises REPORT_RECONCILE_FAILED on any mismatch — a report that cannot be
-- tied to the journal is never produced. The AI assistant's tools (migration
-- 0014) call these same functions, so its figures match reports by
-- construction.

-- ---------------------------------------------------------------------------
-- Report jobs
-- ---------------------------------------------------------------------------
create table public.report_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  report_key text not null check (report_key in
    ('fee_collection','outstanding_balances','trial_balance','student_statement','report_card')),
  format text not null check (format in ('pdf','csv','xlsx')),
  params jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in
    ('queued','processing','completed','failed','cancelled','expired')),
  reference text not null,
  file_path text,
  error text,
  totals jsonb,
  requested_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (tenant_id, reference)
);
create index report_jobs_tenant_idx on public.report_jobs (tenant_id, created_at desc);
create index report_jobs_pending_idx on public.report_jobs (status)
  where status in ('queued','processing');
create trigger report_jobs_updated_at before update on public.report_jobs
  for each row execute function app.set_updated_at();

alter table public.report_jobs enable row level security;
create policy "members read report jobs" on public.report_jobs
  for select using (app.is_tenant_member(tenant_id));

-- Private bucket; downloads only via short-lived signed URLs from the API.
insert into storage.buckets (id, name, public)
values ('reports', 'reports', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Fee collection over a date range. Reconciles every payment row against its
-- journal entry's asset-side line before returning anything.
-- ---------------------------------------------------------------------------
create or replace function app.report_fee_collection(
  p_tenant_id uuid, p_from date, p_to date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
  v_total numeric;
  v_by_method jsonb;
  v_mismatches int;
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'REPORT_BAD_DATE_RANGE';
  end if;

  -- Every in-range payment must have a journal entry whose asset-side sum
  -- equals the payment amount (reversals carry negative amounts).
  select count(*) into v_mismatches
  from public.payments p
  left join lateral (
    select coalesce(sum(jl.debit - jl.credit), 0) as asset_movement
    from public.journal_entries je
    join public.journal_lines jl on jl.entry_id = je.id
    join public.ledger_accounts la on la.id = jl.account_id
    where je.source_id = p.id
      and je.source_type in ('payment','reversal')
      and la.code in ('1000','1010','1020')
  ) j on true
  where p.tenant_id = p_tenant_id
    and p.paid_on between p_from and p_to
    and j.asset_movement is distinct from p.amount;
  if v_mismatches > 0 then
    raise exception 'REPORT_RECONCILE_FAILED: % payments do not tie to the ledger', v_mismatches;
  end if;

  select coalesce(jsonb_agg(row order by row->>'paidOn', row->>'receiptNumber'), '[]'::jsonb),
         coalesce(sum((row->>'amount')::numeric), 0)
    into v_rows, v_total
  from (
    select jsonb_build_object(
      'receiptNumber', p.receipt_number,
      'paidOn', p.paid_on,
      'studentNumber', s.student_number,
      'studentName', s.first_name || ' ' || s.last_name,
      'invoiceNumber', i.invoice_number,
      'method', p.method,
      'reference', p.reference,
      'amount', p.amount,
      'isReversal', p.reverses_payment_id is not null
    ) as row
    from public.payments p
    join public.students s on s.id = p.student_id
    join public.invoices i on i.id = p.invoice_id
    where p.tenant_id = p_tenant_id
      and p.paid_on between p_from and p_to
  ) x;

  select coalesce(jsonb_object_agg(method, total), '{}'::jsonb) into v_by_method
  from (
    select method, sum(amount) as total
    from public.payments
    where tenant_id = p_tenant_id and paid_on between p_from and p_to
    group by method
  ) m;

  return jsonb_build_object(
    'rows', v_rows,
    'totals', jsonb_build_object('total', v_total, 'byMethod', v_by_method),
    'filters', jsonb_build_object('from', p_from, 'to', p_to),
    'generatedAt', now()
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Outstanding balances per student. Grand total must equal the A/R ledger
-- balance (account 1100) — the definition of "the report ties to the books".
-- ---------------------------------------------------------------------------
create or replace function app.report_outstanding_balances(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
  v_outstanding numeric;
  v_gross numeric;
  v_ar numeric;
begin
  select coalesce(sum(jl.debit - jl.credit), 0) into v_ar
  from public.journal_lines jl
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.tenant_id = p_tenant_id and la.code = '1100';

  select coalesce(sum(x.invoiced - x.paid), 0) into v_gross
  from (
    select i.id, i.total as invoiced,
           coalesce((select sum(p.amount) from public.payments p where p.invoice_id = i.id), 0) as paid
    from public.invoices i
    where i.tenant_id = p_tenant_id
  ) x;
  if v_gross is distinct from v_ar then
    raise exception 'REPORT_RECONCILE_FAILED: receivables % do not equal A/R ledger %', v_gross, v_ar;
  end if;

  select coalesce(jsonb_agg(row order by (row->>'balance')::numeric desc), '[]'::jsonb),
         coalesce(sum((row->>'balance')::numeric), 0)
    into v_rows, v_outstanding
  from (
    select jsonb_build_object(
      'studentNumber', s.student_number,
      'studentName', s.first_name || ' ' || s.last_name,
      'className', coalesce(gl.name || ' ' || cs.stream, '—'),
      'invoiced', agg.invoiced,
      'paid', agg.paid,
      'balance', agg.invoiced - agg.paid
    ) as row
    from (
      select i.student_id,
             sum(i.total) as invoiced,
             coalesce(sum((select sum(p.amount) from public.payments p where p.invoice_id = i.id)), 0) as paid
      from public.invoices i
      where i.tenant_id = p_tenant_id
      group by i.student_id
    ) agg
    join public.students s on s.id = agg.student_id
    left join public.class_enrolments ce
      on ce.student_id = s.id and ce.status = 'active'
    left join public.class_sections cs on cs.id = ce.class_section_id
    left join public.grade_levels gl on gl.id = cs.grade_level_id
    where agg.invoiced - agg.paid > 0
  ) x;

  return jsonb_build_object(
    'rows', v_rows,
    'totals', jsonb_build_object('outstanding', v_outstanding, 'ledgerAR', v_ar),
    'generatedAt', now()
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Trial balance. Total debits must equal total credits, or no report.
-- ---------------------------------------------------------------------------
create or replace function app.report_trial_balance(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
  v_debits numeric;
  v_credits numeric;
begin
  select coalesce(sum(jl.debit), 0), coalesce(sum(jl.credit), 0)
    into v_debits, v_credits
  from public.journal_lines jl
  where jl.tenant_id = p_tenant_id;
  if v_debits <> v_credits then
    raise exception 'REPORT_RECONCILE_FAILED: debits % <> credits %', v_debits, v_credits;
  end if;

  select coalesce(jsonb_agg(row order by row->>'code'), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object(
      'code', la.code, 'name', la.name, 'type', la.type,
      'debits', coalesce(sum(jl.debit), 0),
      'credits', coalesce(sum(jl.credit), 0),
      'balance', coalesce(sum(jl.debit - jl.credit), 0)
    ) as row
    from public.ledger_accounts la
    left join public.journal_lines jl on jl.account_id = la.id
    where la.tenant_id = p_tenant_id
    group by la.id, la.code, la.name, la.type
  ) x;

  return jsonb_build_object(
    'rows', v_rows,
    'totals', jsonb_build_object('debits', v_debits, 'credits', v_credits),
    'generatedAt', now()
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Student statement: chronological charges/payments with running balance.
-- Closing balance must equal invoiced − paid for the student.
-- ---------------------------------------------------------------------------
create or replace function app.report_student_statement(
  p_tenant_id uuid, p_student_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student public.students%rowtype;
  v_rows jsonb := '[]'::jsonb;
  v_balance numeric := 0;
  v_expected numeric;
  v_line record;
begin
  select * into v_student from public.students
  where id = p_student_id and tenant_id = p_tenant_id;
  if v_student.id is null then
    raise exception 'REPORT_STUDENT_NOT_FOUND';
  end if;

  for v_line in
    select * from (
      select i.issued_on as on_date, i.created_at, 'invoice' as kind,
             i.invoice_number as ref, i.total as charge, 0::numeric as credit
      from public.invoices i
      where i.tenant_id = p_tenant_id and i.student_id = p_student_id
      union all
      select p.paid_on, p.created_at,
             case when p.reverses_payment_id is null then 'payment' else 'reversal' end,
             p.receipt_number, 0::numeric, p.amount
      from public.payments p
      where p.tenant_id = p_tenant_id and p.student_id = p_student_id
    ) e
    order by e.on_date, e.created_at
  loop
    v_balance := v_balance + v_line.charge - v_line.credit;
    v_rows := v_rows || jsonb_build_object(
      'date', v_line.on_date, 'kind', v_line.kind, 'reference', v_line.ref,
      'charge', v_line.charge, 'credit', v_line.credit, 'balance', v_balance
    );
  end loop;

  select coalesce(sum(i.total), 0)
       - coalesce((select sum(p.amount) from public.payments p
                   where p.tenant_id = p_tenant_id and p.student_id = p_student_id), 0)
    into v_expected
  from public.invoices i
  where i.tenant_id = p_tenant_id and i.student_id = p_student_id;
  if v_balance is distinct from v_expected then
    raise exception 'REPORT_RECONCILE_FAILED: statement % <> receivable %', v_balance, v_expected;
  end if;

  return jsonb_build_object(
    'student', jsonb_build_object(
      'studentNumber', v_student.student_number,
      'name', v_student.first_name || ' ' || v_student.last_name
    ),
    'rows', v_rows,
    'totals', jsonb_build_object('closingBalance', v_balance),
    'generatedAt', now()
  );
end;
$$;

-- Public wrappers — service role only.
create or replace function public.report_fee_collection(p_tenant_id uuid, p_from date, p_to date)
returns jsonb language sql security definer set search_path = public
as $$ select app.report_fee_collection(p_tenant_id, p_from, p_to); $$;
create or replace function public.report_outstanding_balances(p_tenant_id uuid)
returns jsonb language sql security definer set search_path = public
as $$ select app.report_outstanding_balances(p_tenant_id); $$;
create or replace function public.report_trial_balance(p_tenant_id uuid)
returns jsonb language sql security definer set search_path = public
as $$ select app.report_trial_balance(p_tenant_id); $$;
create or replace function public.report_student_statement(p_tenant_id uuid, p_student_id uuid)
returns jsonb language sql security definer set search_path = public
as $$ select app.report_student_statement(p_tenant_id, p_student_id); $$;

revoke execute on function app.report_fee_collection(uuid, date, date) from public, anon, authenticated;
revoke execute on function app.report_outstanding_balances(uuid) from public, anon, authenticated;
revoke execute on function app.report_trial_balance(uuid) from public, anon, authenticated;
revoke execute on function app.report_student_statement(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.report_fee_collection(uuid, date, date) from public, anon, authenticated;
revoke execute on function public.report_outstanding_balances(uuid) from public, anon, authenticated;
revoke execute on function public.report_trial_balance(uuid) from public, anon, authenticated;
revoke execute on function public.report_student_statement(uuid, uuid) from public, anon, authenticated;
grant execute on function public.report_fee_collection(uuid, date, date) to service_role;
grant execute on function public.report_outstanding_balances(uuid) to service_role;
grant execute on function public.report_trial_balance(uuid) to service_role;
grant execute on function public.report_student_statement(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Permission: report generation for administrative + finance roles.
-- Financial report keys additionally require finance.reports.view (API-side).
-- ---------------------------------------------------------------------------
insert into public.role_permissions (role_id, permission_key)
select r.id, 'reports.generate'
from public.roles r
where r.tenant_id is null and r.is_system
  and r.key in ('head_teacher','school_admin','academic_master','bursar','accountant')
on conflict do nothing;
