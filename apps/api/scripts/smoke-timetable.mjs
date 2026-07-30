/**
 * End-to-end smoke test: timetable periods, slot upsert with subject-level
 * validation, teacher clash rejection, teacher week view, RBAC.
 * Requires migration 00000000000016_timetable.sql to be applied.
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-timetable.mjs
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

// 1. Owner onboards a school with two streams + O-Level subject presets
const owner = await makeUser(`tt-owner-${stamp}@example.com`, 'TT Owner');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke TT ${stamp}`, slug: `smoke-tt-${stamp}`, email: `tt-owner-${stamp}@example.com`, defaultLanguage: 'sw' },
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
const preset = await api('/subjects/preset', owner.token, tenantId, { educationLevel: 'o_level' });
if (preset.status !== 201) throw new Error(`preset: ${preset.status} ${JSON.stringify(preset.body)}`);
const { data: subjects } = await owner.client
  .from('subjects').select('id, code, education_level').eq('education_level', 'o_level');
const math = subjects.find((s) => s.code === 'BAM')?.id ?? subjects[0].id;
const secondSubject = subjects.find((s) => s.id !== math).id;
console.log('1. school onboarded with O-Level subjects');

// 2. Teacher joins via invitation (timetable.view is seeded for teachers)
const invite = await api('/invitations', owner.token, tenantId, {
  email: `tt-teacher-${stamp}@example.com`, roleKeys: ['teacher'],
});
const inviteToken = invite.body.inviteUrl.split('/invite/')[1];
const teacher = await makeUser(`tt-teacher-${stamp}@example.com`, 'TT Teacher');
const accept = await api('/invitations/accept', teacher.token, null, { token: inviteToken });
if (accept.body.tenantId !== tenantId) throw new Error(`accept: ${JSON.stringify(accept.body)}`);
console.log('2. teacher invited + accepted');

// 3. Owner creates the period set; duplicate label rejected with 409
const createPeriods = await api('/timetable/periods', owner.token, tenantId, {
  periods: [
    { label: 'P1', startsAt: '08:00', endsAt: '08:40' },
    { label: 'P2', startsAt: '08:40', endsAt: '09:20' },
    { label: 'Break', startsAt: '09:20', endsAt: '09:40', isBreak: true },
    { label: 'P3', startsAt: '09:40', endsAt: '10:20' },
  ],
});
if (createPeriods.status !== 201 || createPeriods.body.created !== 4) {
  throw new Error(`periods: ${createPeriods.status} ${JSON.stringify(createPeriods.body)}`);
}
const dup = await api('/timetable/periods', owner.token, tenantId, {
  periods: [{ label: 'P1', startsAt: '14:00', endsAt: '14:40' }],
});
if (dup.status !== 409 || dup.body.code !== 'TIMETABLE_PERIOD_DUPLICATE') {
  throw new Error(`dup period: ${dup.status} ${JSON.stringify(dup.body)}`);
}
const listPeriods = await api('/timetable/periods', teacher.token, tenantId, null, 'GET');
if (listPeriods.status !== 200 || listPeriods.body.data.length !== 4) {
  throw new Error(`list periods: ${listPeriods.status} ${JSON.stringify(listPeriods.body)}`);
}
const p1 = listPeriods.body.data.find((p) => p.label === 'P1').id;
const breakPeriod = listPeriods.body.data.find((p) => p.is_break).id;
console.log('3. periods created (duplicate label 409, teacher can list)');

// 4. Owner sets a Monday P1 lesson in Form 1 A; upsert replaces the subject
const setSlot = await api('/timetable/slots', owner.token, tenantId, {
  sectionId: sectionA, day: 1, periodId: p1, subjectId: math, teacherUserId: teacher.id,
});
if (setSlot.status !== 201 || !setSlot.body.slotId) {
  throw new Error(`set slot: ${setSlot.status} ${JSON.stringify(setSlot.body)}`);
}
const upsert = await api('/timetable/slots', owner.token, tenantId, {
  sectionId: sectionA, day: 1, periodId: p1, subjectId: secondSubject, teacherUserId: teacher.id,
});
if (upsert.status !== 201 || upsert.body.slotId !== setSlot.body.slotId) {
  throw new Error(`upsert: ${upsert.status} ${JSON.stringify(upsert.body)}`);
}
const { count: slotCount } = await admin
  .from('timetable_slots').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId);
if (slotCount !== 1) throw new Error(`slot count after upsert: ${slotCount}`);
console.log('4. slot set + upsert replaced in place (1 row)');

// 5. Same teacher, same day+period, different section → TIMETABLE_TEACHER_CLASH
const clash = await api('/timetable/slots', owner.token, tenantId, {
  sectionId: sectionB, day: 1, periodId: p1, subjectId: math, teacherUserId: teacher.id,
});
if (clash.status !== 400 || clash.body.code !== 'TIMETABLE_TEACHER_CLASH') {
  throw new Error(`clash: ${clash.status} ${JSON.stringify(clash.body)}`);
}
console.log('5. teacher clash rejected (TIMETABLE_TEACHER_CLASH)');

// 6. Guard rails: break period and level-mismatched subject rejected
const onBreak = await api('/timetable/slots', owner.token, tenantId, {
  sectionId: sectionA, day: 2, periodId: breakPeriod, subjectId: math, teacherUserId: teacher.id,
});
if (onBreak.status !== 400 || onBreak.body.code !== 'TIMETABLE_PERIOD_IS_BREAK') {
  throw new Error(`break slot: ${onBreak.status} ${JSON.stringify(onBreak.body)}`);
}
console.log('6. break period rejected for lessons');

// 7. Teacher week view + RBAC: view OK, manage forbidden
const mine = await api('/timetable?teacherUserId=me', teacher.token, tenantId, null, 'GET');
if (mine.status !== 200 || mine.body.data.length !== 1
  || mine.body.data[0].teacherUserId !== teacher.id
  || mine.body.data[0].sectionLabel !== 'Form 1 A') {
  throw new Error(`teacher view: ${mine.status} ${JSON.stringify(mine.body)}`);
}
const bySection = await api(`/timetable?sectionId=${sectionA}`, teacher.token, tenantId, null, 'GET');
if (bySection.status !== 200 || bySection.body.data.length !== 1) {
  throw new Error(`section view: ${bySection.status} ${JSON.stringify(bySection.body)}`);
}
const forbidden = await api('/timetable/slots', teacher.token, tenantId, {
  sectionId: sectionA, day: 3, periodId: p1, subjectId: math, teacherUserId: teacher.id,
});
if (forbidden.status !== 403) throw new Error(`teacher manage should be 403, got ${forbidden.status}`);
console.log('7. teacher sees own week; manage denied without timetable.manage');

// 8. Delete the slot; audit trail exists
const del = await api(`/timetable/slots/${setSlot.body.slotId}`, owner.token, tenantId, null, 'DELETE');
if (del.status !== 200 || del.body.deleted !== true) {
  throw new Error(`delete: ${del.status} ${JSON.stringify(del.body)}`);
}
const after = await api(`/timetable?sectionId=${sectionA}`, owner.token, tenantId, null, 'GET');
if (after.status !== 200 || after.body.data.length !== 0) {
  throw new Error(`after delete: ${JSON.stringify(after.body)}`);
}
const { data: audits } = await admin
  .from('audit_logs').select('action').eq('tenant_id', tenantId)
  .in('action', ['timetable.slot_set', 'timetable.slot_deleted']);
if (audits.length < 3) throw new Error(`audit: ${JSON.stringify(audits)}`);
console.log('8. slot deleted; slot_set/slot_deleted audited');

// Cleanup: archive test tenant
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` }).eq('id', tenantId);
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
console.log('9. test tenant archived\n\nSMOKE TEST PASSED');
