-- ATLAS migration 0007 — fees, invoices, payments, double-entry ledger.
--
-- Iron rules: financial records are NEVER edited or deleted — corrections are
-- reversals (a payment reversal is a new negative payment row plus a reversing
-- journal entry). Every invoice/payment/reversal posts a balanced journal
-- entry (sum of debits = sum of credits, enforced in the RPCs).
--
-- Tanzania-first: amounts in TZS, payment methods include the mobile-money
-- rails schools actually use (M-Pesa, Tigo Pesa, Airtel Money, HaloPesa).

-- ---------------------------------------------------------------------------
-- Fee catalogue
-- ---------------------------------------------------------------------------
create table public.fee_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  academic_year_id uuid not null references public.academic_years(id),
  -- null grade/term = applies to the whole school / whole year
  grade_level_id uuid references public.grade_levels(id),
  academic_term_id uuid references public.academic_terms(id),
  name text not null,
  amount numeric(12,2) not null check (amount > 0),
  currency text not null default 'TZS',
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  unique (tenant_id, academic_year_id, name)
);
create index fee_items_tenant_idx on public.fee_items (tenant_id, status);

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  student_id uuid not null references public.students(id),
  academic_year_id uuid not null references public.academic_years(id),
  academic_term_id uuid references public.academic_terms(id),
  invoice_number text not null,
  currency text not null default 'TZS',
  total numeric(12,2) not null check (total > 0),
  -- derived state (recomputed by RPCs); the financial facts live in the
  -- lines, payments and journal
  status text not null default 'issued'
    check (status in ('issued','partially_paid','paid')),
  issued_on date not null default current_date,
  due_on date,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, invoice_number)
);
create index invoices_tenant_idx on public.invoices (tenant_id, status);
create index invoices_student_idx on public.invoices (student_id);
create trigger invoices_updated_at before update on public.invoices
  for each row execute function app.set_updated_at();

create table public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  invoice_id uuid not null references public.invoices(id),
  fee_item_id uuid references public.fee_items(id),
  description text not null,
  amount numeric(12,2) not null check (amount > 0),
  created_at timestamptz not null default now()
);
create index invoice_lines_invoice_idx on public.invoice_lines (invoice_id);

-- ---------------------------------------------------------------------------
-- Payments — immutable. A reversal is a new row with negative amount and
-- reverses_payment_id set; each payment can be reversed at most once.
-- ---------------------------------------------------------------------------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  invoice_id uuid not null references public.invoices(id),
  student_id uuid not null references public.students(id),
  receipt_number text not null,
  amount numeric(12,2) not null check (amount <> 0),
  method text not null check (method in
    ('cash','mpesa','tigopesa','airtel_money','halopesa','bank','cheque','other')),
  reference text,
  note text,
  paid_on date not null default current_date,
  reverses_payment_id uuid references public.payments(id),
  received_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, receipt_number),
  check ((reverses_payment_id is null and amount > 0)
      or (reverses_payment_id is not null and amount < 0))
);
create unique index payments_one_reversal_idx
  on public.payments (reverses_payment_id) where reverses_payment_id is not null;
create index payments_tenant_idx on public.payments (tenant_id);
create index payments_invoice_idx on public.payments (invoice_id);

-- ---------------------------------------------------------------------------
-- Double-entry ledger
-- ---------------------------------------------------------------------------
create table public.ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  code text not null,
  name text not null,
  type text not null check (type in ('asset','liability','equity','income','expense')),
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create table public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  entry_number text not null,
  entry_date date not null default current_date,
  description text not null,
  source_type text not null check (source_type in ('invoice','payment','reversal')),
  source_id uuid not null,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, entry_number)
);
create index journal_entries_tenant_idx on public.journal_entries (tenant_id, entry_date);

