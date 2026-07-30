/**
 * End-to-end smoke test: library catalogue, loans (no-copies + duplicate-loan
 * guard rails), returns, overdue listing, RBAC.
 * Requires migration 00000000000021_library.sql to be applied.
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-library.mjs
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
const owner = await makeUser(`lib-owner-${stamp}@example.com`, 'Lib Owner');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke Lib ${stamp}`, slug: `smoke-lib-${stamp}`, email: `lib-owner-${stamp}@example.com`, defaultLanguage: 'sw' },
  academicYear: {
    name: '2027', startsOn: '2027-01-05', endsOn: '2027-12-04',
    terms: [{ name: 'Muhula wa Kwanza', startsOn: '2027-01-05', endsOn: '2027-06-12' }],
  },
  classes: [{ educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A'] }],
});
if (onboard.status !== 201) throw new Error(`onboard: ${onboard.status} ${JSON.stringify(onboard.body)}`);
const tenantId = onboard.body.tenantId;
const { data: sections } = await owner.client.from('class_sections').select('id').limit(1);
const sectionId = sections[0].id;
console.log('1. school onboarded');

// 2. Three students (enrolled so the overdue listing can show a class)
for (const row of [
  { firstName: 'Juma', lastName: 'Hamisi', gender: 'male', classSectionId: sectionId },
  { firstName: 'Ali', lastName: 'Mrisho', gender: 'male', classSectionId: sectionId },
  { firstName: 'Amina', lastName: 'Salum', gender: 'female', classSectionId: sectionId },
]) {
  const created = await api('/students', owner.token, tenantId, row);
  if (created.status !== 201) throw new Error(`student ${row.firstName}: ${created.status} ${JSON.stringify(created.body)}`);
}
const { data: students } = await owner.client
  .from('students').select('id, first_name, student_number');
const byName = (name) => students.find((s) => s.first_name === name);
const juma = byName('Juma'); const ali = byName('Ali'); const amina = byName('Amina');
console.log('2. students created + enrolled');

// 3. Add a book (2 copies); duplicate code rejected with 409
const book = await api('/library/books', owner.token, tenantId, {
  code: 'KIS-F1', title: 'Kiswahili Kidato cha Kwanza', author: 'TIE', copiesTotal: 2,
});
if (book.status !== 201 || !book.body.bookId) throw new Error(`book: ${book.status} ${JSON.stringify(book.body)}`);
const dup = await api('/library/books', owner.token, tenantId, {
  code: 'kis-f1', title: 'Nakala', copiesTotal: 1,
});
if (dup.status !== 409 || dup.body.code !== 'LIBRARY_BOOK_DUPLICATE') {
  throw new Error(`dup book: ${dup.status} ${JSON.stringify(dup.body)}`);
}
console.log('3. book added (duplicate 409)');

// 4. Loan copy 1 to Juma with a PAST due date (overdue on purpose)
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const loan1 = await api('/library/loans', owner.token, tenantId, {
  bookId: book.body.bookId, studentId: juma.id, dueOn: yesterday,
});
if (loan1.status !== 201 || !loan1.body.loanId) {
  throw new Error(`loan1: ${loan1.status} ${JSON.stringify(loan1.body)}`);
}
const { data: active1 } = await admin
  .from('library_loans').select('id').eq('tenant_id', tenantId)
  .eq('student_id', juma.id).is('returned_on', null);
if (active1.length !== 1) throw new Error(`active loans after first: ${active1.length}`);
console.log('4. book loaned');

// 5. Same book + same student again → LIBRARY_ALREADY_LOANED
const dupLoan = await api('/library/loans', owner.token, tenantId, {
  bookId: book.body.bookId, studentId: juma.id, dueOn: '2027-06-01',
});
if (dupLoan.status !== 400 || dupLoan.body.code !== 'LIBRARY_ALREADY_LOANED') {
  throw new Error(`dup loan: ${dupLoan.status} ${JSON.stringify(dupLoan.body)}`);
}
console.log('5. duplicate loan rejected (LIBRARY_ALREADY_LOANED)');

// 6. Copy 2 to Ali → OK; Amina → LIBRARY_NO_COPIES
const loan2 = await api('/library/loans', owner.token, tenantId, {
  bookId: book.body.bookId, studentId: ali.id, dueOn: '2027-06-01',
});
if (loan2.status !== 201) throw new Error(`loan2: ${loan2.status} ${JSON.stringify(loan2.body)}`);
const noCopies = await api('/library/loans', owner.token, tenantId, {
  bookId: book.body.bookId, studentId: amina.id, dueOn: '2027-06-01',
});
if (noCopies.status !== 400 || noCopies.body.code !== 'LIBRARY_NO_COPIES') {
  throw new Error(`no copies: ${noCopies.status} ${JSON.stringify(noCopies.body)}`);
}
console.log('6. copies exhausted (LIBRARY_NO_COPIES)');

// 7. Catalogue math: 2 copies, 2 active loans, 0 available
const list = await api('/library', owner.token, tenantId, null, 'GET');
const row = list.body.data.find((b) => b.id === book.body.bookId);
if (list.status !== 200 || row.copiesTotal !== 2 || row.activeLoans !== 2 || row.available !== 0) {
  throw new Error(`catalogue: ${JSON.stringify(list.body)}`);
}
const bookLoans = await api(`/library/books/${book.body.bookId}/loans`, owner.token, tenantId, null, 'GET');
if (bookLoans.status !== 200 || bookLoans.body.data.length !== 2) {
  throw new Error(`book loans: ${bookLoans.status} ${JSON.stringify(bookLoans.body)}`);
}
console.log('7. availability math correct');

// 8. Overdue listing: exactly Juma, with student + class + days late
const overdue = await api('/library/overdue', owner.token, tenantId, null, 'GET');
if (overdue.status !== 200 || overdue.body.data.length !== 1) {
  throw new Error(`overdue: ${overdue.status} ${JSON.stringify(overdue.body)}`);
}
const od = overdue.body.data[0];
if (od.studentNumber !== juma.student_number || od.bookCode !== 'KIS-F1'
  || od.daysLate < 1 || !od.className) {
  throw new Error(`overdue row: ${JSON.stringify(od)}`);
}
console.log('8. overdue listing correct (student + class + days late)');

// 9. Return; returning twice fails cleanly; copy becomes available again
const ret = await api(`/library/loans/${loan1.body.loanId}/return`, owner.token, tenantId, {});
if (ret.status !== 201 || ret.body.returned !== true) {
  throw new Error(`return: ${ret.status} ${JSON.stringify(ret.body)}`);
}
const retAgain = await api(`/library/loans/${loan1.body.loanId}/return`, owner.token, tenantId, {});
if (retAgain.status !== 400 || retAgain.body.code !== 'LIBRARY_LOAN_NOT_FOUND') {
  throw new Error(`double return: ${retAgain.status} ${JSON.stringify(retAgain.body)}`);
}
const after = await api('/library', owner.token, tenantId, null, 'GET');
if (after.body.data.find((b) => b.id === book.body.bookId).available !== 1) {
  throw new Error(`available after return: ${JSON.stringify(after.body)}`);
}
const overdueAfter = await api('/library/overdue', owner.token, tenantId, null, 'GET');
if (overdueAfter.body.data.length !== 0) {
  throw new Error(`overdue after return: ${JSON.stringify(overdueAfter.body)}`);
}
console.log('9. book returned (double return rejected, availability restored)');

// 10. RBAC: teacher can view, cannot manage; audit trail exists
const invite = await api('/invitations', owner.token, tenantId, {
  email: `lib-teacher-${stamp}@example.com`, roleKeys: ['teacher'],
});
const inviteToken = invite.body.inviteUrl.split('/invite/')[1];
const teacher = await makeUser(`lib-teacher-${stamp}@example.com`, 'Lib Teacher');
await api('/invitations/accept', teacher.token, null, { token: inviteToken });
const teacherView = await api('/library', teacher.token, tenantId, null, 'GET');
if (teacherView.status !== 200) throw new Error(`teacher view: ${teacherView.status}`);
const teacherManage = await api('/library/books', teacher.token, tenantId, {
  code: 'X-1', title: 'Hairuhusiwi', copiesTotal: 1,
});
if (teacherManage.status !== 403) throw new Error(`teacher manage should be 403, got ${teacherManage.status}`);
const { data: audits } = await admin
  .from('audit_logs').select('action').eq('tenant_id', tenantId)
  .in('action', ['library.loaned', 'library.returned']);
if (audits.length < 3) throw new Error(`audit: ${JSON.stringify(audits)}`);
console.log('10. RBAC enforced; loans audited');

// Cleanup: archive test tenant
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` }).eq('id', tenantId);
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
console.log('11. test tenant archived\n\nSMOKE TEST PASSED');
