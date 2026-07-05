-- ATLAS seed data — system roles and core permissions.
-- Idempotent: safe to run repeatedly.

insert into public.permissions (key, module, description) values
  ('students.view',            'students',   'View student records'),
  ('students.create',          'students',   'Create student records'),
  ('students.update',          'students',   'Update student records'),
  ('students.archive',         'students',   'Archive student records'),
  ('guardians.view',           'students',   'View guardian records'),
  ('guardians.manage',         'students',   'Create and update guardians'),
  ('attendance.view',          'attendance', 'View attendance'),
  ('attendance.mark',          'attendance', 'Mark attendance'),
  ('attendance.correct',       'attendance', 'Correct submitted attendance'),
  ('attendance.approve',       'attendance', 'Approve attendance corrections'),
  ('academics.manage',         'academics',  'Manage academic structure'),
  ('exams.create',             'assessments','Create assessments'),
  ('marks.enter',              'assessments','Enter marks'),
  ('marks.moderate',           'assessments','Moderate marks'),
  ('results.publish',          'assessments','Publish results'),
  ('results.correct_published','assessments','Correct published results'),
  ('finance.invoices.view',    'finance',    'View invoices'),
  ('finance.invoices.create',  'finance',    'Create invoices'),
  ('finance.payments.receive', 'finance',    'Receive payments'),
  ('finance.refunds.request',  'finance',    'Request refunds'),
  ('finance.refunds.approve',  'finance',    'Approve refunds'),
  ('finance.periods.lock',     'finance',    'Lock financial periods'),
  ('finance.reports.view',     'finance',    'View financial reports'),
  ('settings.manage',          'settings',   'Manage school settings'),
  ('members.invite',           'settings',   'Invite staff members'),
  ('members.manage',           'settings',   'Manage members and roles'),
  ('audit.view',               'audit',      'View audit logs')
on conflict (key) do nothing;

-- System roles (tenant_id null)
insert into public.roles (tenant_id, key, name, is_system, description) values
  (null, 'school_owner',    'School Owner',        true, 'Full access to the school organisation'),
  (null, 'director',        'Director',            true, 'School leadership'),
  (null, 'head_teacher',    'Head Teacher',        true, 'Academic and operational leadership'),
  (null, 'school_admin',    'School Administrator', true, 'Day-to-day administration'),
  (null, 'academic_master', 'Academic Master',     true, 'Academic configuration and results'),
  (null, 'bursar',          'Bursar',              true, 'Finance leadership'),
  (null, 'accountant',      'Accountant',          true, 'Accounting operations'),
  (null, 'cashier',         'Cashier',             true, 'Payment collection'),
  (null, 'teacher',         'Teacher',             true, 'Teaching staff'),
  (null, 'class_teacher',   'Class Teacher',       true, 'Class-level responsibilities'),
  (null, 'parent',          'Parent',              true, 'Parent or guardian'),
  (null, 'student',         'Student',             true, 'Student user')
on conflict do nothing;

-- Role permissions for non-owner system roles (school_owner/director are
-- superusers in the API guard). Keep in sync with migration 0005.
insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join lateral unnest(case r.key
  when 'teacher' then array[
    'students.view', 'attendance.view', 'attendance.mark', 'marks.enter']
  when 'class_teacher' then array[
    'students.view', 'guardians.view',
    'attendance.view', 'attendance.mark', 'attendance.correct', 'marks.enter']
  when 'head_teacher' then array[
    'students.view', 'students.create', 'students.update', 'students.archive',
    'guardians.view', 'guardians.manage', 'academics.manage',
    'attendance.view', 'attendance.mark', 'attendance.correct', 'attendance.approve',
    'exams.create', 'marks.enter', 'marks.moderate', 'results.publish',
    'members.invite', 'audit.view']
  when 'school_admin' then array[
    'students.view', 'students.create', 'students.update', 'students.archive',
    'guardians.view', 'guardians.manage',
    'attendance.view', 'members.invite']
  when 'academic_master' then array[
    'students.view', 'academics.manage', 'attendance.view',
    'exams.create', 'marks.enter', 'marks.moderate', 'results.publish']
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

-- Starter plan
insert into public.plans (key, name, description, limits) values
  ('pilot', 'Pilot', 'Pilot programme plan for early schools',
   '{"maxStudents": 2500, "smsPerMonth": 5000, "storageGb": 20}')
on conflict (key) do nothing;
