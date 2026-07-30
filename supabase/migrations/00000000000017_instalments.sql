-- ATLAS migration 0017 — fee instalments + debtors (wadaiwa) report.
--
-- invoice_instalments is a payment PLAN over an invoice, not a financial
-- record: payments stay on the invoice (migration 0007) and "paid so far"
-- waterfalls across instalments by seq at display time. The schedule is
-- replaceable while the invoice is unpaid; all writes go through
-- app.set_invoice_instalments. The debtors report reconciles to the A/R
-- ledger exactly like migration 0012's outstanding-balances report and
-- raises REPORT_RECONCILE_FAILED on any mismatch.

-- ---------------------------------------------------------------------------
-- Instalment schedule
-- ---------------------------------------------------------------------------
create table public.invoice_instalments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  invoice_id uuid not null references public.invoices(id),
  seq int not null check (seq >= 1),
  amount numeric(12,2) not null check (amount > 0),
  due_on date not null,
  created_at timestamptz not null default now(),
  unique (invoice_id, seq)
);
create index invoice_instalments_tenant_idx
  on public.invoice_instalments (tenant_id);
create index invoice_instalments_invoice_idx
  on public.invoice_instalments (invoice_id, seq);

alter table public.invoice_instalments enable row level security;
create policy "members read invoice instalments" on public.invoice_instalments
  for select using (app.is_tenant_member(tenant_id));

-- ---------------------------------------------------------------------------
-- Replace the instalment schedule for one invoice.
-- p_rows: [{ "amount", "dueOn" }] in instalment order (seq 1..n, max 6).
-- Validates: invoice belongs to the tenant and is not fully paid, amounts sum
-- to the invoice total exactly, due dates strictly ascending.
-- ---------------------------------------------------------------------------
create or replace function app.set_invoice_instalments(
  p_tenant_id uuid, p_actor uuid, p_invoice_id uuid, p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices%rowtype;
  v_count int;
  v_row jsonb;
  v_seq int := 0;
  v_amount numeric;
  v_due date;
  v_prev date;
  v_sum numeric := 0;
begin
  select * into v_invoice from public.invoices
  where id = p_invoice_id and tenant_id = p_tenant_id
  for update;
  if v_invoice.id is null then
    raise exception 'INSTALMENTS_INVOICE_NOT_FOUND';
  end if;
  if v_invoice.status = 'paid' then
    raise exception 'INSTALMENTS_INVOICE_PAID';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'INSTALMENTS_BAD_ROWS';
  end if;
  v_count := jsonb_array_length(p_rows);
  if v_count < 1 or v_count > 6 then
    raise exception 'INSTALMENTS_BAD_ROWS: between 1 and 6 instalments';
  end if;

  -- Replace the plan (the plan is not a financial record; the ledger and
  -- payments are untouched).
  delete from public.invoice_instalments
  where invoice_id = p_invoice_id and tenant_id = p_tenant_id;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_seq := v_seq + 1;
    -- Round to the stored scale (numeric(12,2)) BEFORE summing/validating, so
    -- the sum check compares the values that will actually persist — a sub-cent
    -- input can no longer store a schedule that doesn't add up to the total.
    v_amount := round((v_row->>'amount')::numeric, 2);
    v_due := (v_row->>'dueOn')::date;
    if v_amount is null or v_amount <= 0 or v_due is null then
      raise exception 'INSTALMENTS_BAD_ROWS: instalment % needs amount > 0 and dueOn', v_seq;
    end if;
    if v_prev is not null and v_due <= v_prev then
      raise exception 'INSTALMENTS_DATES_INVALID: due dates must be strictly ascending';
    end if;
    v_prev := v_due;
    v_sum := v_sum + v_amount;
    insert into public.invoice_instalments (tenant_id, invoice_id, seq, amount, due_on)
    values (p_tenant_id, p_invoice_id, v_seq, v_amount, v_due);
  end loop;

  if v_sum <> v_invoice.total then
    raise exception 'INSTALMENTS_SUM_MISMATCH: instalments % <> invoice total %',
      v_sum, v_invoice.total;
  end if;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'finance.instalments_set', 'invoice', p_invoice_id::text,
          jsonb_build_object('invoice', v_invoice.invoice_number,
                             'instalments', v_count, 'total', v_sum));

  return jsonb_build_object('invoiceId', p_invoice_id,
                            'instalments', v_count, 'total', v_sum);
end;
$$;

