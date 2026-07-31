/**
 * End-to-end smoke test: student & academic lifecycle (THEME 4 of the
 * 2026-07-31 code review).
 *
 * REQUIRES migration 00000000000030_student_lifecycle.sql to be applied to the
 * target database. Every assertion below drives an RPC it introduces
 * (set_student_status, set_class_enrolment, create_academic_year,
 * activate_academic_year); against an un-migrated DB the first PATCH comes
 * back 500 with code ENROLMENT_FAILED instead of doing anything useful.
 *
 * What it proves, in the order the four holes were reported:
 *   LIFE-030-B  a student created with no class can be given one
 *   LIFE-030-C  a mistyped stream can be corrected — one enrolment row, moved
 *   LIFE-030-A  a leaver can be retired: enrolment closed, plan seat freed
 *   LIFE-030-D  a school can roll over into a second academic year
 * plus the guards around them: students.archive gates terminal statuses, and
 * an id from another tenant is a 404, never a cross-tenant write.
 *
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-lifecycle.mjs
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

/**
 * Stable business code out of a 4xx body. Nest renders
 * `new BadRequestException({ code })` as the bare object, but a few paths nest
 * it under `message` — check both, like the other smokes do inline.
 */
function codeOf(res) {
  const body = res.body ?? {};
  return body.code ?? body.message?.code ?? null;
}

/** Every enrolment row a student has, across all years. */
async function enrolmentsOf(studentId) {
  const { data, error } = await admin
    .from('class_enrolments')
    .select('id, class_section_id, academic_year_id, status')
    .eq('student_id', studentId);
  if (error) throw new Error(`enrolments read: ${error.message}`);
  return data ?? [];
}

/** Plan seats in use — app.tenant_entitlements counts students.status='active'. */
async function seatsUsed(tid) {
  const { data, error } = await admin.rpc('tenant_entitlements', { p_tenant_id: tid });
  if (error) throw new Error(`entitlements: ${error.message}`);
  return data.usage.students;
}

async function auditCount(tid, action) {
  const { count, error } = await admin
    .from('audit_logs')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tid)
    .eq('action', action);
  if (error) throw new Error(`audit read: ${error.message}`);
  return count;
}

