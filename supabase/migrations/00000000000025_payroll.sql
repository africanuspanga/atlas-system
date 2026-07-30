-- ATLAS migration 0025 — payroll v1 (mishahara).
--
-- Monthly payroll for staff with fixed salaries. A run is computed as a
-- DRAFT (app.run_payroll), reviewed, then posted to the double-entry ledger
-- (app.post_payroll) through the SAME app.post_journal used by finance
-- (migration 0007): one balanced entry per run — debit Salaries & Wages for
-- total gross, credit Payroll Liabilities for total statutory deductions,
-- credit Cash for total net pay.
--
-- Posted runs are IMMUTABLE: there are no edit/delete RPCs, matching the
-- financial iron rule. Corrections are a future REVERSAL feature (a new run
-- posting a reversing journal entry), never an edit.
--
-- Statutory rates are CONFIGURABLE per tenant (payroll_settings.rates jsonb)
-- and seeded with 2026-era Tanzania mainland defaults THE SCHOOL MUST VERIFY
-- with TRA/NSSF/HESLB before first live payroll:
--   employee side (deducted, posted to the ledger):
--     * NSSF/PSSSF employee: 10% of gross (basic + allowances)
--     * PAYE — progressive monthly bands (jsonb array, NOT hard-coded),
--       applied to the taxable base = gross LESS employee NSSF (TRA
--       convention):
--         0%  up to 270,000
--         8%  270,001 – 520,000
--         20% 520,001 – 760,000
--         25% 760,001 – 1,000,000
--         30% above 1,000,000
--     * HESLB loan repayment: 15% of basic when the employee is flagged
--       (a loan repayment, not a pre-tax statutory deduction)
--   employer side (INFORMATIONAL in v1 — computed and stored on each item,
--   NOT posted to the ledger):
--     * NSSF employer 10%, WCF 0.5%, SDL 3.5% (SDL applies to private
--       schools with >= 10 employees — verify applicability).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One active salary per staff member; changing a salary deactivates the old
-- row and inserts a new one (history preserved).
create table public.staff_salaries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  user_id uuid not null references public.profiles(id),
  basic_salary numeric(12,2) not null check (basic_salary > 0),
  allowances numeric(12,2) not null default 0 check (allowances >= 0),
  has_heslb boolean not null default false,
  active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index staff_salaries_tenant_idx on public.staff_salaries (tenant_id, active);
create unique index staff_salaries_one_active_idx
  on public.staff_salaries (tenant_id, user_id) where active;

-- Per-tenant statutory rates (jsonb) — seeded with the defaults above on
-- first payroll run (see app.payroll_default_rates / app.run_payroll).
create table public.payroll_settings (
  tenant_id uuid primary key references public.tenants(id),
  rates jsonb not null,
  -- A school must review the seeded statutory rates against TRA/NSSF/HESLB and
  -- mark them verified before the numbers can be trusted for live payroll. The
  -- API/UI surface verified_at so operators know whether the defaults were ever
  -- confirmed for this tenant.
  verified_at timestamptz,
  verified_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create table public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  period char(7) not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status text not null default 'draft' check (status in ('draft','posted')),
  journal_entry_id uuid references public.journal_entries(id),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  posted_at timestamptz,
  unique (tenant_id, period)
);
create index payroll_runs_tenant_idx on public.payroll_runs (tenant_id, period desc);

create table public.payroll_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  run_id uuid not null references public.payroll_runs(id),
  user_id uuid not null references public.profiles(id),
  basic numeric(12,2) not null,
  allowances numeric(12,2) not null,
  gross numeric(12,2) not null,
  paye numeric(12,2) not null,
  nssf_employee numeric(12,2) not null,
  heslb numeric(12,2) not null,
  other_deductions numeric(12,2) not null default 0,
  net numeric(12,2) not null,
  -- Employer-side contributions (informational, not posted in v1):
  -- { "nssf": n, "wcf": n, "sdl": n }
  employer jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index payroll_items_run_idx on public.payroll_items (run_id);
create index payroll_items_tenant_idx on public.payroll_items (tenant_id);

