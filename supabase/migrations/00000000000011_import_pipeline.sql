-- ATLAS migration 0011 — staged data-import pipeline (CTO §8).
--
-- Files land in a PRIVATE storage bucket; parsed rows land in staging tables,
-- never straight into production. Commit runs in chunks through
-- app.import_commit_chunk, which is idempotent: a row is only ever committed
-- once (final_record_id set in the same transaction as the created record),
-- so re-running a crashed or duplicated job cannot duplicate students or
-- invoices.
--
-- Domains v1: 'students' (students + guardians + enrolment — upgrade of the
-- old direct importer) and 'opening_balances' (per-student opening balance as
-- an invoice + journal entry: debit A/R, credit 3000 Opening Balances equity —
-- never a raw edit, per the financial-import rules).
--
-- The spec's import_files / import_row_decisions / import_results tables are
-- consolidated: the file lives on the job (file_path), the per-row decision
-- lives on the staging row (decision), and results live on the job (summary,
-- counters, error_report_path). import_column_mappings stays its own table so
-- a school's mapping is remembered across imports.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  campus_id uuid references public.campuses(id),
  domain text not null check (domain in ('students','opening_balances')),
  status text not null default 'uploaded' check (status in
    ('uploaded','validated','queued','committing','committed','failed','cancelled')),
  file_path text not null,
  original_filename text not null,
  file_size integer not null,
  row_count integer not null default 0,
  valid_rows integer not null default 0,
  warning_rows integer not null default 0,
  invalid_rows integer not null default 0,
  duplicate_rows integer not null default 0,
  committed_rows integer not null default 0,
  failed_rows integer not null default 0,
  column_mapping jsonb not null default '{}'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  error_report_path text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  committed_at timestamptz
);
create index import_jobs_tenant_idx on public.import_jobs (tenant_id, created_at desc);
create index import_jobs_pending_idx on public.import_jobs (status)
  where status in ('queued','committing');
create trigger import_jobs_updated_at before update on public.import_jobs
  for each row execute function app.set_updated_at();

create table public.import_staging_rows (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  import_job_id uuid not null references public.import_jobs(id),
  row_number integer not null,
  raw_data jsonb not null,
  mapped_data jsonb,
  validation_status text not null default 'pending'
    check (validation_status in ('pending','valid','warning','invalid')),
  validation_errors jsonb not null default '[]'::jsonb,
  duplicate_status text not null default 'none'
    check (duplicate_status in ('none','in_file','existing')),
  decision text not null default 'import' check (decision in ('import','skip')),
  final_record_id uuid,
  commit_error text,
  unique (import_job_id, row_number)
);
create index import_staging_rows_job_idx
  on public.import_staging_rows (import_job_id, validation_status);
create index import_staging_rows_uncommitted_idx
  on public.import_staging_rows (import_job_id, row_number)
  where final_record_id is null and commit_error is null;

create table public.import_column_mappings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  domain text not null,
  headers_fingerprint text not null,
  mapping jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, domain, headers_fingerprint)
);
create trigger import_column_mappings_updated_at before update on public.import_column_mappings
  for each row execute function app.set_updated_at();

-- RLS: members read their school's import history; all writes via the API
-- (service role), which enforces the imports.manage permission.
alter table public.import_jobs enable row level security;
alter table public.import_staging_rows enable row level security;
alter table public.import_column_mappings enable row level security;

create policy "members read import jobs" on public.import_jobs
  for select using (app.is_tenant_member(tenant_id));
create policy "members read import staging rows" on public.import_staging_rows
  for select using (app.is_tenant_member(tenant_id));
create policy "members read import mappings" on public.import_column_mappings
  for select using (app.is_tenant_member(tenant_id));

