-- ATLAS migration 0009 — parent portal links + fee reminders.
--
-- Parents deliberately do NOT become tenant members: membership grants
-- school-wide RLS reads, which is wrong for a parent. Instead a parent's
-- auth account is linked to their guardian record (guardians.user_id) and
-- everything they see flows through dedicated API endpoints scoped to their
-- own children. The only RLS a parent gets is reading their own guardian row
-- (so the web app can route them to /portal).

-- ---------------------------------------------------------------------------
-- Schema changes
-- ---------------------------------------------------------------------------
alter table public.guardians
  add column user_id uuid unique references public.profiles(id);

alter table public.invitations
  add column guardian_id uuid references public.guardians(id);

create policy "guardians read own row" on public.guardians
  for select using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- accept_invitation: branch for parent invites (guardian_id set) — link the
-- guardian instead of creating a membership.
-- ---------------------------------------------------------------------------
create or replace function app.accept_invitation(p_user_id uuid, p_email text, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv public.invitations%rowtype;
  v_membership_id uuid;
  v_role_key text;
  v_role_id uuid;
  v_guardian public.guardians%rowtype;
begin
  select * into v_inv from public.invitations
  where token_hash = p_token_hash and status = 'pending' and expires_at > now();
  if v_inv.id is null then
    raise exception 'INVITE_INVALID_OR_EXPIRED';
  end if;
  if lower(v_inv.email::text) <> lower(p_email) then
    raise exception 'INVITE_EMAIL_MISMATCH';
  end if;

  -- Parent invite: link the guardian record, no tenant membership.
  if v_inv.guardian_id is not null then
    select * into v_guardian from public.guardians
    where id = v_inv.guardian_id and tenant_id = v_inv.tenant_id;
    if v_guardian.id is null then
      raise exception 'INVITE_GUARDIAN_NOT_FOUND';
    end if;
    if v_guardian.user_id is not null and v_guardian.user_id <> p_user_id then
      raise exception 'INVITE_GUARDIAN_TAKEN';
    end if;

    update public.guardians set user_id = p_user_id where id = v_guardian.id;
    update public.invitations set status = 'accepted' where id = v_inv.id;

    insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id)
    values (v_inv.tenant_id, p_user_id, 'invitation.parent_linked', 'guardian', v_guardian.id::text);

    return jsonb_build_object('tenantId', v_inv.tenant_id, 'portal', 'parent');
  end if;

  -- Staff invite: membership + roles (unchanged behaviour).
  insert into public.tenant_memberships (tenant_id, user_id, status, campus_ids)
  values (v_inv.tenant_id, p_user_id, 'active', v_inv.campus_ids)
  on conflict (tenant_id, user_id)
    do update set status = 'active', campus_ids = excluded.campus_ids
  returning id into v_membership_id;

  foreach v_role_key in array v_inv.role_keys
  loop
    select id into v_role_id from public.roles where tenant_id is null and key = v_role_key;
    if v_role_id is not null then
      insert into public.membership_roles (membership_id, role_id, assigned_by)
      values (v_membership_id, v_role_id, v_inv.invited_by)
      on conflict do nothing;
    end if;
  end loop;

  update public.invitations set status = 'accepted' where id = v_inv.id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id)
  values (v_inv.tenant_id, p_user_id, 'invitation.accepted', 'invitation', v_inv.id::text);

  return jsonb_build_object('tenantId', v_inv.tenant_id, 'portal', 'staff');
end;
$$;

