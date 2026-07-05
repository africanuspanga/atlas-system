/**
 * Cross-tenant isolation attack suite. Creates School A and School B, then
 * proves that A's staff and parents cannot read, write, reference or spoof
 * their way into B's data — through RLS, through the API guards, and through
 * every RPC that accepts entity ids. Also proves financial records are
 * immutable at the database level.
 *
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-isolation.mjs
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

async function buildSchool(label) {
  const owner = await makeUser(`iso-${label}-${stamp}@example.com`, `Owner ${label}`);
  const onboard = await api('/onboarding', owner.token, null, {
    school: { name: `Iso ${label} ${stamp}`, slug: `iso-${label}-${stamp}`, email: `iso-${label}-${stamp}@example.com`, defaultLanguage: 'sw' },
    academicYear: {
      name: '2027', startsOn: '2027-01-05', endsOn: '2027-12-04',
      terms: [{ name: 'Muhula wa Kwanza', startsOn: '2027-01-05', endsOn: '2027-06-12' }],
    },
    classes: [{ educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A'] }],
  });
  if (onboard.status !== 201) throw new Error(`onboard ${label}: ${JSON.stringify(onboard.body)}`);
  const tenantId = onboard.body.tenantId;
  await api('/students', owner.token, tenantId, {
    firstName: `Student${label}`, lastName: 'Iso', gender: 'female',
    guardian: { fullName: `Guardian ${label}`, phone: `+2557${stamp.slice(-5)}${label === 'a' ? '1' : '2'}0`, email: `iso-parent-${label}-${stamp}@example.com`, relationship: 'mother' },
  });
  const { data: students } = await owner.client.from('students').select('id').limit(1);
  const { data: sections } = await owner.client.from('class_sections').select('id').limit(1);
  const { data: terms } = await owner.client.from('academic_terms').select('id').limit(1);
  const { data: guardians } = await owner.client.from('guardians').select('id').limit(1);
  const fee = await api('/finance/fee-items', owner.token, tenantId, { name: 'Ada', amount: 100000 });
  const invoice = await api('/finance/invoices', owner.token, tenantId, {
    studentId: students[0].id, lines: [{ feeItemId: fee.body.feeItemId }],
  });
  const payment = await api(`/finance/invoices/${invoice.body.invoiceId}/payments`, owner.token, tenantId, {
    amount: 50000, method: 'mpesa',
  });
  return {
    owner, tenantId,
    studentId: students[0].id, sectionId: sections[0].id, termId: terms[0].id,
    guardianId: guardians[0].id, feeItemId: fee.body.feeItemId,
    invoiceId: invoice.body.invoiceId, paymentId: payment.body.paymentId,
  };
}

const A = await buildSchool('a');
const B = await buildSchool('b');
console.log('1. School A and School B built (student, guardian, invoice, payment each)');

// ---------------------------------------------------------------------------
// 2. RLS reads: A's owner sees nothing of B
// ---------------------------------------------------------------------------
const tables = ['tenants', 'students', 'guardians', 'class_sections', 'invoices',
  'payments', 'journal_entries', 'attendance_sessions', 'announcements', 'audit_logs',
  'notification_outbox', 'assessment_scores', 'subjects', 'fee_items'];
for (const table of tables) {
  const { data } = await A.owner.client.from(table).select('tenant_id').eq('tenant_id', B.tenantId);
  if ((data ?? []).length !== 0) throw new Error(`RLS LEAK: A can read B's ${table}`);
}
console.log(`2. RLS reads: A sees zero rows of B across ${tables.length} tables`);

// ---------------------------------------------------------------------------
// 3. RLS writes: A cannot update or delete B's records through the client
// ---------------------------------------------------------------------------
await A.owner.client.from('students').update({ first_name: 'HACKED' }).eq('id', B.studentId);
await A.owner.client.from('invoices').update({ status: 'paid' }).eq('id', B.invoiceId);
await A.owner.client.from('students').delete().eq('id', B.studentId);
const { data: bStudent } = await admin.from('students').select('first_name').eq('id', B.studentId).single();
const { data: bInvoice } = await admin.from('invoices').select('status').eq('id', B.invoiceId).single();
if (bStudent.first_name === 'HACKED' || bInvoice.status === 'paid') {
  throw new Error('RLS LEAK: A mutated B data');
}
console.log("3. RLS writes: A's update/delete attempts on B changed nothing");

// ---------------------------------------------------------------------------
// 4. API header spoofing: A's token + B's tenant id → 403 everywhere
// ---------------------------------------------------------------------------
const spoofCalls = [
  ['/students', { firstName: 'X', lastName: 'Y', gender: 'male' }, 'POST'],
  ['/staff', null, 'GET'],
  ['/attendance', { classSectionId: B.sectionId, date: '2027-02-01', records: [{ studentId: B.studentId, status: 'present' }] }, 'POST'],
  ['/finance/invoices', { studentId: B.studentId, lines: [{ description: 'X', amount: 1000 }] }, 'POST'],
  ['/communication/announcements', { audienceType: 'all_guardians', body: 'spoofed' }, 'POST'],
];
for (const [path, body, method] of spoofCalls) {
  const res = await api(path, A.owner.token, B.tenantId, body, method);
  if (res.status !== 403) throw new Error(`SPOOF: ${method} ${path} with B header returned ${res.status}`);
}
console.log(`4. header spoofing: ${spoofCalls.length} endpoints reject A's token with B's tenant id (403)`);

// ---------------------------------------------------------------------------
// 5. Cross-tenant entity references: A (legit member of A) passing B's ids
// ---------------------------------------------------------------------------
const refAttacks = [
  ['student create with B section', '/students',
    { firstName: 'X', lastName: 'Y', gender: 'male', classSectionId: B.sectionId }, 'IMPORT_SECTION_NOT_FOUND'],
  ['attendance for B section', '/attendance',
    { classSectionId: B.sectionId, date: '2027-02-01', records: [{ studentId: A.studentId, status: 'present' }] }, 'ATTENDANCE_SECTION_NOT_FOUND'],
  ['assessment for B section', '/assessments',
    { name: 'X', classSectionId: B.sectionId, academicTermId: A.termId }, 'ASSESSMENT_BAD_SECTION_OR_TERM'],
  ['invoice for B student', '/finance/invoices',
    { studentId: B.studentId, lines: [{ description: 'X', amount: 1000 }] }, 'INVOICE_STUDENT_NOT_FOUND'],
  ['invoice with B fee item', '/finance/invoices',
    { studentId: A.studentId, lines: [{ feeItemId: B.feeItemId }] }, 'INVOICE_FEE_ITEM_NOT_FOUND'],
  ['announcement to B section', '/communication/announcements',
    { audienceType: 'class_section', classSectionId: B.sectionId, body: 'attack body' }, 'ANNOUNCEMENT_SECTION_NOT_FOUND'],
];
for (const [name, path, body, expectedCode] of refAttacks) {
  const res = await api(path, A.owner.token, A.tenantId, body);
  if (res.status !== 400 || res.body.code !== expectedCode) {
    throw new Error(`REF ATTACK "${name}": expected 400 ${expectedCode}, got ${res.status} ${JSON.stringify(res.body)}`);
  }
}
const payB = await api(`/finance/invoices/${B.invoiceId}/payments`, A.owner.token, A.tenantId, { amount: 1000, method: 'cash' });
if (payB.status !== 400 || payB.body.code !== 'PAYMENT_INVOICE_NOT_FOUND') throw new Error(`pay B invoice: ${payB.status}`);
const revB = await api(`/finance/payments/${B.paymentId}/reverse`, A.owner.token, A.tenantId, { reason: 'attack' });
if (revB.status !== 400 || revB.body.code !== 'REVERSAL_PAYMENT_NOT_FOUND') throw new Error(`reverse B payment: ${revB.status}`);
const inviteB = await api(`/guardians/${B.guardianId}/invite`, A.owner.token, A.tenantId);
if (inviteB.status !== 404) throw new Error(`invite B guardian: ${inviteB.status}`);
const reportB = await api(`/assessments/report-card?studentId=${B.studentId}&termId=${A.termId}`, A.owner.token, A.tenantId, null, 'GET');
if (reportB.status !== 400 || reportB.body.code !== 'REPORT_STUDENT_NOT_FOUND') throw new Error(`report B student: ${reportB.status}`);
console.log('5. entity-reference attacks: 10 cross-tenant ids rejected with clean error codes');

// ---------------------------------------------------------------------------
// 6. Parent isolation: A's parent cannot see B's child
// ---------------------------------------------------------------------------
const parentInvite = await api(`/guardians/${A.guardianId}/invite`, A.owner.token, A.tenantId);
const parentA = await makeUser(`iso-parent-a-${stamp}@example.com`, 'Parent A');
await api('/invitations/accept', parentA.token, null, { token: parentInvite.body.inviteUrl.split('/invite/')[1] });
const kids = await api('/portal/children', parentA.token, null, null, 'GET');
if (kids.body.children.length !== 1 || kids.body.children[0].studentId !== A.studentId) {
  throw new Error(`parent children: ${JSON.stringify(kids.body)}`);
}
const crossReport = await api(`/portal/children/${B.studentId}/report-card?termId=${B.termId}`, parentA.token, null, null, 'GET');
if (crossReport.status !== 403) throw new Error(`parent cross report: ${crossReport.status}`);
const { data: parentRls } = await parentA.client.from('students').select('id');
if (parentRls.length !== 0) throw new Error('parent RLS leak');
console.log("6. parent isolation: A's parent sees only their child; B's child 403; zero RLS rows");

// ---------------------------------------------------------------------------
// 7. Financial immutability at the database level (service role included)
// ---------------------------------------------------------------------------
const { error: updErr } = await admin.from('payments').update({ amount: 999999 }).eq('id', A.paymentId);
const { error: delErr } = await admin.from('payments').delete().eq('id', A.paymentId);
const { data: jl } = await admin.from('journal_lines').select('id').eq('tenant_id', A.tenantId).limit(1);
const { error: jlErr } = await admin.from('journal_lines').update({ debit: 1 }).eq('id', jl[0].id);
if (!updErr || !delErr || !jlErr) {
  throw new Error(`IMMUTABILITY FAILURE: update=${updErr?.message} delete=${delErr?.message} journal=${jlErr?.message}`);
}
const { data: intact } = await admin.from('payments').select('amount').eq('id', A.paymentId).single();
if (Number(intact.amount) !== 50000) throw new Error('payment mutated');
console.log('7. financial immutability: UPDATE/DELETE on payments and journal lines blocked even for service role');

// Cleanup
for (const school of [A, B]) {
  await admin.from('tenants').update({ status: 'archived', name: `[test] iso ${stamp}` }).eq('id', school.tenantId);
  await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', school.tenantId);
}
console.log('8. test tenants archived\n\nISOLATION SUITE PASSED');