-- ---------------------------------------------------------------------------
-- Private storage bucket. No storage.objects policies: only the service role
-- can read/write, downloads happen through short-lived signed URLs minted by
-- the API. Never guessable public URLs.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('imports', 'imports', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Chart of accounts: opening balances are equity, not current-year income.
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
    (p_tenant_id, '3000', 'Opening Balances',    'equity'),
    (p_tenant_id, '4000', 'Fee Income',          'income')
  on conflict (tenant_id, code) do nothing;
$$;

-- ---------------------------------------------------------------------------
-- Chunked, idempotent commit. Processes up to p_max_rows uncommitted rows of
-- one job inside this transaction; each row gets its own exception scope so
-- one bad row records commit_error instead of aborting the chunk. Returns
-- {processed, committed, failed, done} — done=true once no uncommitted rows
-- remain and the job has been finalised.
-- ---------------------------------------------------------------------------
create or replace function app.import_commit_chunk(
  p_tenant_id uuid, p_actor uuid, p_job_id uuid, p_max_rows int default 200
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.import_jobs%rowtype;
  v_row record;
  v_data jsonb;
  v_processed int := 0;
  v_committed int := 0;
  v_failed int := 0;
  v_student_id uuid;
  v_guardian_id uuid;
  v_number text;
  v_invoice_id uuid;
  v_year_id uuid;
begin
  select * into v_job from public.import_jobs
  where id = p_job_id and tenant_id = p_tenant_id
  for update;
  if v_job.id is null then
    raise exception 'IMPORT_JOB_NOT_FOUND';
  end if;
  if v_job.status not in ('queued','committing') then
    raise exception 'IMPORT_JOB_NOT_COMMITTABLE';
  end if;
  if v_job.status = 'queued' then
    update public.import_jobs set status = 'committing' where id = p_job_id;
  end if;

  -- Active academic year for enrolments / invoices.
  select id into v_year_id from public.academic_years
  where tenant_id = p_tenant_id and status = 'active'
  order by starts_on desc limit 1;

  for v_row in
    select * from public.import_staging_rows
    where import_job_id = p_job_id
      and decision = 'import'
      and validation_status in ('valid','warning')
      and final_record_id is null
      and commit_error is null
    order by row_number
    limit p_max_rows
    for update
  loop
    v_processed := v_processed + 1;
    v_data := v_row.mapped_data;
    begin
      if v_job.domain = 'students' then
        v_number := 'STU-' || lpad(app.next_counter(p_tenant_id, 'student_number')::text, 5, '0');
        insert into public.students
          (tenant_id, campus_id, student_number, first_name, middle_name, last_name,
           gender, date_of_birth, boarding_status, created_by)
        values
          (p_tenant_id, v_job.campus_id, v_number,
           v_data->>'firstName', nullif(v_data->>'middleName',''), v_data->>'lastName',
           v_data->>'gender',
           nullif(v_data->>'dateOfBirth','')::date,
           coalesce(nullif(v_data->>'boardingStatus',''), 'day'),
           p_actor)
        returning id into v_student_id;

        if nullif(v_data->>'guardianName','') is not null then
          v_guardian_id := null;
          if nullif(v_data->>'guardianPhone','') is not null then
            select id into v_guardian_id from public.guardians
            where tenant_id = p_tenant_id and phone = v_data->>'guardianPhone';
          end if;
          if v_guardian_id is null then
            insert into public.guardians (tenant_id, full_name, phone, email)
            values (p_tenant_id, v_data->>'guardianName',
                    nullif(v_data->>'guardianPhone',''),
                    nullif(v_data->>'guardianEmail','')::citext)
            returning id into v_guardian_id;
          end if;
          insert into public.student_guardians (student_id, guardian_id, relationship, is_primary)
          values (v_student_id, v_guardian_id,
                  coalesce(nullif(v_data->>'guardianRelationship',''), 'guardian'), true);
        end if;

        if nullif(v_data->>'classSectionId','') is not null then
          -- Re-verify tenant ownership at commit time (AUD-001 discipline),
          -- even though validation already resolved it.
          if not exists (
            select 1 from public.class_sections
            where id = (v_data->>'classSectionId')::uuid and tenant_id = p_tenant_id
          ) then
            raise exception 'IMPORT_SECTION_NOT_FOUND';
          end if;
          if v_year_id is null then
            raise exception 'IMPORT_NO_ACTIVE_YEAR';
          end if;
          insert into public.class_enrolments
            (tenant_id, student_id, class_section_id, academic_year_id)
          values (p_tenant_id, v_student_id, (v_data->>'classSectionId')::uuid, v_year_id);
        end if;

        update public.import_staging_rows
        set final_record_id = v_student_id where id = v_row.id;

      elsif v_job.domain = 'opening_balances' then
        if v_year_id is null then
          raise exception 'IMPORT_NO_ACTIVE_YEAR';
        end if;
        v_number := 'INV-' || lpad(app.next_counter(p_tenant_id, 'invoice_number')::text, 5, '0');
        insert into public.invoices
          (tenant_id, student_id, academic_year_id, invoice_number, total,
           issued_on, created_by)
        values (p_tenant_id, (v_data->>'studentId')::uuid, v_year_id, v_number,
                (v_data->>'amount')::numeric,
                coalesce(nullif(v_data->>'asOfDate','')::date, current_date),
                p_actor)
        returning id into v_invoice_id;

        insert into public.invoice_lines (tenant_id, invoice_id, description, amount)
        values (p_tenant_id, v_invoice_id,
                coalesce(nullif(v_data->>'description',''), 'Salio la awali (opening balance)'),
                (v_data->>'amount')::numeric);

        perform app.ensure_ledger_accounts(p_tenant_id);
        perform app.post_journal(p_tenant_id, p_actor,
          'Opening balance ' || v_number || ' (import)', 'invoice', v_invoice_id,
          jsonb_build_array(
            jsonb_build_object('code','1100','debit', (v_data->>'amount')::numeric, 'credit', 0),
            jsonb_build_object('code','3000','debit', 0, 'credit', (v_data->>'amount')::numeric)
          ));

        update public.import_staging_rows
        set final_record_id = v_invoice_id where id = v_row.id;
      end if;

      v_committed := v_committed + 1;
    exception when others then
      update public.import_staging_rows
      set commit_error = sqlerrm where id = v_row.id;
      v_failed := v_failed + 1;
    end;
  end loop;

  update public.import_jobs
  set committed_rows = committed_rows + v_committed,
      failed_rows = failed_rows + v_failed
  where id = p_job_id;

  if v_processed < p_max_rows then
    -- No uncommitted rows left: finalise.
    update public.import_jobs
    set status = 'committed', committed_at = now()
    where id = p_job_id;
    insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
    select p_tenant_id, p_actor, 'import.committed', 'import_job', p_job_id::text,
           jsonb_build_object('domain', j.domain, 'committed', j.committed_rows,
                              'failed', j.failed_rows, 'rows', j.row_count)
    from public.import_jobs j where j.id = p_job_id;
    return jsonb_build_object('processed', v_processed, 'committed', v_committed,
                              'failed', v_failed, 'done', true);
  end if;

  return jsonb_build_object('processed', v_processed, 'committed', v_committed,
                            'failed', v_failed, 'done', false);
end;
$$;

-- Public wrapper — service role only.
create or replace function public.import_commit_chunk(
  p_tenant_id uuid, p_actor uuid, p_job_id uuid, p_max_rows int default 200
)
returns jsonb language sql security definer set search_path = public
as $$ select app.import_commit_chunk(p_tenant_id, p_actor, p_job_id, p_max_rows); $$;

revoke execute on function app.import_commit_chunk(uuid, uuid, uuid, int) from public, anon, authenticated;
revoke execute on function public.import_commit_chunk(uuid, uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.import_commit_chunk(uuid, uuid, uuid, int) to service_role;

-- ---------------------------------------------------------------------------
-- Permission: import management for administrative roles. Domain-specific
-- creation rights (students.create / finance.invoices.create) are additionally
-- checked by the API when a job is created.
-- ---------------------------------------------------------------------------
insert into public.permissions (key, description, module)
values ('imports.manage', 'Upload, validate and commit data imports', 'imports')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'imports.manage'
from public.roles r
where r.tenant_id is null and r.is_system
  and r.key in ('head_teacher','school_admin','academic_master','bursar','accountant')
on conflict do nothing;