-- ---------------------------------------------------------------------------
-- import_students: guardians can now carry an email (needed to invite the
-- parent to the portal). Same behaviour otherwise.
-- ---------------------------------------------------------------------------
create or replace function app.import_students(
  p_tenant_id uuid, p_actor uuid, p_campus_id uuid, p_year_id uuid, p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_student_id uuid;
  v_guardian_id uuid;
  v_number text;
  v_count int := 0;
begin
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_number := 'STU-' || lpad(app.next_counter(p_tenant_id, 'student_number')::text, 5, '0');

    insert into public.students
      (tenant_id, campus_id, student_number, first_name, middle_name, last_name,
       gender, date_of_birth, boarding_status, created_by)
    values
      (p_tenant_id, p_campus_id, v_number,
       v_row->>'firstName', v_row->>'middleName', v_row->>'lastName',
       v_row->>'gender',
       nullif(v_row->>'dateOfBirth','')::date,
       coalesce(nullif(v_row->>'boardingStatus',''), 'day'),
       p_actor)
    returning id into v_student_id;

    if v_row ? 'guardian' and v_row->'guardian'->>'fullName' is not null then
      select id into v_guardian_id from public.guardians
      where tenant_id = p_tenant_id
        and phone is not null
        and phone = v_row->'guardian'->>'phone';

      if v_guardian_id is null then
        insert into public.guardians (tenant_id, full_name, phone, email)
        values (p_tenant_id, v_row->'guardian'->>'fullName',
                nullif(v_row->'guardian'->>'phone',''),
                nullif(v_row->'guardian'->>'email','')::citext)
        returning id into v_guardian_id;
      elsif nullif(v_row->'guardian'->>'email','') is not null then
        update public.guardians set email = (v_row->'guardian'->>'email')::citext
        where id = v_guardian_id and email is null;
      end if;

      insert into public.student_guardians (student_id, guardian_id, relationship, is_primary)
      values (v_student_id, v_guardian_id,
              coalesce(nullif(v_row->'guardian'->>'relationship',''), 'guardian'), true);
    end if;

    if nullif(v_row->>'classSectionId','') is not null then
      insert into public.class_enrolments
        (tenant_id, student_id, class_section_id, academic_year_id)
      values (p_tenant_id, v_student_id, (v_row->>'classSectionId')::uuid, p_year_id);
    end if;

    v_count := v_count + 1;
  end loop;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, after)
  values (p_tenant_id, p_actor, 'students.imported', 'student',
          jsonb_build_object('count', v_count));

  return jsonb_build_object('imported', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- Fee reminders: one outbox SMS per unpaid invoice to the student's primary
-- guardian. An invoice with a reminder still pending in the outbox is
-- skipped, so repeated clicks never spam parents.
-- ---------------------------------------------------------------------------
create or replace function app.queue_fee_reminders(p_tenant_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  with unpaid as (
    select i.id, i.invoice_number, i.due_on, i.student_id,
           i.total - coalesce(
             (select sum(p.amount) from public.payments p where p.invoice_id = i.id), 0
           ) as balance
    from public.invoices i
    where i.tenant_id = p_tenant_id
      and i.status in ('issued', 'partially_paid')
  )
  insert into public.notification_outbox (tenant_id, recipient, template, payload)
  select p_tenant_id, g.phone, 'fees.reminder',
         jsonb_build_object(
           'invoiceId', u.id,
           'invoiceNumber', u.invoice_number,
           'studentName', s.first_name || ' ' || s.last_name,
           'studentNumber', s.student_number,
           'guardianName', g.full_name,
           'balance', u.balance,
           'dueOn', u.due_on
         )
  from unpaid u
  join public.students s on s.id = u.student_id and s.status = 'active'
  join public.student_guardians sg on sg.student_id = s.id and sg.is_primary
  join public.guardians g on g.id = sg.guardian_id and g.phone is not null
  where u.balance > 0
    and not exists (
      select 1 from public.notification_outbox o
      where o.tenant_id = p_tenant_id
        and o.template = 'fees.reminder'
        and o.status = 'pending'
        and (o.payload->>'invoiceId')::uuid = u.id
    );
  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, after)
    values (p_tenant_id, p_actor, 'finance.reminders_queued', 'notification_outbox',
            jsonb_build_object('queued', v_count));
  end if;

  return jsonb_build_object('queued', v_count);
end;
$$;

create or replace function public.queue_fee_reminders(p_tenant_id uuid, p_actor uuid)
returns jsonb language sql security definer set search_path = public
as $$ select app.queue_fee_reminders(p_tenant_id, p_actor); $$;

revoke execute on function app.queue_fee_reminders(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.queue_fee_reminders(uuid, uuid) from public, anon, authenticated;
grant execute on function public.queue_fee_reminders(uuid, uuid) to service_role;