// ---------------------------------------------------------------------------
// 1. Onboard a school; create a student with NO class → zero enrolment rows.
//    (A second student, correctly placed, keeps the seat maths non-trivial and
//    gives step 6 an untouched subject.)
// ---------------------------------------------------------------------------
const owner = await makeUser(`life-owner-${stamp}@example.com`, 'Lifecycle Owner');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke Lifecycle ${stamp}`, slug: `smoke-life-${stamp}`, email: `life-owner-${stamp}@example.com`, defaultLanguage: 'sw' },
  academicYear: {
    name: '2027', startsOn: '2027-01-05', endsOn: '2027-12-04',
    terms: [{ name: 'Muhula wa Kwanza', startsOn: '2027-01-05', endsOn: '2027-06-12' }],
  },
  classes: [{ educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A', 'B'] }],
});
if (onboard.status !== 201) throw new Error(`onboard: ${onboard.status} ${JSON.stringify(onboard.body)}`);
const tenantId = onboard.body.tenantId;
const yearId = onboard.body.academicYearId;

const { data: sections } = await admin
  .from('class_sections')
  .select('id, name, grade_level_id, academic_year_id')
  .eq('tenant_id', tenantId)
  .order('name');
if (sections.length !== 2) throw new Error(`expected 2 sections, got ${sections.length}`);
const [sectionA, sectionB] = sections;

const noClass = await api('/students', owner.token, tenantId, {
  firstName: 'Asha', lastName: 'Kimaro', gender: 'female', dateOfBirth: '2012-05-09',
});
if (noClass.status !== 201 || noClass.body.imported !== 1) {
  throw new Error(`create unplaced student: ${noClass.status} ${JSON.stringify(noClass.body)}`);
}
const placed = await api('/students', owner.token, tenantId, {
  firstName: 'Juma', lastName: 'Mbwana', gender: 'male', classSectionId: sectionA.id,
});
if (placed.status !== 201 || placed.body.imported !== 1) {
  throw new Error(`create placed student: ${placed.status} ${JSON.stringify(placed.body)}`);
}

const { data: roster } = await admin
  .from('students')
  .select('id, first_name, student_number, status')
  .eq('tenant_id', tenantId)
  .order('student_number');
const asha = roster.find((s) => s.first_name === 'Asha');
const juma = roster.find((s) => s.first_name === 'Juma');
if (!asha || !juma) throw new Error(`roster: ${JSON.stringify(roster)}`);
if ((await enrolmentsOf(asha.id)).length !== 0) {
  throw new Error('student created without a class should have zero enrolments');
}
// Sanity: the assertion above is not vacuous — the placed student does have one.
if ((await enrolmentsOf(juma.id)).length !== 1) {
  throw new Error('student created with a class should have exactly one enrolment');
}
console.log('1. school onboarded; unplaced student has zero class_enrolments');

// ---------------------------------------------------------------------------
// 2. Assign a class to the unplaced student (LIFE-030-B).
// ---------------------------------------------------------------------------
const assign = await api(`/students/${asha.id}/enrolment`, owner.token, tenantId, {
  classSectionId: sectionA.id,
}, 'PATCH');
if (assign.status !== 200 || assign.body.changed !== true) {
  throw new Error(`assign: ${assign.status} ${JSON.stringify(assign.body)}`);
}
const afterAssign = await enrolmentsOf(asha.id);
if (afterAssign.length !== 1) throw new Error(`expected 1 enrolment, got ${afterAssign.length}`);
if (afterAssign[0].class_section_id !== sectionA.id
    || afterAssign[0].academic_year_id !== yearId
    || afterAssign[0].status !== 'active') {
  throw new Error(`assigned enrolment wrong: ${JSON.stringify(afterAssign[0])}`);
}
const enrolmentId = afterAssign[0].id;
if (assign.body.enrolmentId !== enrolmentId) {
  throw new Error(`response enrolmentId ${assign.body.enrolmentId} != row ${enrolmentId}`);
}
console.log('2. enrolment assigned: one active row on Form 1 A');

// ---------------------------------------------------------------------------
// 3. Correct a mistyped stream (LIFE-030-C). This is the case that was
//    impossible before 0030: unique (student_id, academic_year_id) blocks a
//    second insert and nothing ever UPDATEd the row, so the pupil was stuck on
//    the wrong register for the whole year.
// ---------------------------------------------------------------------------
const transfer = await api(`/students/${asha.id}/enrolment`, owner.token, tenantId, {
  classSectionId: sectionB.id,
}, 'PATCH');
if (transfer.status !== 200 || transfer.body.changed !== true) {
  throw new Error(`transfer: ${transfer.status} ${JSON.stringify(transfer.body)}`);
}
const afterTransfer = await enrolmentsOf(asha.id);
if (afterTransfer.length !== 1) {
  throw new Error(`transfer must move the row, not add one — got ${afterTransfer.length} rows`);
}
if (afterTransfer[0].id !== enrolmentId) {
  throw new Error('transfer replaced the enrolment row instead of updating it');
}
if (afterTransfer[0].class_section_id !== sectionB.id || afterTransfer[0].status !== 'active') {
  throw new Error(`transferred enrolment wrong: ${JSON.stringify(afterTransfer[0])}`);
}
console.log('3. stream corrected in place: still one row, now Form 1 B');

// ---------------------------------------------------------------------------
// 4. Same section again → idempotent: 200, changed:false, no audit noise.
// ---------------------------------------------------------------------------
const repeat = await api(`/students/${asha.id}/enrolment`, owner.token, tenantId, {
  classSectionId: sectionB.id,
}, 'PATCH');
if (repeat.status !== 200 || repeat.body.changed !== false) {
  throw new Error(`idempotent repeat: ${repeat.status} ${JSON.stringify(repeat.body)}`);
}
const afterRepeat = await enrolmentsOf(asha.id);
if (afterRepeat.length !== 1 || afterRepeat[0].class_section_id !== sectionB.id) {
  throw new Error(`repeat changed state: ${JSON.stringify(afterRepeat)}`);
}
if (await auditCount(tenantId, 'enrolment.assigned') !== 1) {
  throw new Error('expected exactly one enrolment.assigned audit row');
}
if (await auditCount(tenantId, 'enrolment.transferred') !== 1) {
  throw new Error('idempotent repeat wrote a second enrolment.transferred audit row');
}
console.log('4. repeat with the same section is idempotent (changed:false, no audit row)');

// ---------------------------------------------------------------------------
// 5. Withdraw a leaver (LIFE-030-A): status set, enrolment closed, seat freed.
// ---------------------------------------------------------------------------
const seatsBefore = await seatsUsed(tenantId);
if (seatsBefore !== 2) throw new Error(`expected 2 seats in use, got ${seatsBefore}`);
const withdraw = await api(`/students/${asha.id}/status`, owner.token, tenantId, {
  status: 'withdrawn', reason: 'Family moved to Mwanza (smoke test)',
}, 'PATCH');
if (withdraw.status !== 200 || withdraw.body.status !== 'withdrawn' || withdraw.body.changed !== true) {
  throw new Error(`withdraw: ${withdraw.status} ${JSON.stringify(withdraw.body)}`);
}
const { data: ashaRow } = await admin.from('students').select('status').eq('id', asha.id).single();
if (ashaRow.status !== 'withdrawn') throw new Error(`students.status: ${ashaRow.status}`);
const afterWithdraw = await enrolmentsOf(asha.id);
if (afterWithdraw.length !== 1 || afterWithdraw[0].status !== 'left') {
  throw new Error(`enrolment not closed: ${JSON.stringify(afterWithdraw)}`);
}
const seatsAfter = await seatsUsed(tenantId);
if (seatsAfter !== seatsBefore - 1) {
  throw new Error(`plan seat not freed: ${seatsBefore} -> ${seatsAfter}`);
}
const { data: statusAudit } = await admin
  .from('audit_logs')
  .select('before, after')
  .eq('tenant_id', tenantId)
  .eq('action', 'student.status_changed')
  .eq('entity_id', asha.id);
if (statusAudit.length !== 1 || statusAudit[0].before.status !== 'active'
    || statusAudit[0].after.status !== 'withdrawn' || !statusAudit[0].after.reason) {
  throw new Error(`status audit: ${JSON.stringify(statusAudit)}`);
}
console.log(`5. withdrawn: enrolment 'left', seat freed (${seatsBefore} -> ${seatsAfter}), audited`);

// ---------------------------------------------------------------------------
// 6. Permission negative: students.update alone must NOT retire a pupil.
//    No system role has students.update without students.archive, and editing
//    a system role would leak into every other tenant — so build a
//    tenant-scoped role, which is exactly what a school would do.
// ---------------------------------------------------------------------------
const invite = await api('/invitations', owner.token, tenantId, {
  email: `life-clerk-${stamp}@example.com`, roleKeys: ['teacher'],
});
if (invite.status !== 201) throw new Error(`invite: ${JSON.stringify(invite.body)}`);
const clerk = await makeUser(`life-clerk-${stamp}@example.com`, 'Lifecycle Clerk');
const accept = await api('/invitations/accept', clerk.token, null, {
  token: invite.body.inviteUrl.split('/invite/')[1],
});
if (accept.body.tenantId !== tenantId) throw new Error(`accept: ${JSON.stringify(accept.body)}`);

const { data: clerkRole, error: roleError } = await admin
  .from('roles')
  .insert({ tenant_id: tenantId, key: `registrar-${stamp}`, name: '[test] Registrar' })
  .select('id')
  .single();
if (roleError) throw new Error(`custom role: ${roleError.message}`);
const { error: permError } = await admin.from('role_permissions').insert([
  { role_id: clerkRole.id, permission_key: 'students.view' },
  { role_id: clerkRole.id, permission_key: 'students.update' },
]);
if (permError) throw new Error(`role permissions: ${permError.message}`);
const { data: clerkMembership } = await admin
  .from('tenant_memberships')
  .select('id')
  .eq('tenant_id', tenantId)
  .eq('user_id', clerk.id)
  .single();
const { error: bindError } = await admin
  .from('membership_roles')
  .insert({ membership_id: clerkMembership.id, role_id: clerkRole.id });
if (bindError) throw new Error(`membership role: ${bindError.message}`);

// Positive control: students.update alone reaches the handler (a no-op set to
// the status the pupil already has). Without this, a broken role grant would
// make the 403 below pass for the wrong reason.
const clerkAllowed = await api(`/students/${juma.id}/status`, clerk.token, tenantId, {
  status: 'active',
}, 'PATCH');
if (clerkAllowed.status !== 200 || clerkAllowed.body.changed !== false) {
  throw new Error(`students.update should be allowed: ${clerkAllowed.status} ${JSON.stringify(clerkAllowed.body)}`);
}
const clerkDenied = await api(`/students/${juma.id}/status`, clerk.token, tenantId, {
  status: 'graduated',
}, 'PATCH');
if (clerkDenied.status !== 403 || codeOf(clerkDenied) !== 'STUDENTS_ARCHIVE_REQUIRED') {
  throw new Error(`terminal status without students.archive: ${clerkDenied.status} ${JSON.stringify(clerkDenied.body)}`);
}
const { data: jumaRow } = await admin.from('students').select('status').eq('id', juma.id).single();
if (jumaRow.status !== 'active') throw new Error(`denied call still wrote: ${jumaRow.status}`);
console.log('6. students.update alone: no-op allowed, terminal status 403 (needs students.archive)');

// ---------------------------------------------------------------------------
// 7. Cross-tenant negatives: a foreign id is a 404, never a leak or a write.
// ---------------------------------------------------------------------------
const owner2 = await makeUser(`life-owner2-${stamp}@example.com`, 'Lifecycle Owner Two');
const onboard2 = await api('/onboarding', owner2.token, null, {
  school: { name: `Smoke Lifecycle Two ${stamp}`, slug: `smoke-life2-${stamp}`, email: `life-owner2-${stamp}@example.com`, defaultLanguage: 'sw' },
  academicYear: {
    name: '2027', startsOn: '2027-01-05', endsOn: '2027-12-04',
    terms: [{ name: 'Muhula wa Kwanza', startsOn: '2027-01-05', endsOn: '2027-06-12' }],
  },
  classes: [{ educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A'] }],
});
if (onboard2.status !== 201) throw new Error(`onboard2: ${onboard2.status} ${JSON.stringify(onboard2.body)}`);
const otherTenantId = onboard2.body.tenantId;
const otherCreate = await api('/students', owner2.token, otherTenantId, {
  firstName: 'Neema', lastName: 'Shirima', gender: 'female',
});
if (otherCreate.status !== 201) throw new Error(`other-tenant student: ${JSON.stringify(otherCreate.body)}`);
const { data: otherRoster } = await admin
  .from('students')
  .select('id, status')
  .eq('tenant_id', otherTenantId);
const otherStudent = otherRoster[0];
const { data: otherSections } = await admin
  .from('class_sections')
  .select('id')
  .eq('tenant_id', otherTenantId);

const foreignStatus = await api(`/students/${otherStudent.id}/status`, owner.token, tenantId, {
  status: 'withdrawn',
}, 'PATCH');
if (foreignStatus.status !== 404 || codeOf(foreignStatus) !== 'STUDENT_NOT_FOUND') {
  throw new Error(`foreign student status: ${foreignStatus.status} ${JSON.stringify(foreignStatus.body)}`);
}
const foreignEnrol = await api(`/students/${otherStudent.id}/enrolment`, owner.token, tenantId, {
  classSectionId: sectionA.id,
}, 'PATCH');
if (foreignEnrol.status !== 404 || codeOf(foreignEnrol) !== 'ENROLMENT_STUDENT_NOT_FOUND') {
  throw new Error(`foreign student enrolment: ${foreignEnrol.status} ${JSON.stringify(foreignEnrol.body)}`);
}
// …and the mirror image: our own pupil may not be filed into another school's
// section (that would be a cross-tenant WRITE, the worse direction).
const foreignSection = await api(`/students/${juma.id}/enrolment`, owner.token, tenantId, {
  classSectionId: otherSections[0].id,
}, 'PATCH');
if (foreignSection.status !== 400 || codeOf(foreignSection) !== 'ENROLMENT_SECTION_NOT_FOUND') {
  throw new Error(`foreign section: ${foreignSection.status} ${JSON.stringify(foreignSection.body)}`);
}
const { data: otherAfter } = await admin
  .from('students').select('status').eq('id', otherStudent.id).single();
if (otherAfter.status !== 'active') throw new Error(`cross-tenant write landed: ${otherAfter.status}`);
const jumaEnrolments = await enrolmentsOf(juma.id);
if (jumaEnrolments.length !== 1 || jumaEnrolments[0].class_section_id !== sectionA.id) {
  throw new Error(`own enrolment disturbed: ${JSON.stringify(jumaEnrolments)}`);
}
console.log('7. cross-tenant ids 404 (STUDENT_NOT_FOUND); foreign section rejected; nothing written');

// ---------------------------------------------------------------------------
// 8. Academic-year rollover with a cloned section grid (LIFE-030-D).
// ---------------------------------------------------------------------------
const nextYear = await api('/academics/years', owner.token, tenantId, {
  name: '2028', startsOn: '2028-01-10', endsOn: '2028-12-08',
  terms: [
    { name: 'Muhula wa Kwanza', startsOn: '2028-01-10', endsOn: '2028-06-16' },
    { name: 'Muhula wa Pili', startsOn: '2028-07-03', endsOn: '2028-12-08' },
  ],
  cloneSectionsFromYearId: yearId,
});
if (nextYear.status !== 201) throw new Error(`create year: ${nextYear.status} ${JSON.stringify(nextYear.body)}`);
if (nextYear.body.terms !== 2 || nextYear.body.sectionsCloned !== 2) {
  throw new Error(`rollover counts: ${JSON.stringify(nextYear.body)}`);
}
const nextYearId = nextYear.body.academicYearId;
const { data: newYearRow } = await admin
  .from('academic_years').select('name, status').eq('id', nextYearId).single();
if (newYearRow.name !== '2028' || newYearRow.status !== 'draft') {
  throw new Error(`new year row: ${JSON.stringify(newYearRow)}`);
}
const { data: newTerms } = await admin
  .from('academic_terms')
  .select('name, sequence')
  .eq('tenant_id', tenantId)
  .eq('academic_year_id', nextYearId)
  .order('sequence');
if (newTerms.length !== 2 || newTerms[0].sequence !== 1 || newTerms[1].sequence !== 2
    || newTerms[1].name !== 'Muhula wa Pili') {
  throw new Error(`terms: ${JSON.stringify(newTerms)}`);
}
const { data: clonedSections } = await admin
  .from('class_sections')
  .select('name, grade_level_id, campus_id')
  .eq('tenant_id', tenantId)
  .eq('academic_year_id', nextYearId)
  .order('name');
if (clonedSections.length !== 2 || clonedSections.map((s) => s.name).join(',') !== 'A,B') {
  throw new Error(`cloned sections: ${JSON.stringify(clonedSections)}`);
}
if (clonedSections.some((s) => s.grade_level_id !== sectionA.grade_level_id)) {
  throw new Error('clone should reuse the tenant-wide grade level, not fork it');
}
const { count: gradeCount } = await admin
  .from('grade_levels').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId);
if (gradeCount !== 1) throw new Error(`clone duplicated grade levels: ${gradeCount}`);
console.log('8. next year created: 2 terms + 2 sections cloned, grade levels reused');

// ---------------------------------------------------------------------------
// 9. Same year name again → YEAR_NAME_TAKEN, and no half-built year left over.
// ---------------------------------------------------------------------------
const dupeYear = await api('/academics/years', owner.token, tenantId, {
  name: '2028', startsOn: '2028-01-10', endsOn: '2028-12-08',
  terms: [{ name: 'Muhula wa Kwanza', startsOn: '2028-01-10', endsOn: '2028-06-16' }],
});
if (dupeYear.status !== 400 || codeOf(dupeYear) !== 'YEAR_NAME_TAKEN') {
  throw new Error(`duplicate year: ${dupeYear.status} ${JSON.stringify(dupeYear.body)}`);
}
const { count: yearsNamed2028 } = await admin
  .from('academic_years').select('*', { count: 'exact', head: true })
  .eq('tenant_id', tenantId).eq('name', '2028');
if (yearsNamed2028 !== 1) throw new Error(`duplicate year rows: ${yearsNamed2028}`);
console.log('9. duplicate year name rejected (YEAR_NAME_TAKEN), no extra row');

// ---------------------------------------------------------------------------
// 10. Activate the new year → the previous one closes. Two active years would
//     make the students controller's section lookup non-deterministic.
// ---------------------------------------------------------------------------
const activate = await api(`/academics/years/${nextYearId}/activate`, owner.token, tenantId, null);
if (activate.status !== 201 || activate.body.academicYearId !== nextYearId
    || activate.body.closedPrevious !== 1) {
  throw new Error(`activate: ${activate.status} ${JSON.stringify(activate.body)}`);
}
const { data: allYears } = await admin
  .from('academic_years').select('id, name, status').eq('tenant_id', tenantId);
const previous = allYears.find((y) => y.id === yearId);
const current = allYears.find((y) => y.id === nextYearId);
if (current.status !== 'active') throw new Error(`new year status: ${current.status}`);
if (previous.status !== 'closed') throw new Error(`old year status: ${previous.status}`);
if (allYears.filter((y) => y.status === 'active').length !== 1) {
  throw new Error(`exactly one year must be active: ${JSON.stringify(allYears)}`);
}
if (await auditCount(tenantId, 'academic_year.activated') !== 1) {
  throw new Error('activation not audited');
}
console.log('10. new year active, previous year closed — exactly one active year');

// ---------------------------------------------------------------------------
// Cleanup: archive both tenants (never hard-delete — audit_logs FK) and drop
// the throwaway custom role.
// ---------------------------------------------------------------------------
await admin.from('membership_roles').delete().eq('role_id', clerkRole.id);
await admin.from('role_permissions').delete().eq('role_id', clerkRole.id);
await admin.from('roles').delete().eq('id', clerkRole.id);
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` })
  .in('id', [tenantId, otherTenantId]);
await admin.from('tenant_memberships').update({ status: 'revoked' })
  .in('tenant_id', [tenantId, otherTenantId]);
console.log('11. both test tenants archived\n\nSMOKE TEST PASSED');