create table public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  entry_id uuid not null references public.journal_entries(id),
  account_id uuid not null references public.ledger_accounts(id),
  debit numeric(12,2) not null default 0 check (debit >= 0),
  credit numeric(12,2) not null default 0 check (credit >= 0),
  check ((debit > 0 and credit = 0) or (credit > 0 and debit = 0))
);
create index journal_lines_entry_idx on public.journal_lines (entry_id);
create index journal_lines_account_idx on public.journal_lines (account_id);

-- RLS: members read; all writes via API RPCs (service role).
alter table public.fee_items enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_lines enable row level security;
alter table public.payments enable row level security;
alter table public.ledger_accounts enable row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_lines enable row level security;

create policy "members read fee items" on public.fee_items
  for select using (app.is_tenant_member(tenant_id));
create policy "members read invoices" on public.invoices
  for select using (app.is_tenant_member(tenant_id));
create policy "members read invoice lines" on public.invoice_lines
  for select using (app.is_tenant_member(tenant_id));
create policy "members read payments" on public.payments
  for select using (app.is_tenant_member(tenant_id));
create policy "members read ledger accounts" on public.ledger_accounts
  for select using (app.is_tenant_member(tenant_id));
create policy "members read journal entries" on public.journal_entries
  for select using (app.is_tenant_member(tenant_id));
create policy "members read journal lines" on public.journal_lines
  for select using (app.is_tenant_member(tenant_id));