-- RLS: enabled with NO member-read policies. Salary data is sensitive —
-- unlike other modules there is deliberately no "members read" policy here;
-- ALL reads flow through the API (service role), which enforces
-- payroll.view / payroll.manage per request.
alter table public.staff_salaries enable row level security;
alter table public.payroll_settings enable row level security;
alter table public.payroll_runs enable row level security;
alter table public.payroll_items enable row level security;

-- ---------------------------------------------------------------------------
-- Payroll can now appear as a journal source. Widening the source_type check
-- from migration 0007 is the one non-purely-additive touch here; existing
-- rows all satisfy the new, strictly wider constraint.
-- ---------------------------------------------------------------------------
alter table public.journal_entries
  drop constraint journal_entries_source_type_check;
alter table public.journal_entries
  add constraint journal_entries_source_type_check
  check (source_type in ('invoice','payment','reversal','payroll'));

-- ---------------------------------------------------------------------------
-- Default statutory rates. 2026-era Tanzania mainland DEFAULTS — the school
-- must verify current TRA/NSSF/WCF/SDL/HESLB rates before relying on them.
-- paye_bands is ordered ascending; "up_to" null marks the top band.
-- ---------------------------------------------------------------------------
create or replace function app.payroll_default_rates()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'paye_bands', jsonb_build_array(
      jsonb_build_object('up_to',  270000, 'rate', 0),
      jsonb_build_object('up_to',  520000, 'rate', 0.08),
      jsonb_build_object('up_to',  760000, 'rate', 0.20),
      jsonb_build_object('up_to', 1000000, 'rate', 0.25),
      jsonb_build_object('up_to', null,    'rate', 0.30)
    ),
    'nssf_employee_rate', 0.10,   -- of gross (basic + allowances)
    'heslb_rate',         0.15,   -- of basic salary, when flagged
    'employer', jsonb_build_object(
      'nssf_rate', 0.10,          -- of gross (informational)
      'wcf_rate',  0.005,         -- of gross (informational)
      'sdl_rate',  0.035          -- of gross (informational; >= 10 employees)
    )
  );
$$;

-- Progressive tax over ordered bands. The caller passes the TAXABLE base
-- (monthly gross LESS the employee NSSF/PSSSF deduction — the TRA PAYE
-- calculator convention); this function just applies the bands to whatever
-- income it is given. Schools must still verify the current band thresholds
-- and rates against TRA before first live payroll.
create or replace function app.compute_paye(p_income numeric, p_bands jsonb)
returns numeric
language plpgsql
immutable
as $$
declare
  v_band jsonb;
  v_prev numeric := 0;
  v_upper numeric;
  v_tax numeric := 0;
begin
  for v_band in select * from jsonb_array_elements(p_bands)
  loop
    v_upper := (v_band->>'up_to')::numeric;  -- null = top band
    if v_upper is null or p_income <= v_upper then
      v_tax := v_tax + (v_band->>'rate')::numeric * (p_income - v_prev);
      exit;
    end if;
    v_tax := v_tax + (v_band->>'rate')::numeric * (v_upper - v_prev);
    v_prev := v_upper;
  end loop;
  return round(greatest(v_tax, 0), 2);
end;
$$;