-- ---------------------------------------------------------------------------
-- Debtors (wadaiwa) report: one row per unpaid invoice with student,
-- admission number, primary guardian phone, class section, paid (net of
-- reversals), balance and the overdue amount as of p_as_of.
--
-- Overdue: with a schedule, sum of instalment amounts due on/before p_as_of
-- minus paid, floored at 0 (payments waterfall across instalments). Without
-- a schedule, the full balance once invoices.due_on has passed (invoices
-- with no schedule and no due date are outstanding but not overdue).
--
-- Reconciliation (same approach as app.report_outstanding_balances, 0012):
-- receivables across all invoices AND the sum of row balances must both
-- equal the A/R ledger balance (account 1100) or no report is produced.
-- ---------------------------------------------------------------------------
create or replace function app.report_debtors(p_tenant_id uuid, p_as_of date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
  v_outstanding numeric;
  v_overdue numeric;
  v_gross numeric;
  v_ar numeric;
begin
  if p_as_of is null then
    raise exception 'REPORT_BAD_DATE';
  end if;

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

  select coalesce(jsonb_agg(row order by row->>'className', row->>'studentName', row->>'invoiceNumber'), '[]'::jsonb),
         coalesce(sum((row->>'balance')::numeric), 0),
         coalesce(sum((row->>'overdue')::numeric), 0)
    into v_rows, v_outstanding, v_overdue
  from (
    select jsonb_build_object(
      'studentNumber', s.student_number,
      'studentName', s.first_name || ' ' || s.last_name,
      'className', coalesce(en.class_name, '—'),
      'guardianPhone', pg.phone,
      'invoiceNumber', inv.invoice_number,
      'total', inv.total,
      'paid', inv.paid,
      'balance', inv.total - inv.paid,
      'overdue', case
        when inv.has_schedule then greatest(inv.due_by_asof - inv.paid, 0)
        when inv.due_on is not null and inv.due_on <= p_as_of then inv.total - inv.paid
        else 0
      end
    ) as row
    from (
      select i.id, i.invoice_number, i.student_id, i.total, i.due_on,
             coalesce((select sum(p.amount) from public.payments p
                       where p.invoice_id = i.id), 0) as paid,
             coalesce((select sum(ii.amount) from public.invoice_instalments ii
                       where ii.invoice_id = i.id and ii.due_on <= p_as_of), 0) as due_by_asof,
             exists (select 1 from public.invoice_instalments ii
                     where ii.invoice_id = i.id) as has_schedule
      from public.invoices i
      where i.tenant_id = p_tenant_id
    ) inv
    join public.students s on s.id = inv.student_id
    left join lateral (
      select gl.name || ' ' || cs.name as class_name
      from public.class_enrolments ce
      join public.class_sections cs on cs.id = ce.class_section_id
      join public.grade_levels gl on gl.id = cs.grade_level_id
      where ce.student_id = s.id and ce.status = 'active'
      limit 1
    ) en on true
    left join lateral (
      select g.phone
      from public.student_guardians sg
      join public.guardians g on g.id = sg.guardian_id
      where sg.student_id = s.id and sg.is_primary
      limit 1
    ) pg on true
    where inv.total - inv.paid > 0
  ) x;

  if v_outstanding is distinct from v_ar then
    raise exception 'REPORT_RECONCILE_FAILED: debtor balances % do not equal A/R ledger %', v_outstanding, v_ar;
  end if;

  return jsonb_build_object(
    'rows', v_rows,
    'totals', jsonb_build_object('outstanding', v_outstanding,
                                 'overdue', v_overdue, 'ledgerAR', v_ar),
    'filters', jsonb_build_object('asOf', p_as_of),
    'generatedAt', now()
  );
end;
$$;

-- Public wrappers — service role only.
create or replace function public.set_invoice_instalments(
  p_tenant_id uuid, p_actor uuid, p_invoice_id uuid, p_rows jsonb
)
returns jsonb language sql security definer set search_path = public
as $$ select app.set_invoice_instalments(p_tenant_id, p_actor, p_invoice_id, p_rows); $$;

create or replace function public.report_debtors(p_tenant_id uuid, p_as_of date)
returns jsonb language sql security definer set search_path = public
as $$ select app.report_debtors(p_tenant_id, p_as_of); $$;

revoke execute on function app.set_invoice_instalments(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function app.report_debtors(uuid, date) from public, anon, authenticated;
revoke execute on function public.set_invoice_instalments(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.report_debtors(uuid, date) from public, anon, authenticated;
grant execute on function public.set_invoice_instalments(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.report_debtors(uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- Permission (BEFORE role_permissions — FK; mirror in seed.sql).
-- Instalment setting reuses finance.invoices.create.
-- ---------------------------------------------------------------------------
insert into public.permissions (key, description, module)
values ('finance.debtors.view', 'View debtors and instalment schedules', 'finance')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'finance.debtors.view'
from public.roles r
where r.tenant_id is null and r.is_system
  and r.key in ('bursar', 'accountant', 'head_teacher', 'school_admin')
on conflict do nothing;
