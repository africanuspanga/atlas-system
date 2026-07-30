/**
 * End-to-end smoke test: hostels, rooms, bed allocation guard rails
 * (day-student, gender, capacity), transfer semantics, release, RBAC.
 * Requires migration 00000000000019_hostel.sql to be applied.
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-hostel.mjs
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
const owner = await makeUser(`hs-owner-${stamp}@example.com`, 'HS Owner');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke HS ${stamp}`, slug: `smoke-hs-${stamp}`, email: `hs-owner-${stamp}@example.com`, defaultLanguage: 'sw' },
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

// 2. Students: three male boarders, one female boarder, one male day student
const roster = [
  { firstName: 'Juma', lastName: 'Hamisi', gender: 'male', boardingStatus: 'boarding' },
  { firstName: 'Ali', lastName: 'Mrisho', gender: 'male', boardingStatus: 'boarding' },
  { firstName: 'Musa', lastName: 'Kessy', gender: 'male', boardingStatus: 'boarding' },
  { firstName: 'Amina', lastName: 'Salum', gender: 'female', boardingStatus: 'boarding' },
  { firstName: 'David', lastName: 'Mroso', gender: 'male', boardingStatus: 'day' },
];
for (const row of roster) {
  const created = await api('/students', owner.token, tenantId, row);
  if (created.status !== 201) throw new Error(`student ${row.firstName}: ${created.status} ${JSON.stringify(created.body)}`);
}
const { data: students } = await owner.client
  .from('students').select('id, first_name, boarding_status');
const byName = (name) => students.find((s) => s.first_name === name).id;
const juma = byName('Juma'); const ali = byName('Ali'); const musa = byName('Musa');
const amina = byName('Amina'); const david = byName('David');
if (students.find((s) => s.first_name === 'Juma').boarding_status !== 'boarding') {
  throw new Error('boarding status not persisted');
}
console.log('2. students created (boarders + day)');

// 3. Hostel + room; duplicate name rejected with 409
const hostel = await api('/hostel', owner.token, tenantId, { name: 'Bweni la Wavulana', gender: 'male' });
if (hostel.status !== 201 || !hostel.body.hostelId) throw new Error(`hostel: ${hostel.status} ${JSON.stringify(hostel.body)}`);
const dup = await api('/hostel', owner.token, tenantId, { name: 'Bweni la Wavulana', gender: 'male' });
if (dup.status !== 409 || dup.body.code !== 'HOSTEL_DUPLICATE') {
  throw new Error(`dup hostel: ${dup.status} ${JSON.stringify(dup.body)}`);
}
const room1 = await api('/hostel/rooms', owner.token, tenantId, {
  hostelId: hostel.body.hostelId, name: 'Chumba 1', capacity: 2,
});
if (room1.status !== 201 || !room1.body.roomId) throw new Error(`room: ${room1.status} ${JSON.stringify(room1.body)}`);
console.log('3. hostel + room created (duplicate 409)');

// 4. Allocate a male boarder → OK, active allocation in DB
const alloc1 = await api('/hostel/allocations', owner.token, tenantId, {
  studentId: juma, roomId: room1.body.roomId, academicYearId: yearId,
});
if (alloc1.status !== 201 || !alloc1.body.allocationId) {
  throw new Error(`allocate: ${alloc1.status} ${JSON.stringify(alloc1.body)}`);
}
const { data: active1 } = await admin
  .from('hostel_allocations').select('id').eq('tenant_id', tenantId)
  .eq('student_id', juma).is('released_at', null);
if (active1.length !== 1) throw new Error(`active allocations after first: ${active1.length}`);
console.log('4. boarder allocated');

// 5. Day student rejected (HOSTEL_NOT_BOARDER)
const dayReject = await api('/hostel/allocations', owner.token, tenantId, {
  studentId: david, roomId: room1.body.roomId, academicYearId: yearId,
});
if (dayReject.status !== 400 || dayReject.body.code !== 'HOSTEL_NOT_BOARDER') {
  throw new Error(`day student: ${dayReject.status} ${JSON.stringify(dayReject.body)}`);
}
console.log('5. day student rejected (HOSTEL_NOT_BOARDER)');

// 6. Gender mismatch rejected (female student, male hostel)
const genderReject = await api('/hostel/allocations', owner.token, tenantId, {
  studentId: amina, roomId: room1.body.roomId, academicYearId: yearId,
});
if (genderReject.status !== 400 || genderReject.body.code !== 'HOSTEL_GENDER_MISMATCH') {
  throw new Error(`gender: ${genderReject.status} ${JSON.stringify(genderReject.body)}`);
}
console.log('6. gender mismatch rejected (HOSTEL_GENDER_MISMATCH)');

// 7. Fill the room to capacity → HOSTEL_ROOM_FULL
const alloc2 = await api('/hostel/allocations', owner.token, tenantId, {
  studentId: ali, roomId: room1.body.roomId, academicYearId: yearId,
});
if (alloc2.status !== 201) throw new Error(`second bed: ${alloc2.status} ${JSON.stringify(alloc2.body)}`);
const full = await api('/hostel/allocations', owner.token, tenantId, {
  studentId: musa, roomId: room1.body.roomId, academicYearId: yearId,
});
if (full.status !== 400 || full.body.code !== 'HOSTEL_ROOM_FULL') {
  throw new Error(`full room: ${full.status} ${JSON.stringify(full.body)}`);
}
console.log('7. room capacity enforced (HOSTEL_ROOM_FULL)');

// 8. Transfer: re-allocating releases the old bed in the same transaction
const room2 = await api('/hostel/rooms', owner.token, tenantId, {
  hostelId: hostel.body.hostelId, name: 'Chumba 2', capacity: 1,
});
const transfer = await api('/hostel/allocations', owner.token, tenantId, {
  studentId: juma, roomId: room2.body.roomId, academicYearId: yearId,
});
if (transfer.status !== 201 || transfer.body.transferredFromRoomId !== room1.body.roomId) {
  throw new Error(`transfer: ${transfer.status} ${JSON.stringify(transfer.body)}`);
}
const { data: jumaAllocs } = await admin
  .from('hostel_allocations').select('room_id, released_at').eq('tenant_id', tenantId)
  .eq('student_id', juma);
const jumaActive = jumaAllocs.filter((a) => a.released_at === null);
if (jumaActive.length !== 1 || jumaActive[0].room_id !== room2.body.roomId) {
  throw new Error(`after transfer: ${JSON.stringify(jumaAllocs)}`);
}
console.log('8. transfer re-allocated (old bed released)');

// 9. Occupancy view + occupants roster
const list = await api('/hostel', owner.token, tenantId, null, 'GET');
const rooms = list.body.data.find((h) => h.id === hostel.body.hostelId).rooms;
const r1 = rooms.find((r) => r.id === room1.body.roomId);
const r2 = rooms.find((r) => r.id === room2.body.roomId);
if (list.status !== 200 || r1.occupied !== 1 || r2.occupied !== 1) {
  throw new Error(`occupancy: ${JSON.stringify(list.body)}`);
}
const occupants = await api(`/hostel/rooms/${room2.body.roomId}/occupants`, owner.token, tenantId, null, 'GET');
if (occupants.status !== 200 || occupants.body.data.length !== 1
  || !occupants.body.data[0].name.startsWith('Juma')) {
  throw new Error(`occupants: ${occupants.status} ${JSON.stringify(occupants.body)}`);
}
console.log('9. occupancy counts + occupants roster correct');

// 10. Release; releasing twice fails cleanly
const release = await api(`/hostel/allocations/${transfer.body.allocationId}/release`, owner.token, tenantId, {});
if (release.status !== 201 || release.body.released !== true) {
  throw new Error(`release: ${release.status} ${JSON.stringify(release.body)}`);
}
const releaseAgain = await api(`/hostel/allocations/${transfer.body.allocationId}/release`, owner.token, tenantId, {});
if (releaseAgain.status !== 400 || releaseAgain.body.code !== 'HOSTEL_ALLOCATION_NOT_FOUND') {
  throw new Error(`double release: ${releaseAgain.status} ${JSON.stringify(releaseAgain.body)}`);
}
console.log('10. bed released (double release rejected)');

// 11. RBAC: teacher can view, cannot manage; audit trail exists
const invite = await api('/invitations', owner.token, tenantId, {
  email: `hs-teacher-${stamp}@example.com`, roleKeys: ['teacher'],
});
const inviteToken = invite.body.inviteUrl.split('/invite/')[1];
const teacher = await makeUser(`hs-teacher-${stamp}@example.com`, 'HS Teacher');
await api('/invitations/accept', teacher.token, null, { token: inviteToken });
const teacherView = await api('/hostel', teacher.token, tenantId, null, 'GET');
if (teacherView.status !== 200) throw new Error(`teacher view: ${teacherView.status}`);
const teacherManage = await api('/hostel', teacher.token, tenantId, { name: 'X', gender: 'male' });
if (teacherManage.status !== 403) throw new Error(`teacher manage should be 403, got ${teacherManage.status}`);
const { data: audits } = await admin
  .from('audit_logs').select('action').eq('tenant_id', tenantId)
  .in('action', ['hostel.allocated', 'hostel.transferred', 'hostel.released']);
if (audits.length < 4) throw new Error(`audit: ${JSON.stringify(audits)}`);
console.log('11. RBAC enforced; allocations audited');

// Cleanup: archive test tenant
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` }).eq('id', tenantId);
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
console.log('12. test tenant archived\n\nSMOKE TEST PASSED');
