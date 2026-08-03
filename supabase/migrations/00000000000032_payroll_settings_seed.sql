-- ATLAS migration 0032 — make the verified-payroll gate reachable for every
-- existing and future tenant. Rates are seeded unverified; a payroll manager
-- must review and verify them before app.run_payroll can insert a run.

begin;

insert into public.payroll_settings (tenant_id, rates)
select t.id, app.payroll_default_rates()
from public.tenants t
on conflict (tenant_id) do nothing;

create or replace function app.seed_payroll_settings_for_tenant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.payroll_settings (tenant_id, rates)
  values (new.id, app.payroll_default_rates())
  on conflict (tenant_id) do nothing;
  return new;
end;
$$;

drop trigger if exists tenants_seed_payroll_settings on public.tenants;
create trigger tenants_seed_payroll_settings
after insert on public.tenants
for each row execute function app.seed_payroll_settings_for_tenant();

revoke execute on function app.seed_payroll_settings_for_tenant()
  from public, anon, authenticated;

commit;
