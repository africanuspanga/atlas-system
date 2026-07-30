/**
 * End-to-end smoke test: transport routes + stops, student assignment with
 * stop-route validation, re-assignment semantics, roster, RBAC.
 * Requires migration 00000000000020_transport.sql to be applied.
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-transport.mjs
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
const owner = await makeUser(`tr-owner-${stamp}@example.com`, 'TR Owner');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke TR ${stamp}`, slug: `smoke-tr-${stamp}`, email: `tr-owner-${stamp}@example.com`, defaultLanguage: 'sw' },
  academicYear: {
    name: '2027', startsOn: '2027-01-05', endsOn: '2027-12-04',
    terms: [{ name: 'Muhula wa Kwanza', startsOn: '2027-01-05', endsOn: '2027-06-12' }],
  },
  classes: [{ educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A'] }],
});
if (onboard.status !== 201) throw new Error(`onboard: ${onboard.status} ${JSON.stringify(onboard.body)}`);
const tenantId = onboard.body.tenantId;
const { data: years } = await owner.client.from('academic_years').select('id').eq('status', 'active');
const yearId = years[0].id;
console.log('1. school onboarded');

// 2. Two day students
for (const row of [
  { firstName: 'Neema', lastName: 'Mushi', gender: 'female' },
  { firstName: 'Baraka', lastName: 'Komba', gender: 'male' },
]) {
  const created = await api('/students', owner.token, tenantId, row);
  if (created.status !== 201) throw new Error(`student ${row.firstName}: ${created.status} ${JSON.stringify(created.body)}`);
}
const { data: students } = await owner.client.from('students').select('id, first_name');
const neema = students.find((s) => s.first_name === 'Neema').id;
const baraka = students.find((s) => s.first_name === 'Baraka').id;
console.log('2. students created');

// 3. Routes with fees; duplicate route name rejected with 409
const route1 = await api('/transport/routes', owner.token, tenantId, {
  name: 'Njia ya Mbezi', feeAmount: 150000,
});
if (route1.status !== 201 || !route1.body.routeId) throw new Error(`route1: ${route1.status} ${JSON.stringify(route1.body)}`);
const route2 = await api('/transport/routes', owner.token, tenantId, {
  name: 'Njia ya Tegeta', feeAmount: 120000,
});
if (route2.status !== 201) throw new Error(`route2: ${route2.status} ${JSON.stringify(route2.body)}`);
const dup = await api('/transport/routes', owner.token, tenantId, { name: 'Njia ya Mbezi' });
if (dup.status !== 409 || dup.body.code !== 'TRANSPORT_ROUTE_DUPLICATE') {
  throw new Error(`dup route: ${dup.status} ${JSON.stringify(dup.body)}`);
}
console.log('3. routes created (duplicate 409)');

// 4. Stops (ordered) on both routes
const stop1a = await api('/transport/stops', owner.token, tenantId, {
  routeId: route1.body.routeId, name: 'Mbezi Mwisho', sortOrder: 0,
});
const stop1b = await api('/transport/stops', owner.token, tenantId, {
  routeId: route1.body.routeId, name: 'Africana', sortOrder: 1,
});
const stop2a = await api('/transport/stops', owner.token, tenantId, {
  routeId: route2.body.routeId, name: 'Tegeta Kibaoni', sortOrder: 0,
});
if (stop1a.status !== 201 || stop1b.status !== 201 || stop2a.status !== 201) {
  throw new Error(`stops: ${stop1a.status}/${stop1b.status}/${stop2a.status}`);
}
console.log('4. stops created');

// 5. Assign Neema to route 1 at stop Africana
const assign1 = await api('/transport/assignments', owner.token, tenantId, {
  studentId: neema, routeId: route1.body.routeId, stopId: stop1b.body.stopId, academicYearId: yearId,
});
if (assign1.status !== 201 || !assign1.body.assignmentId) {
  throw new Error(`assign: ${assign1.status} ${JSON.stringify(assign1.body)}`);
}
console.log('5. student assigned to route + stop');

// 6. Stop from ANOTHER route rejected (TRANSPORT_STOP_MISMATCH)
const mismatch = await api('/transport/assignments', owner.token, tenantId, {
  studentId: baraka, routeId: route1.body.routeId, stopId: stop2a.body.stopId, academicYearId: yearId,
});
if (mismatch.status !== 400 || mismatch.body.code !== 'TRANSPORT_STOP_MISMATCH') {
  throw new Error(`mismatch: ${mismatch.status} ${JSON.stringify(mismatch.body)}`);
}
console.log('6. cross-route stop rejected (TRANSPORT_STOP_MISMATCH)');

// 7. Re-assignment deactivates the previous assignment
const reassign = await api('/transport/assignments', owner.token, tenantId, {
  studentId: neema, routeId: route2.body.routeId, stopId: stop2a.body.stopId, academicYearId: yearId,
});
if (reassign.status !== 201 || reassign.body.previousRouteId !== route1.body.routeId) {
  throw new Error(`reassign: ${reassign.status} ${JSON.stringify(reassign.body)}`);
}
const { data: assignments } = await admin
  .from('transport_assignments').select('route_id, active').eq('tenant_id', tenantId)
  .eq('student_id', neema);
const activeRows = assignments.filter((a) => a.active);
if (assignments.length !== 2 || activeRows.length !== 1 || activeRows[0].route_id !== route2.body.routeId) {
  throw new Error(`after reassign: ${JSON.stringify(assignments)}`);
}
console.log('7. re-assignment deactivated the old route');

// 8. Route list (stops ordered, counts) + roster
const list = await api('/transport', owner.token, tenantId, null, 'GET');
const r1 = list.body.data.find((r) => r.id === route1.body.routeId);
const r2 = list.body.data.find((r) => r.id === route2.body.routeId);
if (list.status !== 200 || r1.students !== 0 || r2.students !== 1
  || r1.stops.map((s) => s.name).join(',') !== 'Mbezi Mwisho,Africana'
  || r1.feeAmount !== 150000) {
  throw new Error(`list: ${JSON.stringify(list.body)}`);
}
const roster = await api(`/transport/routes/${route2.body.routeId}/students`, owner.token, tenantId, null, 'GET');
if (roster.status !== 200 || roster.body.data.length !== 1
  || !roster.body.data[0].name.startsWith('Neema')
  || roster.body.data[0].stop !== 'Tegeta Kibaoni') {
  throw new Error(`roster: ${roster.status} ${JSON.stringify(roster.body)}`);
}
console.log('8. route list + roster correct');

// 9. RBAC: teacher can view, cannot manage; audit trail exists
const invite = await api('/invitations', owner.token, tenantId, {
  email: `tr-teacher-${stamp}@example.com`, roleKeys: ['teacher'],
});
const inviteToken = invite.body.inviteUrl.split('/invite/')[1];
const teacher = await makeUser(`tr-teacher-${stamp}@example.com`, 'TR Teacher');
await api('/invitations/accept', teacher.token, null, { token: inviteToken });
const teacherView = await api('/transport', teacher.token, tenantId, null, 'GET');
if (teacherView.status !== 200) throw new Error(`teacher view: ${teacherView.status}`);
const teacherManage = await api('/transport/routes', teacher.token, tenantId, { name: 'X' });
if (teacherManage.status !== 403) throw new Error(`teacher manage should be 403, got ${teacherManage.status}`);
const { data: audits } = await admin
  .from('audit_logs').select('action').eq('tenant_id', tenantId)
  .in('action', ['transport.assigned', 'transport.reassigned']);
if (audits.length < 2) throw new Error(`audit: ${JSON.stringify(audits)}`);
console.log('9. RBAC enforced; assignments audited');

// Cleanup: archive test tenant
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` }).eq('id', tenantId);
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
console.log('10. test tenant archived\n\nSMOKE TEST PASSED');
