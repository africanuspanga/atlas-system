/**
 * End-to-end smoke test: subjects presets, assessments, marks entry, NECTA
 * grading + division, report cards, publish locking, RBAC.
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-assessments.mjs
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

// 1. Owner onboards an O-Level school
const owner = await makeUser(`ass-owner-${stamp}@example.com`, 'Ass Owner');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke Ass ${stamp}`, slug: `smoke-ass-${stamp}`, email: `ass-owner-${stamp}@example.com`, defaultLanguage: 'sw' },
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
const { data: terms } = await owner.client.from('academic_terms').select('id, name');
const termId = terms[0].id;
console.log('1. school onboarded');

// 2. Tanzanian preset subjects: 12 created, second call idempotent
const preset = await api('/subjects/preset', owner.token, tenantId, { educationLevel: 'o_level' });
if (preset.body.created !== 12) throw new Error(`preset: ${JSON.stringify(preset.body)}`);
const again = await api('/subjects/preset', owner.token, tenantId, { educationLevel: 'o_level' });
if (again.body.created !== 0 || again.body.skipped !== 12) throw new Error(`preset again: ${JSON.stringify(again.body)}`);
await api('/subjects/preset', owner.token, tenantId, { educationLevel: 'primary' });
const { data: subjects } = await owner.client
  .from('subjects').select('id, code, education_level').eq('education_level', 'o_level').order('code');
const seven = subjects.slice(0, 7);
const civ = subjects.find((s) => s.code === 'CIV');
const { data: primarySubjects } = await owner.client
  .from('subjects').select('id').eq('education_level', 'primary').limit(1);
console.log('2. preset subjects added (12 o_level, idempotent) + primary set');

// 3. Students: Neema + Baraka in Form 1 A, Daudi in Form 1 B
for (const row of [
  { firstName: 'Neema', lastName: 'Joseph', gender: 'female', classSectionId: sectionA,
    guardian: { fullName: 'Mary Joseph', phone: `+2557${stamp.slice(-6)}11`, relationship: 'mother' } },
  { firstName: 'Baraka', lastName: 'Mushi', gender: 'male', classSectionId: sectionA },
  { firstName: 'Daudi', lastName: 'Mwakyusa', gender: 'male', classSectionId: sectionB },
]) {
  const res = await api('/students', owner.token, tenantId, row);
  if (res.status !== 201) throw new Error(`student: ${JSON.stringify(res.body)}`);
}
const { data: students } = await owner.client.from('students').select('id, first_name').order('student_number');
const neema = students.find((s) => s.first_name === 'Neema').id;
const baraka = students.find((s) => s.first_name === 'Baraka').id;
const daudi = students.find((s) => s.first_name === 'Daudi').id;
console.log('3. three students enrolled');

// 4. Attendance inside the term (feeds the report card)
const att = await api('/attendance', owner.token, tenantId, {
  classSectionId: sectionA, date: '2027-02-01',
  records: [
    { studentId: neema, status: 'present' },
    { studentId: baraka, status: 'absent' },
  ],
});
if (att.status !== 201) throw new Error(`attendance: ${JSON.stringify(att.body)}`);
console.log('4. attendance marked for the term');

// 5. Teacher: can enter marks, cannot create assessments or publish
const invite = await api('/invitations', owner.token, tenantId, {
  email: `ass-teacher-${stamp}@example.com`, roleKeys: ['teacher'],
});
const teacher = await makeUser(`ass-teacher-${stamp}@example.com`, 'Ass Teacher');
await api('/invitations/accept', teacher.token, null, { token: invite.body.inviteUrl.split('/invite/')[1] });
const deniedCreate = await api('/assessments', teacher.token, tenantId, {
  name: 'X', classSectionId: sectionA, academicTermId: termId,
});
if (deniedCreate.status !== 403) throw new Error(`teacher create should be 403, got ${deniedCreate.status}`);
console.log('5. teacher joined; denied exams.create');

// 6. Owner creates two assessments (weights 1 and 1)
const a1 = await api('/assessments', owner.token, tenantId, {
  name: 'Midterm', type: 'midterm', classSectionId: sectionA, academicTermId: termId,
});
if (a1.status !== 201) throw new Error(`assessment: ${JSON.stringify(a1.body)}`);
const dup = await api('/assessments', owner.token, tenantId, {
  name: 'Midterm', classSectionId: sectionA, academicTermId: termId,
});
if (dup.status !== 400 || dup.body.code !== 'ASSESSMENT_DUPLICATE_NAME') {
  throw new Error(`dup: ${dup.status} ${JSON.stringify(dup.body)}`);
}
const a2 = await api('/assessments', owner.token, tenantId, {
  name: 'Test 2', type: 'test', classSectionId: sectionA, academicTermId: termId,
});
console.log('6. assessments created; duplicate name rejected');

// 7. Teacher enters marks: Neema 80 (A), Baraka 50 (C) across 7 subjects
for (const subject of seven) {
  const res = await api(`/assessments/${a1.body.assessmentId}/scores`, teacher.token, tenantId, {
    subjectId: subject.id,
    rows: [
      { studentId: neema, marks: 80 },
      { studentId: baraka, marks: 50 },
    ],
  });
  if (res.status !== 201 || res.body.saved !== 2) throw new Error(`scores ${subject.code}: ${JSON.stringify(res.body)}`);
}
// second assessment: Neema drops to 60 in CIV → weighted CIV avg 70 → B
const t2 = await api(`/assessments/${a2.body.assessmentId}/scores`, teacher.token, tenantId, {
  subjectId: civ.id, rows: [{ studentId: neema, marks: 60 }],
});
if (t2.status !== 201) throw new Error(`t2 scores: ${JSON.stringify(t2.body)}`);
console.log('7. teacher entered marks (7 subjects × 2 students + weighted retest)');

// 8. Draft results are invisible on report cards
const draftReport = await api(`/assessments/report-card?studentId=${neema}&termId=${termId}`, owner.token, tenantId, null, 'GET');
if (draftReport.body.subjects.length !== 0 || draftReport.body.division !== null) {
  throw new Error(`draft report: ${JSON.stringify(draftReport.body)}`);
}
console.log('8. drafts excluded from report cards');

// 9. Teacher cannot publish; owner publishes both
const deniedPublish = await api(`/assessments/${a1.body.assessmentId}/publish`, teacher.token, tenantId);
if (deniedPublish.status !== 403) throw new Error(`teacher publish should be 403, got ${deniedPublish.status}`);
for (const id of [a1.body.assessmentId, a2.body.assessmentId]) {
  const pub = await api(`/assessments/${id}/publish`, owner.token, tenantId);
  if (pub.status !== 201) throw new Error(`publish: ${JSON.stringify(pub.body)}`);
}
const repub = await api(`/assessments/${a1.body.assessmentId}/publish`, owner.token, tenantId);
if (repub.status !== 400 || repub.body.code !== 'RESULTS_ALREADY_PUBLISHED') {
  throw new Error(`republish: ${JSON.stringify(repub.body)}`);
}
console.log('9. publish RBAC + double-publish guard OK');

// 10. NECTA report card: Neema Division I, Baraka Division II (boundary 21)
const neemaReport = (await api(`/assessments/report-card?studentId=${neema}&termId=${termId}`, owner.token, tenantId, null, 'GET')).body;
const civRow = neemaReport.subjects.find((s) => s.code === 'CIV');
if (Number(civRow.marks) !== 70 || civRow.grade !== 'B' || civRow.points !== 2) {
  throw new Error(`weighted CIV: ${JSON.stringify(civRow)}`);
}
if (neemaReport.points !== 8 || neemaReport.division !== 'I' || neemaReport.position !== 1
  || neemaReport.classSize !== 2 || Number(neemaReport.average) !== 78.6
  || neemaReport.attendance.present !== 1) {
  throw new Error(`neema report: ${JSON.stringify(neemaReport)}`);
}
const barakaReport = (await api(`/assessments/report-card?studentId=${baraka}&termId=${termId}`, owner.token, tenantId, null, 'GET')).body;
if (barakaReport.points !== 21 || barakaReport.division !== 'II' || barakaReport.position !== 2
  || Number(barakaReport.average) !== 50 || barakaReport.attendance.absent !== 1
  || !barakaReport.subjects.every((s) => s.grade === 'C')) {
  throw new Error(`baraka report: ${JSON.stringify(barakaReport)}`);
}
console.log('10. NECTA report cards correct (weighted avg, grades, Div I & II, position, attendance)');

// 11. Published assessments reject new marks; wrong-section + wrong-level rejected
const locked = await api(`/assessments/${a1.body.assessmentId}/scores`, teacher.token, tenantId, {
  subjectId: seven[0].id, rows: [{ studentId: neema, marks: 90 }],
});
if (locked.status !== 400 || locked.body.code !== 'SCORES_ASSESSMENT_PUBLISHED') {
  throw new Error(`locked: ${JSON.stringify(locked.body)}`);
}
const a3 = await api('/assessments', owner.token, tenantId, {
  name: 'Test 3', classSectionId: sectionA, academicTermId: termId,
});
const wrongStudent = await api(`/assessments/${a3.body.assessmentId}/scores`, owner.token, tenantId, {
  subjectId: seven[0].id, rows: [{ studentId: daudi, marks: 50 }],
});
if (wrongStudent.status !== 400 || wrongStudent.body.code !== 'SCORES_STUDENT_NOT_ENROLLED') {
  throw new Error(`wrong student: ${JSON.stringify(wrongStudent.body)}`);
}
const wrongLevel = await api(`/assessments/${a3.body.assessmentId}/scores`, owner.token, tenantId, {
  subjectId: primarySubjects[0].id, rows: [{ studentId: neema, marks: 50 }],
});
if (wrongLevel.status !== 400 || wrongLevel.body.code !== 'SCORES_SUBJECT_LEVEL_MISMATCH') {
  throw new Error(`wrong level: ${JSON.stringify(wrongLevel.body)}`);
}
console.log('11. publish lock + enrolment + subject-level guards OK');

// Cleanup: archive test tenant
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` }).eq('id', tenantId);
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
console.log('12. test tenant archived\n\nSMOKE TEST PASSED');
