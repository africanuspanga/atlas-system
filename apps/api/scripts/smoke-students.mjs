/**
 * End-to-end smoke test: students, Excel-import path, staff invitations, RBAC.
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-students.mjs
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const stamp = Date.now().toString(36);
const password = `Smoke-${stamp}-Aa1!`;
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

async function makeUser(email, fullName) {
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name: fullName },
  });
  if (error) throw new Error(error.message);
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data: signin, error: e2 } = await client.auth.signInWithPassword({ email, password });
  if (e2) throw new Error(e2.message);
  return { id: data.user.id, client, token: signin.session.access_token };
}

async function api(path, token, tenantId, body, method = 'POST') {
  const res = await fetch(`${apiUrl}/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// 1. Owner onboards a school
const owner = await makeUser(`owner-${stamp}@example.com`, 'Owner Smoke');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke Sec ${stamp}`, slug: `smoke-sec-${stamp}`, email: `owner-${stamp}@example.com`, defaultLanguage: 'sw' },
  academicYear: {
    name: '2027', startsOn: '2027-01-05', endsOn: '2027-12-04',
    terms: [{ name: 'Muhula wa Kwanza', startsOn: '2027-01-05', endsOn: '2027-06-12' }],
  },
  classes: [{ educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A', 'B'] }],
});
if (onboard.status !== 201) throw new Error(`onboard: ${onboard.status} ${JSON.stringify(onboard.body)}`);
const tenantId = onboard.body.tenantId;
console.log('1. school onboarded');

// 2. Single student create (with class + guardian)
const { data: sections } = await owner.client.from('class_sections').select('id, name').order('name');
const single = await api('/students', owner.token, tenantId, {
  firstName: 'Neema', lastName: 'Joseph', gender: 'female', dateOfBirth: '2012-03-14',
  classSectionId: sections[0].id,
  guardian: { fullName: 'Mary Joseph', phone: '+255700000001', relationship: 'mother' },
});
if (single.status !== 201 || single.body.imported !== 1) throw new Error(`create: ${JSON.stringify(single.body)}`);
console.log('2. single student created');

// 3. Import: dry run with one bad class -> reports error, imports nothing
const badRows = [
  { firstName: 'Baraka', lastName: 'Mushi', gender: 'male', className: 'Form 1', stream: 'A',
    guardian: { fullName: 'John Mushi', phone: '+255700000002', relationship: 'father' } },
  { firstName: 'Zawadi', lastName: 'Komba', gender: 'female', className: 'Form 9', stream: 'A' },
];
const dry = await api('/students/import', owner.token, tenantId, { rows: badRows, dryRun: true });
if (dry.body.invalid !== 1 || dry.body.valid !== 1) throw new Error(`dryRun: ${JSON.stringify(dry.body)}`);
// even with dryRun=false, errors must block the whole import
const blocked = await api('/students/import', owner.token, tenantId, { rows: badRows, dryRun: false });
if (!blocked.body.dryRun) throw new Error('import with bad rows was not blocked');
console.log('3. dry-run reports errors; bad batch blocked (no partial import)');

// 4. Import valid rows only
const good = await api('/students/import', owner.token, tenantId, {
  rows: [badRows[0], { firstName: 'Daudi', lastName: 'Mwakyusa', gender: 'male', className: 'Form 1', stream: 'B' }],
  dryRun: false,
});
if (good.body.imported !== 2) throw new Error(`import: ${JSON.stringify(good.body)}`);
const { data: students } = await owner.client.from('students').select('student_number').order('student_number');
if (students.length !== 3 || students[0].student_number !== 'STU-00001') {
  throw new Error(`students: ${JSON.stringify(students)}`);
}
// guardian dedupe: same phone reused
const { count: gcount } = await admin.from('guardians').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId);
console.log(`4. imported 2, total 3 students (STU-00001..3), guardians: ${gcount}`);

// 5. Invite a teacher, accept, verify RBAC
const invite = await api('/invitations', owner.token, tenantId, {
  email: `teacher-${stamp}@example.com`, roleKeys: ['teacher'],
});
if (invite.status !== 201) throw new Error(`invite: ${JSON.stringify(invite.body)}`);
const token = invite.body.inviteUrl.split('/invite/')[1];
const teacher = await makeUser(`teacher-${stamp}@example.com`, 'Teacher Smoke');
const accept = await api('/invitations/accept', teacher.token, null, { token });
if (accept.body.tenantId !== tenantId) throw new Error(`accept: ${JSON.stringify(accept.body)}`);
console.log('5. teacher invited + accepted');

// 6. RBAC: teacher cannot create students (403) nor list staff (403); owner can list staff
const denied = await api('/students', teacher.token, tenantId, { firstName: 'X', lastName: 'Y', gender: 'male' });
if (denied.status !== 403) throw new Error(`teacher create should be 403, got ${denied.status}`);
const deniedStaff = await api('/staff', teacher.token, tenantId, null, 'GET');
if (deniedStaff.status !== 403) throw new Error(`teacher staff list should be 403, got ${deniedStaff.status}`);
const staff = await api('/staff', owner.token, tenantId, null, 'GET');
if (staff.body.data.length !== 2) throw new Error(`staff count: ${staff.body.data.length}`);
console.log('6. RBAC enforced: teacher 403 on create+staff; owner sees 2 members');

// 7. Wrong-email invite acceptance must fail
const invite2 = await api('/invitations', owner.token, tenantId, { email: `someoneelse-${stamp}@example.com`, roleKeys: ['teacher'] });
const token2 = invite2.body.inviteUrl.split('/invite/')[1];
const mismatch = await api('/invitations/accept', teacher.token, null, { token: token2 });
if (mismatch.status !== 400 || mismatch.body.code !== 'INVITE_EMAIL_MISMATCH') {
  throw new Error(`mismatch: ${mismatch.status} ${JSON.stringify(mismatch.body)}`);
}
console.log('7. email-mismatched invite rejected');

// Cleanup: archive test tenant
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` }).eq('id', tenantId);
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
console.log('8. test tenant archived\n\nSMOKE TEST PASSED');
