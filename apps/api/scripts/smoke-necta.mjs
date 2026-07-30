/**
 * End-to-end smoke test: NECTA academic pack — A-Level subject combinations
 * (presets, assignment, O-Level rejection), cumulative CA summary across
 * terms with weights, and the candidate registration export.
 * Requires migration 0018 to be applied.
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-necta.mjs
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

// 1. Owner onboards a school with an A-Level AND an O-Level class, two terms
const owner = await makeUser(`necta-owner-${stamp}@example.com`, 'Necta Owner');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke Necta ${stamp}`, slug: `smoke-necta-${stamp}`, email: `necta-owner-${stamp}@example.com`, defaultLanguage: 'sw' },
  academicYear: {
    name: '2027', startsOn: '2027-01-05', endsOn: '2027-12-04',
    terms: [
      { name: 'Muhula wa Kwanza', startsOn: '2027-01-05', endsOn: '2027-06-12' },
      { name: 'Muhula wa Pili', startsOn: '2027-07-06', endsOn: '2027-12-04' },
    ],
  },
  classes: [
    { educationLevel: 'a_level', gradeName: 'Form 5', sequence: 5, streams: ['A'] },
    { educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A'] },
  ],
});
if (onboard.status !== 201) throw new Error(`onboard: ${onboard.status} ${JSON.stringify(onboard.body)}`);
const tenantId = onboard.body.tenantId;
const { data: sections } = await owner.client
  .from('class_sections').select('id, name, grade_levels(name)');
const form5A = sections.find((s) => s.grade_levels.name === 'Form 5').id;
const form1A = sections.find((s) => s.grade_levels.name === 'Form 1').id;
const { data: years } = await owner.client.from('academic_years').select('id');
const yearId = years[0].id;
const { data: terms } = await owner.client
  .from('academic_terms').select('id, sequence').order('sequence');
const [term1, term2] = terms.map((t) => t.id);
console.log('1. school onboarded (Form 5 a_level + Form 1 o_level, two terms)');

// 2. A-Level subject presets, then combination presets: 6 created (PCM, PCB,
//    CBG, EGM, HGE, HGL), 2 skipped for missing subjects (HKL→LIT, ECA→COM/ACC)
await api('/subjects/preset', owner.token, tenantId, { educationLevel: 'a_level' });
const preset = await api('/academics/combinations/preset', owner.token, tenantId, {});
if (preset.status !== 201 || preset.body.created !== 6 || preset.body.skipped !== 2) {
  throw new Error(`combination preset: ${preset.status} ${JSON.stringify(preset.body)}`);
}
const again = await api('/academics/combinations/preset', owner.token, tenantId, {});
if (again.body.created !== 0 || again.body.skipped !== 8) {
  throw new Error(`combination preset again: ${JSON.stringify(again.body)}`);
}
const list = await api('/academics/combinations', owner.token, tenantId, null, 'GET');
const pcm = list.body.data.find((c) => c.code === 'PCM');
const pcb = list.body.data.find((c) => c.code === 'PCB');
if (list.body.data.length !== 6 || !pcm || pcm.subjects.length !== 4
  || pcm.subjects.filter((s) => s.isPrincipal).length !== 3
  || !pcm.subjects.some((s) => s.code === 'GS' && !s.isPrincipal)) {
  throw new Error(`combinations list: ${JSON.stringify(list.body)}`);
}
console.log('2. combination presets: 6 created + 2 skipped, idempotent, PCM = 3 principals + GS');

// 3. Students: Amina in Form 5 A (A-Level), Baraka in Form 1 A (O-Level)
for (const row of [
  { firstName: 'Amina', lastName: 'Juma', gender: 'female', dateOfBirth: '2008-03-14', classSectionId: form5A },
  { firstName: 'Baraka', lastName: 'Mushi', gender: 'male', dateOfBirth: '2012-11-02', classSectionId: form1A },
]) {
  const res = await api('/students', owner.token, tenantId, row);
  if (res.status !== 201) throw new Error(`student: ${JSON.stringify(res.body)}`);
}
const { data: students } = await owner.client.from('students').select('id, first_name, student_number');
const amina = students.find((s) => s.first_name === 'Amina');
const baraka = students.find((s) => s.first_name === 'Baraka');
console.log('3. two students enrolled');

// 4. Assign PCB to Amina, then correct to PCM (upsert by student+year);
//    O-Level student rejected
const first = await api(`/academics/students/${amina.id}/combination`, owner.token, tenantId, {
  combinationId: pcb.id, academicYearId: yearId,
});
if (first.status !== 201 || first.body.combinationCode !== 'PCB') {
  throw new Error(`assign PCB: ${first.status} ${JSON.stringify(first.body)}`);
}
const second = await api(`/academics/students/${amina.id}/combination`, owner.token, tenantId, {
  combinationId: pcm.id, academicYearId: yearId,
});
if (second.status !== 201 || second.body.combinationCode !== 'PCM') {
  throw new Error(`assign PCM: ${JSON.stringify(second.body)}`);
}
const { data: assignments } = await admin
  .from('student_combinations').select('combination_id').eq('tenant_id', tenantId);
if (assignments.length !== 1 || assignments[0].combination_id !== pcm.id) {
  throw new Error(`student_combinations rows: ${JSON.stringify(assignments)}`);
}
const denied = await api(`/academics/students/${baraka.id}/combination`, owner.token, tenantId, {
  combinationId: pcm.id, academicYearId: yearId,
});
if (denied.status !== 400 || denied.body.code !== 'COMBINATION_NOT_A_LEVEL') {
  throw new Error(`o_level assign: ${denied.status} ${JSON.stringify(denied.body)}`);
}
console.log('4. combination upsert OK; O-Level student rejected (COMBINATION_NOT_A_LEVEL)');

// 5. Teacher cannot manage combinations (RBAC)
const invite = await api('/invitations', owner.token, tenantId, {
  email: `necta-teacher-${stamp}@example.com`, roleKeys: ['teacher'],
});
const teacher = await makeUser(`necta-teacher-${stamp}@example.com`, 'Necta Teacher');
await api('/invitations/accept', teacher.token, null, { token: invite.body.inviteUrl.split('/invite/')[1] });
const deniedPreset = await api('/academics/combinations/preset', teacher.token, tenantId, {});
if (deniedPreset.status !== 403) throw new Error(`teacher preset should be 403, got ${deniedPreset.status}`);
console.log('5. teacher denied academics.combinations.manage');

// 6. Two assessments in DIFFERENT terms (weights 1 and 3) — CA accumulates
//    across the year: PHY (80×1 + 60×3)/4 = 65 → C; CHE 90 (term 1 only) → A
const { data: subjects } = await owner.client
  .from('subjects').select('id, code').eq('education_level', 'a_level');
const phy = subjects.find((s) => s.code === 'PHY').id;
const che = subjects.find((s) => s.code === 'CHE').id;
const a1 = await api('/assessments', owner.token, tenantId, {
  name: 'Midterm T1', type: 'midterm', classSectionId: form5A, academicTermId: term1, weight: 1,
});
const a2 = await api('/assessments', owner.token, tenantId, {
  name: 'Terminal T2', type: 'terminal', classSectionId: form5A, academicTermId: term2, weight: 3,
});
if (a1.status !== 201 || a2.status !== 201) throw new Error(`assessments: ${JSON.stringify(a1.body)} ${JSON.stringify(a2.body)}`);
for (const [assessmentId, subjectId, marks] of [
  [a1.body.assessmentId, phy, 80],
  [a1.body.assessmentId, che, 90],
  [a2.body.assessmentId, phy, 60],
]) {
  const res = await api(`/assessments/${assessmentId}/scores`, owner.token, tenantId, {
    subjectId, rows: [{ studentId: amina.id, marks }],
  });
  if (res.status !== 201) throw new Error(`scores: ${JSON.stringify(res.body)}`);
}

// drafts are invisible to the CA summary
const draft = await api(`/academics/ca-summary?sectionId=${form5A}&yearId=${yearId}`, owner.token, tenantId, null, 'GET');
const draftRow = draft.body.rows.find((r) => r.studentId === amina.id);
if (draft.status !== 200 || draftRow.subjects.length !== 0 || draftRow.rank !== null) {
  throw new Error(`draft ca: ${JSON.stringify(draft.body)}`);
}
for (const id of [a1.body.assessmentId, a2.body.assessmentId]) {
  const pub = await api(`/assessments/${id}/publish`, owner.token, tenantId);
  if (pub.status !== 201) throw new Error(`publish: ${JSON.stringify(pub.body)}`);
}
console.log('6. two assessments in two terms published (weights 1 and 3); drafts excluded');

// 7. CA summary reflects both terms with weights
const ca = await api(`/academics/ca-summary?sectionId=${form5A}&yearId=${yearId}`, owner.token, tenantId, null, 'GET');
if (ca.status !== 200) throw new Error(`ca-summary: ${ca.status} ${JSON.stringify(ca.body)}`);
const row = ca.body.rows.find((r) => r.studentId === amina.id);
const phyRow = row.subjects.find((s) => s.code === 'PHY');
const cheRow = row.subjects.find((s) => s.code === 'CHE');
if (Number(phyRow.marks) !== 65 || phyRow.grade !== 'C'
  || Number(cheRow.marks) !== 90 || cheRow.grade !== 'A'
  || Number(row.average) !== 77.5 || row.rank !== 1
  || ca.body.educationLevel !== 'a_level' || ca.body.year.name !== '2027') {
  throw new Error(`ca row: ${JSON.stringify(ca.body)}`);
}
const badSection = await api(`/academics/ca-summary?sectionId=${amina.id}&yearId=${yearId}`, owner.token, tenantId, null, 'GET');
if (badSection.status !== 400 || badSection.body.code !== 'CA_SECTION_NOT_FOUND') {
  throw new Error(`bad section: ${JSON.stringify(badSection.body)}`);
}
console.log('7. CA summary: PHY 65 C (weighted across terms), CHE 90 A, average 77.5, rank 1');

// 8. Candidate export: A-Level rows carry the combination code; CSV ready
const exportRes = await api(`/academics/candidates-export?sectionId=${form5A}`, owner.token, tenantId, null, 'GET');
if (exportRes.status !== 200) throw new Error(`export: ${exportRes.status} ${JSON.stringify(exportRes.body)}`);
const candidate = exportRes.body.rows[0];
if (exportRes.body.candidates !== 1
  || candidate.fullName !== 'JUMA, AMINA'
  || candidate.gender !== 'F'
  || candidate.dateOfBirth !== '14/03/2008'
  || candidate.combination !== 'PCM'
  || candidate.studentNumber !== amina.student_number) {
  throw new Error(`candidate: ${JSON.stringify(exportRes.body)}`);
}
if (!exportRes.body.csv.includes('student_number,full_name,gender,date_of_birth,combination')
  || !exportRes.body.csv.includes('"JUMA, AMINA"')
  || !exportRes.body.csv.includes('PCM')) {
  throw new Error(`csv: ${exportRes.body.csv}`);
}
// O-Level export has no combination column
const oLevel = await api(`/academics/candidates-export?sectionId=${form1A}`, owner.token, tenantId, null, 'GET');
if (oLevel.body.csv.includes('combination') || oLevel.body.rows[0].fullName !== 'MUSHI, BARAKA') {
  throw new Error(`o_level csv: ${JSON.stringify(oLevel.body)}`);
}
// teacher lacks academics.manage
const deniedExport = await api(`/academics/candidates-export?sectionId=${form5A}`, teacher.token, tenantId, null, 'GET');
if (deniedExport.status !== 403) throw new Error(`teacher export should be 403, got ${deniedExport.status}`);
console.log('8. candidate export OK (surname-first uppercase, M/F, DD/MM/YYYY, combination; RBAC)');

// Cleanup: archive test tenant
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` }).eq('id', tenantId);
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
console.log('9. test tenant archived\n\nSMOKE TEST PASSED');
