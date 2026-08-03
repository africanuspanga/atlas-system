-- ATLAS migration 0031 — go-live hardening for Tanzania dates, payment
-- idempotency, atomic onboarding, historical debtors, and reliable SMS claims.

begin;

-- ---------------------------------------------------------------------------
-- Tanzania operating calendar. Supabase runs PostgreSQL in UTC, but school
-- dates (admissions, attendance, receipts and journals) are EAT calendar days.
-- ---------------------------------------------------------------------------
create or replace function app.tanzania_today()
returns date
language sql
stable
set search_path = public
as $$
  select (now() at time zone 'Africa/Dar_es_Salaam')::date;
$$;

revoke execute on function app.tanzania_today() from public, anon, authenticated;
grant execute on function app.tanzania_today() to service_role;

alter table public.students
  alter column admission_date set default app.tanzania_today();
alter table public.class_enrolments
  alter column enrolled_on set default app.tanzania_today();
alter table public.invoices
  alter column issued_on set default app.tanzania_today();
alter table public.payments
  alter column paid_on set default app.tanzania_today();
alter table public.journal_entries
  alter column entry_date set default app.tanzania_today();
alter table public.library_loans
  alter column loaned_on set default app.tanzania_today();
alter table public.inventory_movements
  alter column moved_on set default app.tanzania_today();

-- Legacy functions that still use current_date execute in the school timezone.
alter function app.import_commit_chunk(uuid, uuid, uuid, int)
  set timezone = 'Africa/Dar_es_Salaam';
alter function app.return_book(uuid, uuid, uuid)
  set timezone = 'Africa/Dar_es_Salaam';
alter function app.reverse_payment(uuid, uuid, uuid, text)
  set timezone = 'Africa/Dar_es_Salaam';

-- Journal dates follow the underlying financial fact, not the UTC date on
-- which the API happened to call this helper.
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
  v_entry_date date;
  v_debits numeric;
  v_credits numeric;
begin
  select sum((l->>'debit')::numeric), sum((l->>'credit')::numeric)
    into v_debits, v_credits
  from jsonb_array_elements(p_lines) l;
  if v_debits is null or v_debits <> v_credits or v_debits <= 0 then
    raise exception 'LEDGER_UNBALANCED_ENTRY';
  end if;

  v_entry_date := case p_source_type
    when 'invoice' then (select issued_on from public.invoices where id = p_source_id)
    when 'payment' then (select paid_on from public.payments where id = p_source_id)
    when 'reversal' then (select paid_on from public.payments where id = p_source_id)
    when 'payroll' then (
      select ((period || '-01')::date + interval '1 month - 1 day')::date
      from public.payroll_runs where id = p_source_id and tenant_id = p_tenant_id
    )
    else null
  end;
  v_entry_date := coalesce(v_entry_date, app.tanzania_today());

  insert into public.journal_entries
    (tenant_id, entry_number, entry_date, description, source_type, source_id, created_by)
  values (
    p_tenant_id,
    'JE-' || lpad(app.next_counter(p_tenant_id, 'journal_entry')::text, 6, '0'),
    v_entry_date, p_description, p_source_type, p_source_id, p_actor
  )
  returning id into v_entry_id;

  insert into public.journal_lines (tenant_id, entry_id, account_id, debit, credit)
  select p_tenant_id, v_entry_id, a.id,
         coalesce((l->>'debit')::numeric, 0),
         coalesce((l->>'credit')::numeric, 0)
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
-- Retried payment submissions must return the original receipt, never post a
-- second payment. The key is caller-generated and immutable per attempt.
-- ---------------------------------------------------------------------------
alter table public.payments add column if not exists idempotency_key uuid;
create unique index if not exists payments_tenant_idempotency_idx
  on public.payments (tenant_id, idempotency_key)
  where idempotency_key is not null;

drop function if exists public.record_payment(uuid, uuid, uuid, numeric, text, text, date);
drop function if exists app.record_payment(uuid, uuid, uuid, numeric, text, text, date);

