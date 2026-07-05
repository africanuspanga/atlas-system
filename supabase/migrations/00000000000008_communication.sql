-- ATLAS migration 0008 — communication: guardian announcements via the
-- notification outbox, plus the communication.send permission.
--
-- Announcements resolve their audience (whole school or one class section)
-- to guardians with phone numbers, dedupe by phone, and write one outbox row
-- per recipient IN THE SAME TRANSACTION as the announcement record. The
-- workers app drains pending outbox rows to the SMS gateway.

-- ---------------------------------------------------------------------------
-- Permission
-- ---------------------------------------------------------------------------
insert into public.permissions (key, module, description) values
  ('communication.send', 'communication', 'Send announcements and SMS')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'communication.send'
from public.roles r
where r.tenant_id is null and r.is_system
  and r.key in ('head_teacher', 'school_admin')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Announcements
-- ---------------------------------------------------------------------------
create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  audience_type text not null check (audience_type in ('all_guardians','class_section')),
  class_section_id uuid references public.class_sections(id),
  channel text not null default 'sms' check (channel in ('sms')),
  body text not null check (char_length(body) between 3 and 480),
  recipient_count int not null default 0,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  check (audience_type <> 'class_section' or class_section_id is not null)
);
create index announcements_tenant_idx on public.announcements (tenant_id, created_at desc);

alter table public.announcements enable row level security;
create policy "members read announcements" on public.announcements
  for select using (app.is_tenant_member(tenant_id));

-- Members may see their school's outbox queue status (the phone numbers in
-- it are already member-readable via the guardians table).
create policy "members read outbox" on public.notification_outbox
  for select using (app.is_tenant_member(tenant_id));

-- ---------------------------------------------------------------------------
-- Queue an announcement
-- ---------------------------------------------------------------------------
create or replace function app.queue_announcement(
  p_tenant_id uuid, p_actor uuid, p_audience_type text,
  p_class_section_id uuid, p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_announcement_id uuid;
  v_count int;
begin
  if p_audience_type = 'class_section' then
    if not exists (
      select 1 from public.class_sections
      where id = p_class_section_id and tenant_id = p_tenant_id
    ) then
      raise exception 'ANNOUNCEMENT_SECTION_NOT_FOUND';
    end if;
  elsif p_audience_type <> 'all_guardians' then
    raise exception 'ANNOUNCEMENT_BAD_AUDIENCE';
  end if;

  insert into public.announcements
    (tenant_id, audience_type, class_section_id, body, created_by)
  values (p_tenant_id, p_audience_type,
          case when p_audience_type = 'class_section' then p_class_section_id end,
          p_body, p_actor)
  returning id into v_announcement_id;

  -- one outbox row per distinct guardian phone in the audience
  insert into public.notification_outbox (tenant_id, recipient, template, payload)
  select p_tenant_id, phone, 'announcement',
         jsonb_build_object(
           'announcementId', v_announcement_id,
           'guardianName', full_name,
           'body', p_body
         )
  from (
    select distinct on (g.phone) g.phone, g.full_name
    from public.guardians g
    join public.student_guardians sg on sg.guardian_id = g.id
    join public.students s on s.id = sg.student_id and s.status = 'active'
    where g.tenant_id = p_tenant_id
      and g.phone is not null
      and (
        p_audience_type = 'all_guardians'
        or exists (
          select 1 from public.class_enrolments e
          where e.student_id = s.id
            and e.class_section_id = p_class_section_id
            and e.status = 'active'
        )
      )
    order by g.phone, g.full_name
  ) recipients;
  get diagnostics v_count = row_count;

  if v_count = 0 then
    raise exception 'ANNOUNCEMENT_NO_RECIPIENTS';
  end if;

  update public.announcements set recipient_count = v_count
  where id = v_announcement_id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'communication.announcement_queued', 'announcement',
          v_announcement_id::text,
          jsonb_build_object('audience', p_audience_type, 'recipients', v_count));

  return jsonb_build_object('announcementId', v_announcement_id, 'recipients', v_count);
end;
$$;

create or replace function public.queue_announcement(
  p_tenant_id uuid, p_actor uuid, p_audience_type text,
  p_class_section_id uuid, p_body text
)
returns jsonb language sql security definer set search_path = public
as $$ select app.queue_announcement(p_tenant_id, p_actor, p_audience_type, p_class_section_id, p_body); $$;

revoke execute on function app.queue_announcement(uuid, uuid, text, uuid, text) from public, anon, authenticated;
revoke execute on function public.queue_announcement(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.queue_announcement(uuid, uuid, text, uuid, text) to service_role;
