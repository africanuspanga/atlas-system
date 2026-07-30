-- ATLAS migration 0021 — library (maktaba) module.
--
-- Tanzanian schools loan textbooks per student (textbook-to-student ratios
-- are tracked and inspected). library_books carries the catalogue with the
-- number of physical copies; library_loans tracks who holds a copy. A student
-- may borrow several DIFFERENT books at once, but only one active loan of the
-- same book (partial unique index). Availability = copies_total minus active
-- loans, computed — never stored. Writes go through app.loan_book /
-- app.return_book only.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.library_books (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  code text not null,
  title text not null,
  author text,
  subject_id uuid references public.subjects(id),
  copies_total int not null check (copies_total > 0),
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);
create index library_books_tenant_idx on public.library_books (tenant_id);

create table public.library_loans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  book_id uuid not null references public.library_books(id),
  student_id uuid not null references public.students(id),
  loaned_on date not null default current_date,
  due_on date not null,
  returned_on date
);
create index library_loans_tenant_idx on public.library_loans (tenant_id);
create index library_loans_book_active_idx
  on public.library_loans (book_id) where returned_on is null;
create index library_loans_overdue_idx
  on public.library_loans (tenant_id, due_on) where returned_on is null;
-- a student may hold many books, but only one ACTIVE loan of the same book
create unique index library_loans_book_student_active_idx
  on public.library_loans (book_id, student_id)
  where returned_on is null;

-- RLS: members read; all writes via the API (service role).
alter table public.library_books enable row level security;
alter table public.library_loans enable row level security;

create policy "members read library books" on public.library_books
  for select using (app.is_tenant_member(tenant_id));
create policy "members read library loans" on public.library_loans
  for select using (app.is_tenant_member(tenant_id));

-- ---------------------------------------------------------------------------
-- Loan a book. Validates that the book exists, the student is active, the
-- student does not already hold an active loan of this book, and that a copy
-- is available (copies_total minus active loans > 0). The book row is locked
-- to serialise concurrent availability checks.
-- ---------------------------------------------------------------------------
create or replace function app.loan_book(
  p_tenant_id uuid, p_actor uuid, p_book_id uuid, p_student_id uuid, p_due_on date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_book public.library_books%rowtype;
  v_active int;
  v_loan_id uuid;
begin
  -- lock the book row: concurrent loans serialise on the availability check
  select * into v_book from public.library_books
  where id = p_book_id and tenant_id = p_tenant_id
  for update;
  if v_book.id is null then
    raise exception 'LIBRARY_BOOK_NOT_FOUND';
  end if;

  if not exists (
    select 1 from public.students
    where id = p_student_id and tenant_id = p_tenant_id and status = 'active'
  ) then
    raise exception 'LIBRARY_STUDENT_NOT_FOUND';
  end if;

  if exists (
    select 1 from public.library_loans
    where book_id = p_book_id and student_id = p_student_id
      and returned_on is null
  ) then
    raise exception 'LIBRARY_ALREADY_LOANED';
  end if;

  select count(*)::int into v_active
  from public.library_loans
  where book_id = p_book_id and returned_on is null;
  if v_book.copies_total - v_active <= 0 then
    raise exception 'LIBRARY_NO_COPIES';
  end if;

  insert into public.library_loans (tenant_id, book_id, student_id, due_on)
  values (p_tenant_id, p_book_id, p_student_id, p_due_on)
  returning id into v_loan_id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'library.loaned', 'library_loan',
          v_loan_id::text,
          jsonb_build_object('bookId', p_book_id, 'bookCode', v_book.code,
                             'studentId', p_student_id, 'dueOn', p_due_on));

  return jsonb_build_object(
    'loanId', v_loan_id,
    'bookId', p_book_id,
    'studentId', p_student_id,
    'dueOn', p_due_on
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Return a book (closes the active loan).
-- ---------------------------------------------------------------------------
create or replace function app.return_book(
  p_tenant_id uuid, p_actor uuid, p_loan_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loan public.library_loans%rowtype;
begin
  update public.library_loans
  set returned_on = current_date
  where id = p_loan_id and tenant_id = p_tenant_id and returned_on is null
  returning * into v_loan;
  if v_loan.id is null then
    raise exception 'LIBRARY_LOAN_NOT_FOUND';
  end if;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'library.returned', 'library_loan',
          p_loan_id::text,
          jsonb_build_object('bookId', v_loan.book_id,
                             'studentId', v_loan.student_id));

  return jsonb_build_object('returned', true);
end;
$$;

-- Public wrappers — service role only (PostgREST exposes only public schema).
create or replace function public.loan_book(
  p_tenant_id uuid, p_actor uuid, p_book_id uuid, p_student_id uuid, p_due_on date
)
returns jsonb language sql security definer set search_path = public
as $$ select app.loan_book(p_tenant_id, p_actor, p_book_id, p_student_id, p_due_on); $$;

create or replace function public.return_book(
  p_tenant_id uuid, p_actor uuid, p_loan_id uuid
)
returns jsonb language sql security definer set search_path = public
as $$ select app.return_book(p_tenant_id, p_actor, p_loan_id); $$;

revoke execute on function app.loan_book(uuid, uuid, uuid, uuid, date) from public, anon, authenticated;
revoke execute on function app.return_book(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.loan_book(uuid, uuid, uuid, uuid, date) from public, anon, authenticated;
revoke execute on function public.return_book(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.loan_book(uuid, uuid, uuid, uuid, date) to service_role;
grant execute on function public.return_book(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Permissions (keys BEFORE role_permissions — FK). Mirrored in seed.sql.
-- school_owner/director are superusers in the API guard and need no rows.
-- A dedicated librarian role can come later.
-- ---------------------------------------------------------------------------
insert into public.permissions (key, module, description) values
  ('library.view',   'library', 'View the library catalogue and loans'),
  ('library.manage', 'library', 'Manage books, loans and returns')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join lateral unnest(case r.key
  when 'teacher'         then array['library.view']
  when 'class_teacher'   then array['library.view']
  when 'head_teacher'    then array['library.view', 'library.manage']
  when 'school_admin'    then array['library.view', 'library.manage']
  when 'academic_master' then array['library.view']
  else array[]::text[]
end) as p(key)
where r.tenant_id is null and r.is_system
on conflict do nothing;
