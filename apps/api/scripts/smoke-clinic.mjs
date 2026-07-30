/**
 * End-to-end smoke test: clinic visits, guardian SMS via notification_outbox
 * (same-transaction queue, clinic.visit template), date filtering, RBAC.
 * Requires migration 00000000000023_clinic.sql to be applied.
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-clinic.mjs
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
const owner = await makeUser(`cl-owner-${stamp}@example.com`, 'Cl Owner');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke Clinic ${stamp}`, slug: `smoke-cl-${stamp}`, email: `cl-owner-${stamp}@example.com`, defaultLanguage: 'sw' },
  academicYear: {
    name: '2027', startsOn: '2027-01-05', endsOn: '2027-12-04',
    terms: [{ name: 'Muhula wa Kwanza', startsOn: '2027-01-05', endsOn: '2027-06-12' }],
  },
  classes: [{ educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A'] }],
});
if (onboard.status !== 201) throw new Error(`onboard: ${onboard.status} ${JSON.stringify(onboard.body)}`);
const tenantId = onboard.body.tenantId;
console.log('1. school onboarded');

// 2. Neema has a primary guardian with a phone; Baraka has none
for (const row of [
  { firstName: 'Neema', lastName: 'Joseph', gender: 'female',
    guardian: { fullName: 'Mary Joseph', phone: `+2557${stamp.slice(-6)}11`, relationship: 'mother' } },
  { firstName: 'Baraka', lastName: 'Mushi', gender: 'male' },
]) {
  const created = await api('/students', owner.token, tenantId, row);
  if (created.status !== 201) throw new Error(`student ${row.firstName}: ${created.status} ${JSON.stringify(created.body)}`);
}
const { data: students } = await owner.client.from('students').select('id, first_name');
const neema = students.find((s) => s.first_name === 'Neema').id;
const baraka = students.find((s) => s.first_name === 'Baraka').id;
const { data: guardians } = await admin
  .from('guardians').select('phone').eq('tenant_id', tenantId);
const guardianPhone = guardians[0].phone;
console.log('2. students created (one guardian with phone)');

// 3. Visit WITHOUT notify → recorded, notified=false, outbox empty
const quiet = await api('/clinic/visits', owner.token, tenantId, {
  studentId: baraka, symptoms: 'Homa na kikohozi', treatment: 'Panadol',
});
if (quiet.status !== 201 || !quiet.body.visitId || quiet.body.notified !== false) {
  throw new Error(`quiet visit: ${quiet.status} ${JSON.stringify(quiet.body)}`);
}
let { count: outboxCount } = await admin
  .from('notification_outbox').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId);
if (outboxCount !== 0) throw new Error(`outbox after quiet visit: ${outboxCount}`);
console.log('3. visit without notify (no SMS queued)');

// 4. Visit WITH notify → SMS queued in the same transaction (clinic.visit)
const notified = await api('/clinic/visits', owner.token, tenantId, {
  studentId: neema, symptoms: 'Maumivu ya tumbo', treatment: 'ORS na kupumzika',
  notes: 'Amruhusiwe kwenda bwenini', notifyGuardian: true,
});
if (notified.status !== 201 || notified.body.notified !== true) {
  throw new Error(`notified visit: ${notified.status} ${JSON.stringify(notified.body)}`);
}
const { data: outbox } = await admin
  .from('notification_outbox').select('recipient, template, payload, status')
  .eq('tenant_id', tenantId);
if (outbox.length !== 1 || outbox[0].template !== 'clinic.visit'
  || outbox[0].recipient !== guardianPhone
  || outbox[0].payload.studentId !== neema
  || outbox[0].payload.treatment !== 'ORS na kupumzika'
  || outbox[0].payload.visitId !== notified.body.visitId
  || outbox[0].status !== 'pending') {
  throw new Error(`outbox: ${JSON.stringify(outbox)}`);
}
console.log('4. notify visit queued 1 pending clinic.visit SMS to the guardian');

// 5. Notify requested for a student WITHOUT a reachable guardian → notified=false
const noGuardian = await api('/clinic/visits', owner.token, tenantId, {
  studentId: baraka, symptoms: 'Jeraha dogo mkononi', notifyGuardian: true,
});
if (noGuardian.status !== 201 || noGuardian.body.notified !== false) {
  throw new Error(`no-guardian visit: ${noGuardian.status} ${JSON.stringify(noGuardian.body)}`);
}
({ count: outboxCount } = await admin
  .from('notification_outbox').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId));
if (outboxCount !== 1) throw new Error(`outbox after no-guardian notify: ${outboxCount}`);
console.log('5. notify without reachable guardian → visit saved, no SMS');

// 6. Listing with student names; from/to window filters
const all = await api('/clinic/visits', owner.token, tenantId, null, 'GET');
if (all.status !== 200 || all.body.data.length !== 3
  || all.body.data.some((v) => v.studentName === '')) {
  throw new Error(`visits: ${all.status} ${JSON.stringify(all.body)}`);
}
const today = new Date().toISOString().slice(0, 10);
const windowed = await api(`/clinic/visits?from=${today}&to=${today}`, owner.token, tenantId, null, 'GET');
if (windowed.status !== 200 || windowed.body.data.length !== 3) {
  throw new Error(`windowed: ${windowed.status} ${JSON.stringify(windowed.body)}`);
}
const empty = await api('/clinic/visits?from=2000-01-01&to=2000-01-02', owner.token, tenantId, null, 'GET');
if (empty.status !== 200 || empty.body.data.length !== 0) {
  throw new Error(`empty window: ${empty.status} ${JSON.stringify(empty.body)}`);
}
const badQuery = await api('/clinic/visits?from=not-a-date', owner.token, tenantId, null, 'GET');
if (badQuery.status !== 400 || badQuery.body.code !== 'CLINIC_QUERY_INVALID') {
  throw new Error(`bad query: ${badQuery.status} ${JSON.stringify(badQuery.body)}`);
}
console.log('6. visit listing + date filters correct');

// 7. RBAC: teacher can view, cannot record; audit trail exists
const invite = await api('/invitations', owner.token, tenantId, {
  email: `cl-teacher-${stamp}@example.com`, roleKeys: ['teacher'],
});
const teacher = await makeUser(`cl-teacher-${stamp}@example.com`, 'Cl Teacher');
await api('/invitations/accept', teacher.token, null, {
  token: invite.body.inviteUrl.split('/invite/')[1],
});
const teacherView = await api('/clinic/visits', teacher.token, tenantId, null, 'GET');
if (teacherView.status !== 200) throw new Error(`teacher view: ${teacherView.status}`);
const teacherRecord = await api('/clinic/visits', teacher.token, tenantId, {
  studentId: neema, symptoms: 'Hairuhusiwi',
});
if (teacherRecord.status !== 403) throw new Error(`teacher record should be 403, got ${teacherRecord.status}`);
const { data: audits } = await admin
  .from('audit_logs').select('action').eq('tenant_id', tenantId)
  .eq('action', 'clinic.visit_recorded');
if (audits.length !== 3) throw new Error(`audit: ${JSON.stringify(audits)}`);
console.log('7. RBAC enforced; visits audited');

// Cleanup: archive test tenant
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` }).eq('id', tenantId);
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
console.log('8. test tenant archived\n\nSMOKE TEST PASSED');