create function app.record_payment(
  p_tenant_id uuid, p_actor uuid, p_invoice_id uuid,
  p_amount numeric, p_method text, p_reference text, p_paid_on date,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices%rowtype;
  v_existing public.payments%rowtype;
  v_effective_date date := coalesce(p_paid_on, app.tanzania_today());
  v_paid numeric;
  v_balance numeric;
  v_payment_id uuid;
  v_receipt text;
begin
  if p_idempotency_key is null then
    raise exception 'PAYMENT_IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'PAYMENT_BAD_AMOUNT';
  end if;

  select * into v_invoice from public.invoices
  where id = p_invoice_id and tenant_id = p_tenant_id
  for update;
  if v_invoice.id is null then
    raise exception 'PAYMENT_INVOICE_NOT_FOUND';
  end if;
  if v_effective_date > app.tanzania_today()
     or v_effective_date < v_invoice.issued_on then
    raise exception 'PAYMENT_BAD_DATE';
  end if;

  select * into v_existing from public.payments
  where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    if v_existing.invoice_id <> p_invoice_id
       or v_existing.amount <> p_amount
       or v_existing.method <> p_method
       or coalesce(v_existing.reference, '') <> coalesce(p_reference, '')
       or v_existing.paid_on <> v_effective_date then
      raise exception 'PAYMENT_IDEMPOTENCY_CONFLICT';
    end if;
    select v_invoice.total - coalesce(sum(amount), 0) into v_balance
    from public.payments where invoice_id = p_invoice_id;
    return jsonb_build_object(
      'paymentId', v_existing.id,
      'receiptNumber', v_existing.receipt_number,
      'balance', v_balance,
      'idempotentReplay', true
    );
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
     reference, paid_on, received_by, idempotency_key)
  values (
    p_tenant_id, p_invoice_id, v_invoice.student_id, v_receipt, p_amount,
    p_method, p_reference, v_effective_date, p_actor, p_idempotency_key
  )
  returning id into v_payment_id;

  perform app.ensure_ledger_accounts(p_tenant_id);
  perform app.post_journal(
    p_tenant_id, p_actor,
    'Receipt ' || v_receipt || ' for ' || v_invoice.invoice_number,
    'payment', v_payment_id,
    jsonb_build_array(
      jsonb_build_object('code', app.account_for_method(p_method), 'debit', p_amount, 'credit', 0),
      jsonb_build_object('code', '1100', 'debit', 0, 'credit', p_amount)
    )
  );

  update public.invoices
  set status = case when v_paid + p_amount >= total then 'paid' else 'partially_paid' end
  where id = p_invoice_id;

  insert into public.audit_logs
    (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (
    p_tenant_id, p_actor, 'finance.payment_received', 'payment', v_payment_id::text,
    jsonb_build_object(
      'receipt', v_receipt, 'amount', p_amount, 'method', p_method,
      'invoice', v_invoice.invoice_number, 'paidOn', v_effective_date,
      'idempotencyKey', p_idempotency_key
    )
  );

  return jsonb_build_object(
    'paymentId', v_payment_id, 'receiptNumber', v_receipt,
    'balance', v_balance - p_amount, 'idempotentReplay', false
  );
end;
$$;

create function public.record_payment(
  p_tenant_id uuid, p_actor uuid, p_invoice_id uuid,
  p_amount numeric, p_method text, p_reference text, p_paid_on date,
  p_idempotency_key uuid
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select app.record_payment(
    p_tenant_id, p_actor, p_invoice_id, p_amount, p_method, p_reference,
    p_paid_on, p_idempotency_key
  );
$$;

revoke execute on function app.record_payment(uuid, uuid, uuid, numeric, text, text, date, uuid)
  from public, anon, authenticated;
revoke execute on function public.record_payment(uuid, uuid, uuid, numeric, text, text, date, uuid)
  from public, anon, authenticated;
grant execute on function public.record_payment(uuid, uuid, uuid, numeric, text, text, date, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- Tenant provisioning and the trial subscription are one database transaction.
-- Any failure rolls the tenant, membership, academic structure and slug back.
-- ---------------------------------------------------------------------------
create or replace function app.onboard_school_with_trial(
  p_user_id uuid, p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_plan_id uuid;
begin
  select id into v_plan_id from public.plans
  where key = 'trial' and is_active = true;
  if v_plan_id is null then
    raise exception 'ONBOARDING_TRIAL_PLAN_MISSING';
  end if;

  v_result := app.onboard_school(p_user_id, p_payload);
  insert into public.subscriptions
    (tenant_id, plan_id, status, trial_ends_at)
  values (
    (v_result->>'tenantId')::uuid,
    v_plan_id,
    'trialing',
    now() + interval '30 days'
  );
  return v_result;
end;
$$;

create or replace function public.onboard_school_with_trial(
  p_user_id uuid, p_payload jsonb
)
returns jsonb
language sql
security definer
set search_path = public
as $$ select app.onboard_school_with_trial(p_user_id, p_payload); $$;

revoke execute on function app.onboard_school_with_trial(uuid, jsonb)
  from public, anon, authenticated;
revoke execute on function public.onboard_school_with_trial(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.onboard_school_with_trial(uuid, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Historical debtors must ignore invoices, payments and journals after p_as_of.
-- A balance becomes overdue only after its due date has passed.
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
  if p_as_of is null then raise exception 'REPORT_BAD_DATE'; end if;

  select coalesce(sum(jl.debit - jl.credit), 0) into v_ar
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.tenant_id = p_tenant_id and la.code = '1100'
    and je.entry_date <= p_as_of;

  select coalesce(sum(x.invoiced - x.paid), 0) into v_gross
  from (
    select i.id, i.total as invoiced,
      coalesce((
        select sum(p.amount) from public.payments p
        where p.invoice_id = i.id and p.paid_on <= p_as_of
      ), 0) as paid
    from public.invoices i
    where i.tenant_id = p_tenant_id and i.issued_on <= p_as_of
  ) x;
  if v_gross is distinct from v_ar then
    raise exception 'REPORT_RECONCILE_FAILED: receivables % do not equal A/R ledger %', v_gross, v_ar;
  end if;

  select
    coalesce(jsonb_agg(row order by row->>'className', row->>'studentName', row->>'invoiceNumber'), '[]'::jsonb),
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
        when inv.has_schedule then greatest(inv.due_before_asof - inv.paid, 0)
        when inv.due_on is not null and inv.due_on < p_as_of then inv.total - inv.paid
        else 0
      end
    ) as row
    from (
      select i.id, i.invoice_number, i.student_id, i.total, i.due_on,
        coalesce((
          select sum(p.amount) from public.payments p
          where p.invoice_id = i.id and p.paid_on <= p_as_of
        ), 0) as paid,
        coalesce((
          select sum(ii.amount) from public.invoice_instalments ii
          where ii.invoice_id = i.id and ii.due_on < p_as_of
        ), 0) as due_before_asof,
        exists (
          select 1 from public.invoice_instalments ii where ii.invoice_id = i.id
        ) as has_schedule
      from public.invoices i
      where i.tenant_id = p_tenant_id and i.issued_on <= p_as_of
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
    'totals', jsonb_build_object(
      'outstanding', v_outstanding, 'overdue', v_overdue, 'ledgerAR', v_ar
    ),
    'filters', jsonb_build_object('asOf', p_as_of),
    'generatedAt', now()
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Reliable notification claim. pending → sending is atomic, the monthly plan
-- cap is checked under a per-tenant advisory lock, and stale claims can recover.
-- ---------------------------------------------------------------------------
alter table public.notification_outbox
  drop constraint if exists notification_outbox_status_check;
alter table public.notification_outbox
  add constraint notification_outbox_status_check
  check (status in ('pending', 'sending', 'sent', 'failed'));
alter table public.notification_outbox
  add column if not exists claimed_at timestamptz,
  add column if not exists last_error text;
create index if not exists notification_outbox_stale_claim_idx
  on public.notification_outbox (claimed_at)
  where status = 'sending';

create or replace function app.claim_notification(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.notification_outbox%rowtype;
  v_limit int;
  v_sent int;
begin
  select o.* into v_row
  from public.notification_outbox o
  join public.tenants t on t.id = o.tenant_id
  where o.id = p_id
    and o.status = 'pending'
    and o.next_attempt_at <= now()
    and t.status in ('configuration', 'data_review', 'training', 'live')
  for update of o;
  if v_row.id is null then
    return jsonb_build_object('status', 'unavailable');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_row.tenant_id::text, 0));
  v_limit := (app.tenant_entitlements(v_row.tenant_id)->'limits'->>'smsMonthly')::int;
  if v_limit is not null then
    select count(*) into v_sent
    from public.notification_outbox
    where tenant_id = v_row.tenant_id and status = 'sent'
      and sent_at >= (
        date_trunc('month', now() at time zone 'Africa/Dar_es_Salaam')
        at time zone 'Africa/Dar_es_Salaam'
      );
    if v_sent >= v_limit then
      update public.notification_outbox
      set status = 'failed', last_error = 'SMS_PLAN_LIMIT_REACHED'
      where id = v_row.id;
      return jsonb_build_object('status', 'limit');
    end if;
  end if;

  update public.notification_outbox
  set status = 'sending', attempts = attempts + 1, claimed_at = now(),
      last_error = null
  where id = v_row.id;
  return jsonb_build_object(
    'status', 'claimed', 'id', v_row.id, 'tenantId', v_row.tenant_id,
    'recipient', v_row.recipient, 'template', v_row.template,
    'payload', v_row.payload, 'attempts', v_row.attempts + 1
  );
end;
$$;

create or replace function public.claim_notification(p_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$ select app.claim_notification(p_id); $$;
revoke execute on function app.claim_notification(uuid) from public, anon, authenticated;
revoke execute on function public.claim_notification(uuid) from public, anon, authenticated;
grant execute on function public.claim_notification(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Payroll cannot run on unreviewed statutory settings. Editing previously
-- verified rates without re-verifying them clears the old attestation.
-- Employer-side NSSF/WCF/SDL is a real school expense and liability, so post
-- it to the ledger when a run moves from draft to posted.
-- ---------------------------------------------------------------------------
create or replace function app.validate_payroll_rates()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_bands jsonb := new.rates->'paye_bands';
  v_band jsonb;
  v_count int;
  v_index int := 0;
  v_previous numeric := -1;
  v_upper numeric;
  v_rate numeric;
begin
  if new.rates is null or jsonb_typeof(v_bands) <> 'array'
     or jsonb_array_length(v_bands) < 1
     or jsonb_array_length(v_bands) > 20
     or jsonb_typeof(new.rates->'employer') <> 'object' then
    raise exception 'PAYROLL_SETTINGS_INVALID';
  end if;

  v_count := jsonb_array_length(v_bands);
  for v_band in select * from jsonb_array_elements(v_bands) loop
    v_index := v_index + 1;
    v_upper := (v_band->>'up_to')::numeric;
    v_rate := (v_band->>'rate')::numeric;
    if v_rate is null or v_rate < 0 or v_rate > 1 then
      raise exception 'PAYROLL_SETTINGS_INVALID';
    end if;
    if v_index < v_count then
      if v_upper is null or v_upper <= v_previous or v_upper > 1000000000 then
        raise exception 'PAYROLL_SETTINGS_INVALID';
      end if;
      v_previous := v_upper;
    elsif v_upper is not null then
      raise exception 'PAYROLL_SETTINGS_INVALID';
    end if;
  end loop;

  if (new.rates->>'nssf_employee_rate') is null
     or (new.rates->>'nssf_employee_rate')::numeric not between 0 and 1
     or (new.rates->>'heslb_rate') is null
     or (new.rates->>'heslb_rate')::numeric not between 0 and 1
     or (new.rates->'employer'->>'nssf_rate') is null
     or (new.rates->'employer'->>'nssf_rate')::numeric not between 0 and 1
     or (new.rates->'employer'->>'wcf_rate') is null
     or (new.rates->'employer'->>'wcf_rate')::numeric not between 0 and 1
     or (new.rates->'employer'->>'sdl_rate') is null
     or (new.rates->'employer'->>'sdl_rate')::numeric not between 0 and 1 then
    raise exception 'PAYROLL_SETTINGS_INVALID';
  end if;
  return new;
end;
$$;
drop trigger if exists payroll_settings_validate_rates
  on public.payroll_settings;
create trigger payroll_settings_validate_rates
before insert or update on public.payroll_settings
for each row execute function app.validate_payroll_rates();

create or replace function app.invalidate_changed_payroll_rates()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.rates is distinct from old.rates
     and new.verified_at is not distinct from old.verified_at then
    new.verified_at := null;
    new.verified_by := null;
  end if;
  return new;
end;
$$;
drop trigger if exists payroll_settings_invalidate_changed_rates
  on public.payroll_settings;
create trigger payroll_settings_invalidate_changed_rates
before update on public.payroll_settings
for each row execute function app.invalidate_changed_payroll_rates();

create or replace function app.require_verified_payroll_rates()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.payroll_settings
    where tenant_id = new.tenant_id and verified_at is not null
  ) then
    raise exception 'PAYROLL_SETTINGS_UNVERIFIED';
  end if;
  return new;
end;
$$;
drop trigger if exists payroll_runs_require_verified_rates
  on public.payroll_runs;
create trigger payroll_runs_require_verified_rates
before insert on public.payroll_runs
for each row execute function app.require_verified_payroll_rates();

create or replace function app.reject_invalid_payroll_net()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.net < 0 or new.net > new.gross then
    raise exception 'PAYROLL_RATES_INVALID';
  end if;
  return new;
end;
$$;
drop trigger if exists payroll_items_reject_invalid_net
  on public.payroll_items;
create trigger payroll_items_reject_invalid_net
before insert or update on public.payroll_items
for each row execute function app.reject_invalid_payroll_net();
alter table public.payroll_items
  drop constraint if exists payroll_items_net_nonnegative;
alter table public.payroll_items
  add constraint payroll_items_net_nonnegative check (net >= 0) not valid;
alter table public.payroll_items validate constraint payroll_items_net_nonnegative;

create or replace function app.post_employer_payroll_contributions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total numeric;
begin
  if old.status <> 'draft' or new.status <> 'posted' then
    return new;
  end if;

  select coalesce(sum(
    coalesce((employer->>'nssf')::numeric, 0)
    + coalesce((employer->>'wcf')::numeric, 0)
    + coalesce((employer->>'sdl')::numeric, 0)
  ), 0)
  into v_total
  from public.payroll_items
  where tenant_id = new.tenant_id and run_id = new.id;

  if v_total > 0 then
    insert into public.ledger_accounts (tenant_id, code, name, type) values
      (new.tenant_id, '5010', 'Employer statutory contributions', 'expense'),
      (new.tenant_id, '2110', 'Employer statutory liabilities', 'liability')
    on conflict (tenant_id, code) do nothing;

    perform app.post_journal(
      new.tenant_id,
      new.created_by,
      'Employer statutory contributions ' || new.period,
      'payroll',
      new.id,
      jsonb_build_array(
        jsonb_build_object('code', '5010', 'debit', v_total, 'credit', 0),
        jsonb_build_object('code', '2110', 'debit', 0, 'credit', v_total)
      )
    );
  end if;
  return new;
end;
$$;
drop trigger if exists payroll_runs_post_employer_contributions
  on public.payroll_runs;
create trigger payroll_runs_post_employer_contributions
after update of status on public.payroll_runs
for each row execute function app.post_employer_payroll_contributions();

-- ACSEE aggregate uses the best three subjects excluding General Studies.
-- NECTA divisions: I=3–9, II=10–12, III=13–17, IV=18–19, 0=20–21.
create or replace function app.a_level_result(p_subjects jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  with eligible as (
    select (subject->>'points')::int as points
    from jsonb_array_elements(coalesce(p_subjects, '[]'::jsonb)) subject
    where upper(coalesce(subject->>'code', '')) <> 'GS'
      and (subject->>'points') is not null
    order by (subject->>'points')::int
    limit 3
  ), aggregate as (
    select count(*)::int as subjects, sum(points)::int as points from eligible
  )
  select jsonb_build_object(
    'points', case when subjects = 3 then points end,
    'division', case
      when subjects < 3 then null
      when points <= 9 then 'I'
      when points <= 12 then 'II'
      when points <= 17 then 'III'
      when points <= 19 then 'IV'
      else '0'
    end
  )
  from aggregate;
$$;

alter function app.report_card(uuid, uuid, uuid) rename to report_card_base;
create function app.report_card(
  p_tenant_id uuid, p_student_id uuid, p_term_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_card jsonb;
  v_result jsonb;
begin
  v_card := app.report_card_base(p_tenant_id, p_student_id, p_term_id);
  if v_card->>'educationLevel' = 'a_level' then
    v_result := app.a_level_result(v_card->'subjects');
    v_card := jsonb_set(v_card, '{points}', v_result->'points', true);
    v_card := jsonb_set(v_card, '{division}', v_result->'division', true);
  end if;
  return v_card;
end;
$$;

create or replace function public.report_card(
  p_tenant_id uuid, p_student_id uuid, p_term_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$ select app.report_card(p_tenant_id, p_student_id, p_term_id); $$;

revoke execute on function app.report_card_base(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function app.report_card(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function app.a_level_result(jsonb)
  from public, anon, authenticated;
revoke execute on function public.report_card(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.report_card(uuid, uuid, uuid) to service_role;

revoke execute on function app.invalidate_changed_payroll_rates()
  from public, anon, authenticated;
revoke execute on function app.validate_payroll_rates()
  from public, anon, authenticated;
revoke execute on function app.require_verified_payroll_rates()
  from public, anon, authenticated;
revoke execute on function app.reject_invalid_payroll_net()
  from public, anon, authenticated;
revoke execute on function app.post_employer_payroll_contributions()
  from public, anon, authenticated;

commit;
