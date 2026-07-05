/**
 * End-to-end smoke test: attendance marking, teacher RBAC (seeded
 * role_permissions), absence alert outbox, corrections.
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-attendance.mjs
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

// 1. Owner onboards a school with two streams; term covers the marking date
const owner = await makeUser(`att-owner-${stamp}@example.com`, 'Att Owner');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke Att ${stamp}`, slug: `smoke-att-${stamp}`, email: `att-owner-${stamp}@example.com`, defaultLanguage: 'sw' },
  academicYear: {
    name: '2027', startsOn: '2027-01-05', endsOn: '2027-12-04',
    terms: [{ name: 'Muhula wa Kwanza', startsOn: '2027-01-05', endsOn: '2027-06-12' }],
  },
  classes: [{ educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A', 'B'] }],
});
if (onboard.status !== 201) throw new Error(`onboard: ${onboard.status} ${JSON.stringify(onboard.body)}`);
const tenantId = onboard.body.tenantId;
const { data: sections } = await owner.client.from('class_sections').select('id, name').order('name');
const sectionA = sections.find((s) => s.name === 'A').id;
const sectionB = sections.find((s) => s.name === 'B').id;
console.log('1. school onboarded');

// 2. Three students in Form 1 A (two with guardian phones), one in Form 1 B
const rows = [
  { firstName: 'Neema', lastName: 'Joseph', gender: 'female', classSectionId: sectionA,
    guardian: { fullName: 'Mary Joseph', phone: `+2557${stamp.slice(-6)}01`, relationship: 'mother' } },
  { firstName: 'Baraka', lastName: 'Mushi', gender: 'male', classSectionId: sectionA,
    guardian: { fullName: 'John Mushi', phone: `+2557${stamp.slice(-6)}02`, relationship: 'father' } },
  { firstName: 'Zawadi', lastName: 'Komba', gender: 'female', classSectionId: sectionA },
  { firstName: 'Daudi', lastName: 'Mwakyusa', gender: 'male', classSectionId: sectionB },
];
for (const row of rows) {
  const res = await api('/students', owner.token, tenantId, row);
  if (res.status !== 201) throw new Error(`student: ${JSON.stringify(res.body)}`);
}
const { data: students } = await owner.client
  .from('students').select('id, first_name').order('student_number');
const [neema, baraka, zawadi, daudi] = students.map((s) => s.id);
console.log('2. four students enrolled (3 in A, 1 in B)');

// 3. Teacher joins via invitation — seeded role_permissions must allow marking
const invite = await api('/invitations', owner.token, tenantId, {
  email: `att-teacher-${stamp}@example.com`, roleKeys: ['teacher'],
});
const inviteToken = invite.body.inviteUrl.split('/invite/')[1];
const teacher = await makeUser(`att-teacher-${stamp}@example.com`, 'Att Teacher');
const accept = await api('/invitations/accept', teacher.token, null, { token: inviteToken });
if (accept.body.tenantId !== tenantId) throw new Error(`accept: ${JSON.stringify(accept.body)}`);
console.log('3. teacher invited + accepted');

// 4. Teacher marks Form 1 A: one absent → session, records, one outbox alert
const date = '2027-02-01';
const mark = await api('/attendance', teacher.token, tenantId, {
  classSectionId: sectionA, date,
  records: [
    { studentId: neema, status: 'present' },
    { studentId: baraka, status: 'absent' },
    { studentId: zawadi, status: 'late' },
  ],
});
if (mark.status !== 201) throw new Error(`mark: ${mark.status} ${JSON.stringify(mark.body)}`);
if (mark.body.revision !== 1 || mark.body.counts.absent !== 1 || mark.body.alertsQueued !== 1) {
  throw new Error(`mark result: ${JSON.stringify(mark.body)}`);
}
const sessionId = mark.body.sessionId;
console.log('4. teacher marked register (1 absent, 1 alert queued)');

// 5. RLS: teacher reads back the session + records; term was auto-resolved
const { data: session } = await teacher.client
  .from('attendance_sessions')
  .select('id, revision, academic_term_id, attendance_records(student_id, status)')
  .eq('id', sessionId).single();
if (!session || session.attendance_records.length !== 3 || !session.academic_term_id) {
  throw new Error(`session read: ${JSON.stringify(session)}`);
}
const { data: outbox } = await admin
  .from('notification_outbox').select('recipient, template, payload, status')
  .eq('tenant_id', tenantId);
if (outbox.length !== 1 || outbox[0].template !== 'attendance.absent'
  || outbox[0].payload.studentId !== baraka || outbox[0].status !== 'pending') {
  throw new Error(`outbox: ${JSON.stringify(outbox)}`);
}
console.log('5. RLS read OK; outbox has 1 pending SMS for absent student\'s guardian');

// 6. Teacher re-submits same register → 403 (corrections need attendance.correct)
const denied = await api('/attendance', teacher.token, tenantId, {
  classSectionId: sectionA, date,
  records: [{ studentId: neema, status: 'absent' }],
});
if (denied.status !== 403) throw new Error(`correction should be 403, got ${denied.status}`);
console.log('6. teacher denied correction (attendance.correct enforced)');

// 7. Owner corrects: Baraka now present, Neema now absent → revision 2,
//    exactly ONE new alert (Neema only; Baraka already alerted)
const correct = await api('/attendance', owner.token, tenantId, {
  classSectionId: sectionA, date,
  records: [
    { studentId: neema, status: 'absent' },
    { studentId: baraka, status: 'present' },
    { studentId: zawadi, status: 'present' },
  ],
});
if (correct.status !== 201 || correct.body.revision !== 2 || correct.body.alertsQueued !== 1) {
  throw new Error(`correct: ${JSON.stringify(correct.body)}`);
}
const { count: outboxCount } = await admin
  .from('notification_outbox').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId);
if (outboxCount !== 2) throw new Error(`outbox count after correction: ${outboxCount}`);
const { data: audits } = await admin
  .from('audit_logs').select('action').eq('tenant_id', tenantId)
  .in('action', ['attendance.marked', 'attendance.corrected']);
if (audits.length !== 2) throw new Error(`audit: ${JSON.stringify(audits)}`);
console.log('7. owner corrected register (revision 2, no duplicate alerts, audited)');

// 8. Student from stream B rejected for stream A register
const wrong = await api('/attendance', owner.token, tenantId, {
  classSectionId: sectionA, date: '2027-02-02',
  records: [{ studentId: daudi, status: 'present' }],
});
if (wrong.status !== 400 || wrong.body.code !== 'ATTENDANCE_STUDENT_NOT_ENROLLED') {
  throw new Error(`wrong-section: ${wrong.status} ${JSON.stringify(wrong.body)}`);
}
console.log('8. non-enrolled student rejected');

// Cleanup: archive test tenant
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` }).eq('id', tenantId);
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
console.log('9. test tenant archived\n\nSMOKE TEST PASSED');
