\set ON_ERROR_STOP on

-- High-risk release invariants that a schema-only migration rehearsal cannot
-- prove. This script is transactional and leaves the target database unchanged.
begin;

do $$
declare
  v_actor uuid := '10000000-0000-4000-8000-000000000001';
  v_key uuid := '20000000-0000-4000-8000-000000000001';
  v_onboard jsonb;
  v_tenant uuid;
  v_year uuid;
  v_student uuid;
  v_invoice uuid;
  v_run uuid;
  v_payment jsonb;
  v_replay jsonb;
  v_rates jsonb;
  v_count int;
  v_amount numeric;
  v_overview jsonb;
  v_expected_count bigint;
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values (v_actor, 'release-regression@atlas.invalid', '{"full_name":"Release Regression"}');

  v_onboard := app.onboard_school_with_trial(
    v_actor,
    jsonb_build_object(
      'school', jsonb_build_object(
        'name', 'Release Regression School',
        'slug', 'release-regression-school',
        'email', 'release-regression@atlas.invalid',
        'defaultLanguage', 'en'
      ),
      'academicYear', jsonb_build_object(
        'name', '2026', 'startsOn', '2026-01-01', 'endsOn', '2026-12-31',
        'terms', jsonb_build_array(
          jsonb_build_object(
            'name', 'Term 1', 'startsOn', '2026-01-01', 'endsOn', '2026-04-30'
          )
        )
      ),
      'classes', jsonb_build_array(
        jsonb_build_object(
          'educationLevel', 'o_level', 'gradeName', 'Form 1',
          'sequence', 1, 'streams', jsonb_build_array('A')
        )
      )
    )
  );
  v_tenant := (v_onboard->>'tenantId')::uuid;
  v_year := (v_onboard->>'academicYearId')::uuid;

  select count(*) into v_count from public.subscriptions where tenant_id = v_tenant;
  if v_count <> 1 then
    raise exception 'REGRESSION: onboarding did not atomically create one trial';
  end if;

  v_overview := app.platform_overview();
  select count(*) into v_expected_count
  from public.tenants where status <> 'archived';
  if (v_overview #>> '{totals,tenants}')::bigint <> v_expected_count then
    raise exception 'REGRESSION: owner overview includes archived tenants';
  end if;

  perform app.set_staff_salary(v_tenant, v_actor, v_actor, 900000, 100000, false);
  begin
    perform app.run_payroll(v_tenant, v_actor, '2026-08');
    raise exception 'REGRESSION: unverified payroll was accepted';
  exception when others then
    if sqlerrm not like '%PAYROLL_SETTINGS_UNVERIFIED%' then raise; end if;
  end;

  v_rates := app.payroll_default_rates();
  perform app.update_payroll_settings(v_tenant, v_actor, v_rates, true);
  v_run := (app.run_payroll(v_tenant, v_actor, '2026-08')->>'runId')::uuid;
  perform app.post_payroll(v_tenant, v_actor, v_run);

  select count(*) into v_count
  from public.journal_entries
  where tenant_id = v_tenant and source_type = 'payroll' and source_id = v_run;
  if v_count <> 2 then
    raise exception 'REGRESSION: payroll must post wage and employer journals, got %', v_count;
  end if;
  if exists (
    select 1 from public.journal_entries
    where tenant_id = v_tenant and source_type = 'payroll'
      and source_id = v_run and entry_date <> date '2026-08-31'
  ) then
    raise exception 'REGRESSION: payroll journal date is not the period end';
  end if;
  select coalesce(sum(jl.debit), 0) into v_amount
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where je.source_id = v_run and la.code = '5010';
  if v_amount <> 140000 then
    raise exception 'REGRESSION: employer contribution expense was %, expected 140000', v_amount;
  end if;

  if app.a_level_result('[
    {"code":"GS","points":4}, {"code":"HIST","points":4},
    {"code":"GEO","points":3}, {"code":"KISW","points":4}
  ]'::jsonb) <> '{"points":11,"division":"II"}'::jsonb then
    raise exception 'REGRESSION: ACSEE aggregate included General Studies or used wrong bands';
  end if;

  begin
    perform app.update_payroll_settings(
      v_tenant, v_actor,
      jsonb_set(v_rates, '{paye_bands,4,up_to}', '2000000'::jsonb),
      true
    );
    raise exception 'REGRESSION: finite final PAYE band was accepted';
  exception when others then
    if sqlerrm not like '%PAYROLL_SETTINGS_INVALID%' then raise; end if;
  end;

  perform app.update_payroll_settings(
    v_tenant, v_actor,
    jsonb_set(v_rates, '{nssf_employee_rate}', '0.09'::jsonb),
    false
  );
  if exists (
    select 1 from public.payroll_settings
    where tenant_id = v_tenant and verified_at is not null
  ) then
    raise exception 'REGRESSION: changed statutory rates remained verified';
  end if;

  insert into public.students
    (tenant_id, student_number, first_name, last_name, gender, created_by)
  values (v_tenant, 'STU-REG-1', 'Asha', 'Jaribio', 'female', v_actor)
  returning id into v_student;

  v_invoice := (app.create_invoice(
    v_tenant, v_actor, v_student, null, app.tanzania_today() + 30,
    jsonb_build_array(jsonb_build_object('description', 'Tuition', 'amount', 200000))
  )->>'invoiceId')::uuid;

  v_payment := app.record_payment(
    v_tenant, v_actor, v_invoice, 100000, 'mpesa', 'REG-001',
    app.tanzania_today(), v_key
  );
  v_replay := app.record_payment(
    v_tenant, v_actor, v_invoice, 100000, 'mpesa', 'REG-001',
    app.tanzania_today(), v_key
  );
  if v_payment->>'paymentId' <> v_replay->>'paymentId'
     or coalesce((v_replay->>'idempotentReplay')::boolean, false) is not true then
    raise exception 'REGRESSION: payment replay did not return the original receipt';
  end if;
  select count(*) into v_count
  from public.payments where tenant_id = v_tenant and idempotency_key = v_key;
  if v_count <> 1 then
    raise exception 'REGRESSION: payment replay created % rows', v_count;
  end if;
  begin
    perform app.record_payment(
      v_tenant, v_actor, v_invoice, 90000, 'mpesa', 'REG-001',
      app.tanzania_today(), v_key
    );
    raise exception 'REGRESSION: changed idempotent request was accepted';
  exception when others then
    if sqlerrm not like '%PAYMENT_IDEMPOTENCY_CONFLICT%' then raise; end if;
  end;
  begin
    perform app.record_payment(
      v_tenant, v_actor, v_invoice, 1000, 'cash', null,
      app.tanzania_today() + 1, gen_random_uuid()
    );
    raise exception 'REGRESSION: future-dated payment was accepted';
  exception when others then
    if sqlerrm not like '%PAYMENT_BAD_DATE%' then raise; end if;
  end;
end;
$$;

rollback;