-- ---------------------------------------------------------------------------
-- Minimal chart of accounts, created lazily per tenant
-- ---------------------------------------------------------------------------
create or replace function app.ensure_ledger_accounts(p_tenant_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.ledger_accounts (tenant_id, code, name, type) values
    (p_tenant_id, '1000', 'Cash',                'asset'),
    (p_tenant_id, '1010', 'Mobile Money',        'asset'),
    (p_tenant_id, '1020', 'Bank',                'asset'),
    (p_tenant_id, '1100', 'Accounts Receivable', 'asset'),
    (p_tenant_id, '4000', 'Fee Income',          'income')
  on conflict (tenant_id, code) do nothing;
$$;

create or replace function app.account_for_method(p_method text)
returns text
language sql
immutable
as $$
  select case
    when p_method = 'cash' then '1000'
    when p_method in ('mpesa','tigopesa','airtel_money','halopesa') then '1010'
    else '1020'
  end;
$$;

-- Balanced journal posting. p_lines: [{ "code", "debit", "credit" }]
create or replace function app.post_journal(
  p_tenant_id uuid, p_actor uuid, p_description text,
  p_source_type text, p_source_id uuid, p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry_id uuid;
  v_debits numeric;
  v_credits numeric;
begin
  select sum((l->>'debit')::numeric), sum((l->>'credit')::numeric)
    into v_debits, v_credits
  from jsonb_array_elements(p_lines) l;
  if v_debits is null or v_debits <> v_credits or v_debits <= 0 then
    raise exception 'LEDGER_UNBALANCED_ENTRY';
  end if;

  insert into public.journal_entries
    (tenant_id, entry_number, description, source_type, source_id, created_by)
  values (p_tenant_id,
          'JE-' || lpad(app.next_counter(p_tenant_id, 'journal_entry')::text, 6, '0'),
          p_description, p_source_type, p_source_id, p_actor)
  returning id into v_entry_id;

  insert into public.journal_lines (tenant_id, entry_id, account_id, debit, credit)
  select p_tenant_id, v_entry_id, a.id,
         coalesce((l->>'debit')::numeric, 0), coalesce((l->>'credit')::numeric, 0)
  from jsonb_array_elements(p_lines) l
  join public.ledger_accounts a
    on a.tenant_id = p_tenant_id and a.code = l->>'code';

  if (select count(*) from public.journal_lines where entry_id = v_entry_id)
     <> jsonb_array_length(p_lines) then
    raise exception 'LEDGER_UNKNOWN_ACCOUNT';
  end if;

  return v_entry_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Invoice creation. p_lines: [{ "feeItemId" } | { "description", "amount" }]
-- Posts: debit Accounts Receivable / credit Fee Income.
-- ---------------------------------------------------------------------------
create or replace function app.create_invoice(
  p_tenant_id uuid, p_actor uuid, p_student_id uuid,
  p_term_id uuid, p_due_on date, p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year_id uuid;
  v_invoice_id uuid;
  v_number text;
  v_line jsonb;
  v_fee public.fee_items%rowtype;
  v_total numeric := 0;
  v_desc text;
  v_amount numeric;
  v_resolved jsonb := '[]'::jsonb;
begin
  if not exists (
    select 1 from public.students where id = p_student_id and tenant_id = p_tenant_id
  ) then
    raise exception 'INVOICE_STUDENT_NOT_FOUND';
  end if;

  if p_term_id is not null then
    select academic_year_id into v_year_id from public.academic_terms
    where id = p_term_id and tenant_id = p_tenant_id;
    if v_year_id is null then
      raise exception 'INVOICE_TERM_NOT_FOUND';
    end if;
  else
    select id into v_year_id from public.academic_years
    where tenant_id = p_tenant_id and status = 'active'
    order by starts_on desc limit 1;
    if v_year_id is null then
      raise exception 'INVOICE_NO_ACTIVE_YEAR';
    end if;
  end if;

  -- resolve lines (fee items by id, or ad-hoc description+amount)
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    if v_line ? 'feeItemId' then
      select * into v_fee from public.fee_items
      where id = (v_line->>'feeItemId')::uuid
        and tenant_id = p_tenant_id and status = 'active';
      if v_fee.id is null then
        raise exception 'INVOICE_FEE_ITEM_NOT_FOUND';
      end if;
      v_desc := v_fee.name;
      v_amount := v_fee.amount;
    else
      v_desc := v_line->>'description';
      v_amount := (v_line->>'amount')::numeric;
      if v_desc is null or v_amount is null or v_amount <= 0 then
        raise exception 'INVOICE_BAD_LINE';
      end if;
      v_fee := null;
    end if;
    v_total := v_total + v_amount;
    v_resolved := v_resolved || jsonb_build_object(
      'feeItemId', v_fee.id, 'description', v_desc, 'amount', v_amount);
  end loop;

  if v_total <= 0 then
    raise exception 'INVOICE_EMPTY';
  end if;

  v_number := 'INV-' || lpad(app.next_counter(p_tenant_id, 'invoice_number')::text, 5, '0');

  insert into public.invoices
    (tenant_id, student_id, academic_year_id, academic_term_id,
     invoice_number, total, due_on, created_by)
  values (p_tenant_id, p_student_id, v_year_id, p_term_id,
          v_number, v_total, p_due_on, p_actor)
  returning id into v_invoice_id;

  insert into public.invoice_lines (tenant_id, invoice_id, fee_item_id, description, amount)
  select p_tenant_id, v_invoice_id, (l->>'feeItemId')::uuid, l->>'description', (l->>'amount')::numeric
  from jsonb_array_elements(v_resolved) l;

  perform app.ensure_ledger_accounts(p_tenant_id);
  perform app.post_journal(p_tenant_id, p_actor,
    'Invoice ' || v_number, 'invoice', v_invoice_id,
    jsonb_build_array(
      jsonb_build_object('code','1100','debit', v_total, 'credit', 0),
      jsonb_build_object('code','4000','debit', 0, 'credit', v_total)
    ));

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'finance.invoice_created', 'invoice', v_invoice_id::text,
          jsonb_build_object('number', v_number, 'total', v_total, 'studentId', p_student_id));

  return jsonb_build_object('invoiceId', v_invoice_id, 'invoiceNumber', v_number, 'total', v_total);
end;
$$;

-- ---------------------------------------------------------------------------
-- Payment recording. Posts: debit Cash/Mobile Money/Bank, credit A/R.
-- ---------------------------------------------------------------------------
create or replace function app.record_payment(
  p_tenant_id uuid, p_actor uuid, p_invoice_id uuid,
  p_amount numeric, p_method text, p_reference text, p_paid_on date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices%rowtype;
  v_paid numeric;
  v_balance numeric;
  v_payment_id uuid;
  v_receipt text;
begin
  select * into v_invoice from public.invoices
  where id = p_invoice_id and tenant_id = p_tenant_id
  for update;
  if v_invoice.id is null then
    raise exception 'PAYMENT_INVOICE_NOT_FOUND';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'PAYMENT_BAD_AMOUNT';
  end if;

  select coalesce(sum(amount), 0) into v_paid
  from public.payments where invoice_id = p_invoice_id;
  v_balance := v_invoice.total - v_paid;
  if p_amount > v_balance then
    raise exception 'PAYMENT_EXCEEDS_BALANCE';
  end if;

  v_receipt := 'RCT-' || lpad(app.next_counter(p_tenant_id, 'receipt_number')::text, 5, '0');

  insert into public.payments
    (tenant_id, invoice_id, student_id, receipt_number, amount, method,
     reference, paid_on, received_by)
  values (p_tenant_id, p_invoice_id, v_invoice.student_id, v_receipt, p_amount,
          p_method, p_reference, coalesce(p_paid_on, current_date), p_actor)
  returning id into v_payment_id;

  perform app.ensure_ledger_accounts(p_tenant_id);
  perform app.post_journal(p_tenant_id, p_actor,
    'Receipt ' || v_receipt || ' for ' || v_invoice.invoice_number, 'payment', v_payment_id,
    jsonb_build_array(
      jsonb_build_object('code', app.account_for_method(p_method), 'debit', p_amount, 'credit', 0),
      jsonb_build_object('code','1100','debit', 0, 'credit', p_amount)
    ));

  update public.invoices
  set status = case when v_paid + p_amount >= total then 'paid' else 'partially_paid' end
  where id = p_invoice_id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'finance.payment_received', 'payment', v_payment_id::text,
          jsonb_build_object('receipt', v_receipt, 'amount', p_amount, 'method', p_method,
                             'invoice', v_invoice.invoice_number));

  return jsonb_build_object('paymentId', v_payment_id, 'receiptNumber', v_receipt,
                            'balance', v_balance - p_amount);
end;
$$;

-- ---------------------------------------------------------------------------
-- Payment reversal — a NEW negative payment row + reversing journal entry.
-- ---------------------------------------------------------------------------
create or replace function app.reverse_payment(
  p_tenant_id uuid, p_actor uuid, p_payment_id uuid, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments%rowtype;
  v_invoice public.invoices%rowtype;
  v_reversal_id uuid;
  v_receipt text;
  v_paid numeric;
begin
  select * into v_payment from public.payments
  where id = p_payment_id and tenant_id = p_tenant_id;
  if v_payment.id is null then
    raise exception 'REVERSAL_PAYMENT_NOT_FOUND';
  end if;
  if v_payment.reverses_payment_id is not null then
    raise exception 'REVERSAL_OF_REVERSAL';
  end if;
  if exists (select 1 from public.payments where reverses_payment_id = p_payment_id) then
    raise exception 'REVERSAL_ALREADY_REVERSED';
  end if;

  select * into v_invoice from public.invoices
  where id = v_payment.invoice_id for update;

  v_receipt := 'RCT-' || lpad(app.next_counter(p_tenant_id, 'receipt_number')::text, 5, '0');

  insert into public.payments
    (tenant_id, invoice_id, student_id, receipt_number, amount, method,
     reference, note, paid_on, reverses_payment_id, received_by)
  values (p_tenant_id, v_payment.invoice_id, v_payment.student_id, v_receipt,
          -v_payment.amount, v_payment.method, v_payment.reference,
          p_reason, current_date, p_payment_id, p_actor)
  returning id into v_reversal_id;

  perform app.post_journal(p_tenant_id, p_actor,
    'Reversal of ' || v_payment.receipt_number, 'reversal', v_reversal_id,
    jsonb_build_array(
      jsonb_build_object('code','1100','debit', v_payment.amount, 'credit', 0),
      jsonb_build_object('code', app.account_for_method(v_payment.method),
                         'debit', 0, 'credit', v_payment.amount)
    ));

  select coalesce(sum(amount), 0) into v_paid
  from public.payments where invoice_id = v_payment.invoice_id;
  update public.invoices
  set status = case
    when v_paid >= total then 'paid'
    when v_paid > 0 then 'partially_paid'
    else 'issued'
  end
  where id = v_payment.invoice_id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'finance.payment_reversed', 'payment', v_reversal_id::text,
          jsonb_build_object('original', v_payment.receipt_number, 'reason', p_reason));

  return jsonb_build_object('reversalId', v_reversal_id, 'receiptNumber', v_receipt);
end;
$$;

-- Public wrappers — service role only.
create or replace function public.create_invoice(
  p_tenant_id uuid, p_actor uuid, p_student_id uuid, p_term_id uuid, p_due_on date, p_lines jsonb
)
returns jsonb language sql security definer set search_path = public
as $$ select app.create_invoice(p_tenant_id, p_actor, p_student_id, p_term_id, p_due_on, p_lines); $$;

create or replace function public.record_payment(
  p_tenant_id uuid, p_actor uuid, p_invoice_id uuid,
  p_amount numeric, p_method text, p_reference text, p_paid_on date
)
returns jsonb language sql security definer set search_path = public
as $$ select app.record_payment(p_tenant_id, p_actor, p_invoice_id, p_amount, p_method, p_reference, p_paid_on); $$;

create or replace function public.reverse_payment(
  p_tenant_id uuid, p_actor uuid, p_payment_id uuid, p_reason text
)
returns jsonb language sql security definer set search_path = public
as $$ select app.reverse_payment(p_tenant_id, p_actor, p_payment_id, p_reason); $$;

revoke execute on function app.ensure_ledger_accounts(uuid) from public, anon, authenticated;
revoke execute on function app.post_journal(uuid, uuid, text, text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function app.create_invoice(uuid, uuid, uuid, uuid, date, jsonb) from public, anon, authenticated;
revoke execute on function app.record_payment(uuid, uuid, uuid, numeric, text, text, date) from public, anon, authenticated;
revoke execute on function app.reverse_payment(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.create_invoice(uuid, uuid, uuid, uuid, date, jsonb) from public, anon, authenticated;
revoke execute on function public.record_payment(uuid, uuid, uuid, numeric, text, text, date) from public, anon, authenticated;
revoke execute on function public.reverse_payment(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_invoice(uuid, uuid, uuid, uuid, date, jsonb) to service_role;
grant execute on function public.record_payment(uuid, uuid, uuid, numeric, text, text, date) to service_role;
grant execute on function public.reverse_payment(uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Finance role permissions (idempotent; mirror in seed.sql)
-- ---------------------------------------------------------------------------
insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join lateral unnest(case r.key
  when 'bursar' then array[
    'students.view', 'finance.invoices.view', 'finance.invoices.create',
    'finance.payments.receive', 'finance.refunds.request', 'finance.refunds.approve',
    'finance.periods.lock', 'finance.reports.view']
  when 'accountant' then array[
    'students.view', 'finance.invoices.view', 'finance.invoices.create',
    'finance.payments.receive', 'finance.refunds.request', 'finance.reports.view']
  when 'cashier' then array[
    'students.view', 'finance.invoices.view', 'finance.payments.receive']
  else array[]::text[]
end) as p(key)
where r.tenant_id is null and r.is_system
on conflict do nothing;