-- ---------------------------------------------------------------------------
-- Set (or replace) a staff member's salary. Deactivates any prior active row
-- so history is preserved; the partial unique index guarantees at most one
-- active salary per member.
-- ---------------------------------------------------------------------------
create or replace function app.set_staff_salary(
  p_tenant_id uuid, p_actor uuid, p_user_id uuid,
  p_basic numeric, p_allowances numeric, p_has_heslb boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_basic is null or p_basic <= 0
     or p_allowances is null or p_allowances < 0 then
    raise exception 'SALARY_BAD_AMOUNT';
  end if;

  if not exists (
    select 1 from public.tenant_memberships
    where tenant_id = p_tenant_id and user_id = p_user_id and status = 'active'
  ) then
    raise exception 'SALARY_MEMBER_NOT_FOUND';
  end if;

  update public.staff_salaries
  set active = false
  where tenant_id = p_tenant_id and user_id = p_user_id and active;

  insert into public.staff_salaries
    (tenant_id, user_id, basic_salary, allowances, has_heslb, created_by)
  values (p_tenant_id, p_user_id, p_basic, coalesce(p_allowances, 0),
          coalesce(p_has_heslb, false), p_actor)
  returning id into v_id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'payroll.salary_set', 'staff_salary', v_id::text,
          jsonb_build_object('userId', p_user_id, 'basic', p_basic,
                             'allowances', coalesce(p_allowances, 0),
                             'hasHeslb', coalesce(p_has_heslb, false)));

  return jsonb_build_object('salaryId', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Compute a DRAFT payroll run for one month. Seeds payroll_settings with the
-- defaults if the tenant has no row yet. One run per (tenant, period).
-- ---------------------------------------------------------------------------
create or replace function app.run_payroll(
  p_tenant_id uuid, p_actor uuid, p_period text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rates jsonb;
  v_run_id uuid;
  v_sal record;
  v_gross numeric;
  v_paye numeric;
  v_nssf numeric;
  v_heslb numeric;
  v_net numeric;
  v_count int := 0;
  v_total_gross numeric := 0;
  v_total_net numeric := 0;
  v_nssf_rate numeric;
  v_heslb_rate numeric;
begin
  if p_period is null or p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'PAYROLL_BAD_PERIOD';
  end if;

  if exists (
    select 1 from public.payroll_runs
    where tenant_id = p_tenant_id and period = p_period
  ) then
    raise exception 'PAYROLL_PERIOD_EXISTS';
  end if;

  if not exists (
    select 1 from public.staff_salaries
    where tenant_id = p_tenant_id and active
  ) then
    raise exception 'PAYROLL_NO_SALARIES';
  end if;

  -- Seed the tenant's rates with the commented defaults on first use.
  insert into public.payroll_settings (tenant_id, rates)
  values (p_tenant_id, app.payroll_default_rates())
  on conflict (tenant_id) do nothing;
  select rates into v_rates
  from public.payroll_settings where tenant_id = p_tenant_id;

  v_nssf_rate := (v_rates->>'nssf_employee_rate')::numeric;
  v_heslb_rate := (v_rates->>'heslb_rate')::numeric;

  insert into public.payroll_runs (tenant_id, period, created_by)
  values (p_tenant_id, p_period, p_actor)
  returning id into v_run_id;

  -- Only pay staff who are still active members: a departed employee whose
  -- membership was ended (or whose salary was deactivated) drops out of the
  -- run automatically (BUG-OFFBOARD).
  for v_sal in
    select s.user_id, s.basic_salary, s.allowances, s.has_heslb
    from public.staff_salaries s
    join public.tenant_memberships tm
      on tm.tenant_id = s.tenant_id and tm.user_id = s.user_id and tm.status = 'active'
    where s.tenant_id = p_tenant_id and s.active
  loop
    v_gross := v_sal.basic_salary + v_sal.allowances;
    -- NSSF is assessed on gross cash remuneration (basic + allowances) for
    -- private-sector employers, not basic alone (BUG-NSSF).
    v_nssf := round(v_gross * v_nssf_rate, 2);
    -- PAYE taxable base is monthly pay AFTER the employee NSSF/PSSSF deduction
    -- (TRA PAYE calculator convention), not gross (BUG-PAYE). HESLB is a loan
    -- repayment, not a statutory pre-tax deduction, so it does not reduce the
    -- PAYE base.
    v_paye := round(app.compute_paye(v_gross - v_nssf, v_rates->'paye_bands'), 2);
    v_heslb := case when v_sal.has_heslb
                    then round(v_sal.basic_salary * v_heslb_rate, 2)
                    else 0 end;
    v_net := v_gross - v_paye - v_nssf - v_heslb;

    insert into public.payroll_items
      (tenant_id, run_id, user_id, basic, allowances, gross,
       paye, nssf_employee, heslb, net, employer)
    values
      (p_tenant_id, v_run_id, v_sal.user_id, v_sal.basic_salary,
       v_sal.allowances, v_gross, v_paye, v_nssf, v_heslb, v_net,
       jsonb_build_object(
         'nssf', round(v_gross * (v_rates->'employer'->>'nssf_rate')::numeric, 2),
         'wcf',  round(v_gross * (v_rates->'employer'->>'wcf_rate')::numeric, 2),
         'sdl',  round(v_gross * (v_rates->'employer'->>'sdl_rate')::numeric, 2)));

    v_count := v_count + 1;
    v_total_gross := v_total_gross + v_gross;
    v_total_net := v_total_net + v_net;
  end loop;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'payroll.run_created', 'payroll_run', v_run_id::text,
          jsonb_build_object('period', p_period, 'employees', v_count,
                             'totalGross', v_total_gross, 'totalNet', v_total_net));

  return jsonb_build_object('runId', v_run_id, 'period', p_period,
                            'employees', v_count,
                            'totalGross', v_total_gross,
                            'totalNet', v_total_net);
end;
$$;

-- ---------------------------------------------------------------------------
-- Post a draft run to the ledger — ONE balanced journal entry via the
-- existing app.post_journal (migration 0007):
--   debit  5000 Salaries & Wages     total gross      (lazy-created, expense)
--   credit 2100 Payroll Liabilities  total deductions (lazy-created, liability)
--   credit 1000 Cash                 total net
-- Employer contributions are informational in v1 and NOT posted.
-- Once posted the run is immutable; corrections are a future reversal
-- feature (reversing journal entry + correcting run), never an edit.
-- ---------------------------------------------------------------------------
create or replace function app.post_payroll(
  p_tenant_id uuid, p_actor uuid, p_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.payroll_runs%rowtype;
  v_gross numeric;
  v_deductions numeric;
  v_net numeric;
  v_lines jsonb;
  v_entry_id uuid;
begin
  select * into v_run from public.payroll_runs
  where id = p_run_id and tenant_id = p_tenant_id
  for update;
  if v_run.id is null then
    raise exception 'PAYROLL_RUN_NOT_FOUND';
  end if;
  if v_run.status = 'posted' then
    raise exception 'PAYROLL_ALREADY_POSTED';
  end if;

  -- A draft snapshots salaries at run time; if the active salary set changed
  -- afterwards (raise, new hire, offboarding), the draft is stale and must be
  -- recomputed (discard + re-run) before posting, or the ledger would diverge
  -- from the current salary setup (BUG-STALE / D16). Compare the snapshot in
  -- payroll_items against the current active, still-employed salary set.
  if exists (
    -- an active salary with no matching snapshot line, or a mismatched amount
    select 1
    from public.staff_salaries s
    join public.tenant_memberships tm
      on tm.tenant_id = s.tenant_id and tm.user_id = s.user_id and tm.status = 'active'
    left join public.payroll_items pi
      on pi.run_id = p_run_id and pi.user_id = s.user_id
    where s.tenant_id = p_tenant_id and s.active
      and (pi.user_id is null
           or pi.basic <> s.basic_salary
           or pi.allowances <> s.allowances)
    union all
    -- a snapshot line whose staff member is no longer active/employed
    select 1
    from public.payroll_items pi
    where pi.run_id = p_run_id
      and not exists (
        select 1 from public.staff_salaries s
        join public.tenant_memberships tm
          on tm.tenant_id = s.tenant_id and tm.user_id = s.user_id and tm.status = 'active'
        where s.tenant_id = p_tenant_id and s.active and s.user_id = pi.user_id
      )
  ) then
    raise exception 'PAYROLL_RUN_STALE';
  end if;

  select coalesce(sum(gross), 0),
         coalesce(sum(paye + nssf_employee + heslb + other_deductions), 0),
         coalesce(sum(net), 0)
    into v_gross, v_deductions, v_net
  from public.payroll_items
  where run_id = p_run_id;
  if v_gross <= 0 then
    raise exception 'PAYROLL_RUN_EMPTY';
  end if;

  -- Lazy chart of accounts: base set (1000 Cash etc.) plus the payroll pair,
  -- same pattern as app.ensure_ledger_accounts / app.account_for_method.
  perform app.ensure_ledger_accounts(p_tenant_id);
  insert into public.ledger_accounts (tenant_id, code, name, type) values
    (p_tenant_id, '5000', 'Salaries & Wages',    'expense'),
    (p_tenant_id, '2100', 'Payroll Liabilities', 'liability')
  on conflict (tenant_id, code) do nothing;

  -- journal_lines forbids zero-amount lines — only add credits that exist.
  v_lines := jsonb_build_array(
    jsonb_build_object('code', '5000', 'debit', v_gross, 'credit', 0));
  if v_deductions > 0 then
    v_lines := v_lines || jsonb_build_object('code', '2100', 'debit', 0, 'credit', v_deductions);
  end if;
  if v_net > 0 then
    v_lines := v_lines || jsonb_build_object('code', '1000', 'debit', 0, 'credit', v_net);
  end if;

  v_entry_id := app.post_journal(p_tenant_id, p_actor,
    'Payroll ' || v_run.period, 'payroll', p_run_id, v_lines);

  update public.payroll_runs
  set status = 'posted', journal_entry_id = v_entry_id, posted_at = now()
  where id = p_run_id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'payroll.run_posted', 'payroll_run', p_run_id::text,
          jsonb_build_object('period', v_run.period, 'journalEntryId', v_entry_id,
                             'totalGross', v_gross, 'totalDeductions', v_deductions,
                             'totalNet', v_net));

  return jsonb_build_object('runId', p_run_id, 'journalEntryId', v_entry_id,
                            'totalGross', v_gross,
                            'totalDeductions', v_deductions,
                            'totalNet', v_net);
end;
$$;

-- ---------------------------------------------------------------------------
-- Offboarding: deactivate a staff member's salary so they stop being paid.
-- Unlike set_staff_salary this does NOT require an active membership (you must
-- be able to remove someone who has already left). BUG-OFFBOARD.
-- ---------------------------------------------------------------------------
create or replace function app.deactivate_staff_salary(
  p_tenant_id uuid, p_actor uuid, p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  update public.staff_salaries
  set active = false
  where tenant_id = p_tenant_id and user_id = p_user_id and active
  returning id into v_id;

  if v_id is null then
    raise exception 'SALARY_NOT_FOUND';
  end if;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'payroll.salary_removed', 'staff_salary', v_id::text,
          jsonb_build_object('userId', p_user_id));

  return jsonb_build_object('salaryId', v_id, 'removed', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Discard a DRAFT run so a mistaken/stale draft does not permanently block its
-- period (payroll_runs is unique per (tenant, period)). Posted runs are
-- immutable and cannot be discarded. BUG-DRAFT-VOID / D16.
-- ---------------------------------------------------------------------------
create or replace function app.discard_payroll_run(
  p_tenant_id uuid, p_actor uuid, p_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.payroll_runs%rowtype;
begin
  select * into v_run from public.payroll_runs
  where id = p_run_id and tenant_id = p_tenant_id
  for update;
  if v_run.id is null then
    raise exception 'PAYROLL_RUN_NOT_FOUND';
  end if;
  if v_run.status = 'posted' then
    raise exception 'PAYROLL_RUN_POSTED';
  end if;

  delete from public.payroll_items where run_id = p_run_id;
  delete from public.payroll_runs where id = p_run_id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'payroll.run_discarded', 'payroll_run', p_run_id::text,
          jsonb_build_object('period', v_run.period));

  return jsonb_build_object('runId', p_run_id, 'discarded', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Update (and mark verified) the tenant's statutory rates. Seeds the row with
-- defaults if absent. Setting p_verified stamps verified_at/by so operators
-- can see the rates were reviewed before a live run. D06 settings workflow.
-- ---------------------------------------------------------------------------
create or replace function app.update_payroll_settings(
  p_tenant_id uuid, p_actor uuid, p_rates jsonb, p_verified boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_rates is null or p_rates->'paye_bands' is null
     or jsonb_typeof(p_rates->'paye_bands') <> 'array' then
    raise exception 'PAYROLL_SETTINGS_INVALID';
  end if;

  insert into public.payroll_settings (tenant_id, rates, updated_at,
                                       verified_at, verified_by)
  values (p_tenant_id, p_rates, now(),
          case when p_verified then now() else null end,
          case when p_verified then p_actor else null end)
  on conflict (tenant_id) do update
    set rates = excluded.rates,
        updated_at = now(),
        verified_at = case when p_verified then now() else public.payroll_settings.verified_at end,
        verified_by = case when p_verified then p_actor else public.payroll_settings.verified_by end;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'payroll.settings_updated', 'payroll_settings', p_tenant_id::text,
          jsonb_build_object('verified', p_verified));

  return jsonb_build_object('tenantId', p_tenant_id, 'verified', p_verified);
end;
$$;

-- ---------------------------------------------------------------------------
-- Public wrappers — service role only (PostgREST exposes only public schema).
-- ---------------------------------------------------------------------------
create or replace function public.set_staff_salary(
  p_tenant_id uuid, p_actor uuid, p_user_id uuid,
  p_basic numeric, p_allowances numeric, p_has_heslb boolean
)
returns jsonb language sql security definer set search_path = public
as $$ select app.set_staff_salary(p_tenant_id, p_actor, p_user_id, p_basic, p_allowances, p_has_heslb); $$;

create or replace function public.run_payroll(
  p_tenant_id uuid, p_actor uuid, p_period text
)
returns jsonb language sql security definer set search_path = public
as $$ select app.run_payroll(p_tenant_id, p_actor, p_period); $$;

create or replace function public.post_payroll(
  p_tenant_id uuid, p_actor uuid, p_run_id uuid
)
returns jsonb language sql security definer set search_path = public
as $$ select app.post_payroll(p_tenant_id, p_actor, p_run_id); $$;

create or replace function public.deactivate_staff_salary(
  p_tenant_id uuid, p_actor uuid, p_user_id uuid
)
returns jsonb language sql security definer set search_path = public
as $$ select app.deactivate_staff_salary(p_tenant_id, p_actor, p_user_id); $$;

create or replace function public.discard_payroll_run(
  p_tenant_id uuid, p_actor uuid, p_run_id uuid
)
returns jsonb language sql security definer set search_path = public
as $$ select app.discard_payroll_run(p_tenant_id, p_actor, p_run_id); $$;

create or replace function public.update_payroll_settings(
  p_tenant_id uuid, p_actor uuid, p_rates jsonb, p_verified boolean
)
returns jsonb language sql security definer set search_path = public
as $$ select app.update_payroll_settings(p_tenant_id, p_actor, p_rates, p_verified); $$;

revoke execute on function app.payroll_default_rates() from public, anon, authenticated;
revoke execute on function app.compute_paye(numeric, jsonb) from public, anon, authenticated;
revoke execute on function app.set_staff_salary(uuid, uuid, uuid, numeric, numeric, boolean) from public, anon, authenticated;
revoke execute on function app.run_payroll(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function app.post_payroll(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function app.deactivate_staff_salary(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function app.discard_payroll_run(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function app.update_payroll_settings(uuid, uuid, jsonb, boolean) from public, anon, authenticated;
revoke execute on function public.set_staff_salary(uuid, uuid, uuid, numeric, numeric, boolean) from public, anon, authenticated;
revoke execute on function public.run_payroll(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.post_payroll(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.deactivate_staff_salary(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.discard_payroll_run(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.update_payroll_settings(uuid, uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.set_staff_salary(uuid, uuid, uuid, numeric, numeric, boolean) to service_role;
grant execute on function public.run_payroll(uuid, uuid, text) to service_role;
grant execute on function public.post_payroll(uuid, uuid, uuid) to service_role;
grant execute on function public.deactivate_staff_salary(uuid, uuid, uuid) to service_role;
grant execute on function public.discard_payroll_run(uuid, uuid, uuid) to service_role;
grant execute on function public.update_payroll_settings(uuid, uuid, jsonb, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- Permissions (keys BEFORE role_permissions — FK). Mirrored in seed.sql.
-- school_owner/director are superusers in the API guard and need no rows.
-- ---------------------------------------------------------------------------
insert into public.permissions (key, module, description) values
  ('payroll.view',   'payroll', 'View salaries and payroll runs'),
  ('payroll.manage', 'payroll', 'Set salaries, run and post payroll')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join lateral unnest(case r.key
  when 'bursar'       then array['payroll.view', 'payroll.manage']
  when 'accountant'   then array['payroll.view']
  when 'school_admin' then array['payroll.view', 'payroll.manage']
  else array[]::text[]
end) as p(key)
where r.tenant_id is null and r.is_system
on conflict do nothing;
