/**
 * End-to-end smoke test: parent portal (guardian linking WITHOUT tenant
 * membership, RLS isolation, children/report-card endpoints, cross-parent
 * denial) and fee reminders (queue, dedupe, drain).
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-parents.mjs
 * Requires: API on :4000 and apps/workers built.
 */
import { execFileSync } from 'node:child_process';
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

const parentEmail = `parent-${stamp}@example.com`;
const parent2Email = `parent2-${stamp}@example.com`;

// 1. Onboard; two students, each with a guardian that has email + phone
const owner = await makeUser(`par-owner-${stamp}@example.com`, 'Par Owner');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke Par ${stamp}`, slug: `smoke-par-${stamp}`, email: `par-owner-${stamp}@example.com`, defaultLanguage: 'sw' },
  academicYear: {
    name: '2027', startsOn: '2027-01-05', endsOn: '2027-12-04',
    terms: [{ name: 'Muhula wa Kwanza', startsOn: '2027-01-05', endsOn: '2027-06-12' }],
  },
  classes: [{ educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A'] }],
});
if (onboard.status !== 201) throw new Error(`onboard: ${JSON.stringify(onboard.body)}`);
const tenantId = onboard.body.tenantId;
const { data: sections } = await owner.client.from('class_sections').select('id').limit(1);
const sectionA = sections[0].id;
const { data: terms } = await owner.client.from('academic_terms').select('id');
const termId = terms[0].id;
for (const row of [
  { firstName: 'Neema', lastName: 'Joseph', gender: 'female', classSectionId: sectionA,
    guardian: { fullName: 'Mary Joseph', phone: `+2557${stamp.slice(-6)}31`, email: parentEmail, relationship: 'mother' } },
  { firstName: 'Baraka', lastName: 'Mushi', gender: 'male', classSectionId: sectionA,
    guardian: { fullName: 'John Mushi', phone: `+2557${stamp.slice(-6)}32`, email: parent2Email, relationship: 'father' } },
]) {
  const res = await api('/students', owner.token, tenantId, row);
  if (res.status !== 201) throw new Error(`student: ${JSON.stringify(res.body)}`);
}
const { data: students } = await owner.client.from('students').select('id, first_name').order('student_number');
const neema = students.find((s) => s.first_name === 'Neema').id;
console.log('1. school + 2 students with guardian emails');

// 2. Academic + finance data for the portal: attendance, published marks, invoice
await api('/attendance', owner.token, tenantId, {
  classSectionId: sectionA, date: '2027-02-01',
  records: students.map((s) => ({ studentId: s.id, status: s.id === neema ? 'present' : 'absent' })),
});
await api('/subjects/preset', owner.token, tenantId, { educationLevel: 'o_level' });
const { data: subjects } = await owner.client
  .from('subjects').select('id').eq('education_level', 'o_level').order('code').limit(1);
const assessment = await api('/assessments', owner.token, tenantId, {
  name: 'Midterm', type: 'midterm', classSectionId: sectionA, academicTermId: termId,
});
await api(`/assessments/${assessment.body.assessmentId}/scores`, owner.token, tenantId, {
  subjectId: subjects[0].id, rows: [{ studentId: neema, marks: 80 }],
});
await api(`/assessments/${assessment.body.assessmentId}/publish`, owner.token, tenantId);
const fee = await api('/finance/fee-items', owner.token, tenantId, { name: 'Ada ya Muhula', amount: 500000 });
const invoice = await api('/finance/invoices', owner.token, tenantId, {
  studentId: neema, lines: [{ feeItemId: fee.body.feeItemId }],
});
await api(`/finance/invoices/${invoice.body.invoiceId}/payments`, owner.token, tenantId, {
  amount: 200000, method: 'mpesa',
});
console.log('2. attendance + published marks + invoice (300,000 TZS balance) ready');

// 3. Parent invite via guardian; wrong cases first
const { data: guardians } = await owner.client
  .from('guardians').select('id, email').order('created_at');
const guardian1 = guardians.find((g) => g.email === parentEmail);
const guardian2 = guardians.find((g) => g.email === parent2Email);
const invite = await api(`/guardians/${guardian1.id}/invite`, owner.token, tenantId);
if (invite.status !== 201) throw new Error(`invite: ${JSON.stringify(invite.body)}`);
console.log('3. parent invite link created');

// 4. Parent accepts → guardian linked, NO tenant membership
const parent = await makeUser(parentEmail, 'Mary Joseph');
const accept = await api('/invitations/accept', parent.token, null, {
  token: invite.body.inviteUrl.split('/invite/')[1],
});
if (accept.body.portal !== 'parent' || accept.body.tenantId !== tenantId) {
  throw new Error(`accept: ${JSON.stringify(accept.body)}`);
}
const { data: linked } = await admin
  .from('guardians').select('user_id').eq('id', guardian1.id).single();
if (linked.user_id !== parent.id) throw new Error('guardian not linked');
const { count: memberships } = await admin
  .from('tenant_memberships').select('*', { count: 'exact', head: true })
  .eq('tenant_id', tenantId).eq('user_id', parent.id);
if (memberships !== 0) throw new Error('parent must NOT get a tenant membership');
console.log('4. parent linked to guardian; no tenant membership created');

// 5. RLS isolation: parent sees no students/tenants, only their own guardian row
const { data: rlsStudents } = await parent.client.from('students').select('id');
const { data: rlsTenants } = await parent.client.from('tenants').select('id');
const { data: rlsGuardian } = await parent.client.from('guardians').select('id');
if (rlsStudents.length !== 0 || rlsTenants.length !== 0) {
  throw new Error(`RLS leak: students ${rlsStudents.length}, tenants ${rlsTenants.length}`);
}
if (rlsGuardian.length !== 1 || rlsGuardian[0].id !== guardian1.id) {
  throw new Error(`guardian own-row RLS: ${JSON.stringify(rlsGuardian)}`);
}
console.log('5. RLS isolation holds (parent reads nothing but own guardian row)');

// 6. Portal: children + report card
const children = await api('/portal/children', parent.token, null, null, 'GET');
if (children.body.children.length !== 1) throw new Error(`children: ${JSON.stringify(children.body)}`);
const child = children.body.children[0];
if (child.studentId !== neema || child.balance !== 300000
  || child.attendance.present !== 1 || child.className !== 'Form 1 A') {
  throw new Error(`child: ${JSON.stringify(child)}`);
}
const report = await api(
  `/portal/children/${neema}/report-card?termId=${termId}`, parent.token, null, null, 'GET',
);
if (report.body.subjects.length !== 1 || report.body.subjects[0].grade !== 'A') {
  throw new Error(`report: ${JSON.stringify(report.body)}`);
}
console.log('6. portal shows child (balance, attendance, class) + published report card');

// 7. Cross-parent denial + unlinked user denial
const parent2 = await makeUser(parent2Email, 'John Mushi');
const invite2 = await api(`/guardians/${guardian2.id}/invite`, owner.token, tenantId);
await api('/invitations/accept', parent2.token, null, {
  token: invite2.body.inviteUrl.split('/invite/')[1],
});
const denied = await api(
  `/portal/children/${neema}/report-card?termId=${termId}`, parent2.token, null, null, 'GET',
);
if (denied.status !== 403) throw new Error(`cross-parent should be 403, got ${denied.status}`);
const stranger = await makeUser(`stranger-${stamp}@example.com`, 'Stranger');
const notLinked = await api('/portal/children', stranger.token, null, null, 'GET');
if (notLinked.status !== 403) throw new Error(`stranger should be 403, got ${notLinked.status}`);
// double invite guards
const reinvite = await api(`/guardians/${guardian1.id}/invite`, owner.token, tenantId);
if (reinvite.status !== 400 || reinvite.body.code !== 'GUARDIAN_ALREADY_LINKED') {
  throw new Error(`reinvite: ${JSON.stringify(reinvite.body)}`);
}
console.log('7. cross-parent 403, unlinked 403, re-invite of linked guardian rejected');

// 8. Fee reminders: queue → dedupe → drain
const reminders = await api('/finance/reminders', owner.token, tenantId);
if (reminders.status !== 201 || reminders.body.queued !== 1) {
  throw new Error(`reminders: ${JSON.stringify(reminders.body)}`);
}
const again = await api('/finance/reminders', owner.token, tenantId);
if (again.body.queued !== 0) throw new Error(`reminder dedupe: ${JSON.stringify(again.body)}`);
execFileSync('node', ['apps/workers/dist/drain-outbox.js', '--once'], {
  env: { ...process.env, SMS_DRIVER: 'console' },
  stdio: 'ignore',
});
const { data: reminderRows } = await admin
  .from('notification_outbox').select('status, payload')
  .eq('tenant_id', tenantId).eq('template', 'fees.reminder');
if (reminderRows.length !== 1 || reminderRows[0].status !== 'sent'
  || Number(reminderRows[0].payload.balance) !== 300000) {
  throw new Error(`reminder rows: ${JSON.stringify(reminderRows)}`);
}
console.log('8. fee reminder queued once (deduped), drained, balance 300,000 in payload');

// Cleanup
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` }).eq('id', tenantId);
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
console.log('9. test tenant archived\n\nSMOKE TEST PASSED');
