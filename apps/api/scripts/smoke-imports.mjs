/**
 * End-to-end smoke test: staged import pipeline (CTO §8).
 * Students CSV (Swahili headers, messy phones, dupes, bad rows) → mapping
 * suggestions → dry run → approve → worker commit → idempotent re-run;
 * then opening balances → invoices + journal (debit A/R, credit 3000) →
 * double-import blocked. RBAC: teacher denied.
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-imports.mjs
 * Requires: API running, `pnpm --filter @atlas/workers build` done.
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

async function uploadCsv(token, tenantId, domain, filename, csv) {
  const form = new FormData();
  form.append('domain', domain);
  form.append('file', new Blob([csv], { type: 'text/csv' }), filename);
  const res = await fetch(`${apiUrl}/api/v1/imports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-tenant-id': tenantId },
    body: form,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function runWorkerOnce() {
  execFileSync('node', ['apps/workers/dist/process-imports.js', '--once'], {
    cwd: process.cwd(), env: process.env, stdio: 'pipe',
  });
}

// 1. Onboard a school with Form 1 A/B and a teacher (for RBAC)
const owner = await makeUser(`imp-owner-${stamp}@example.com`, 'Import Owner');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke Imports ${stamp}`, slug: `smoke-imp-${stamp}`, email: `imp-owner-${stamp}@example.com`, defaultLanguage: 'sw' },
  academicYear: {
    name: '2027', startsOn: '2027-01-05', endsOn: '2027-12-04',
    terms: [{ name: 'Muhula wa Kwanza', startsOn: '2027-01-05', endsOn: '2027-06-12' }],
  },
  classes: [{ educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A', 'B'] }],
});
if (onboard.status !== 201) throw new Error(`onboard: ${JSON.stringify(onboard.body)}`);
const tenantId = onboard.body.tenantId;
const teacherInv = await api('/invitations', owner.token, tenantId, {
  email: `imp-teacher-${stamp}@example.com`, roleKeys: ['teacher'],
});
const teacher = await makeUser(`imp-teacher-${stamp}@example.com`, 'Import Teacher');
await api('/invitations/accept', teacher.token, null, { token: teacherInv.body.inviteUrl.split('/invite/')[1] });
console.log('1. school + teacher ready');

// 2. Teacher cannot touch imports (no imports.manage)
const denied = await uploadCsv(teacher.token, tenantId, 'students', 'x.csv', 'Jina Kamili\nX Y');
if (denied.status !== 403) throw new Error(`teacher upload should be 403, got ${denied.status}`);
console.log('2. teacher denied (imports.manage)');

// 3. Upload students CSV — Swahili headers, messy data
const studentsCsv = [
  'Jina Kamili,Jinsia,Tarehe ya Kuzaliwa,Darasa,Mkondo,Jina la Mzazi,Simu ya Mzazi',
  'Amina Hassan Juma,KE,12/03/2013,Form 1,A,Fatma Juma,0755 123 456',
  'Baraka Mushi,me,2013-05-20,Form 1,A,Joseph Mushi,+255766123456',
  'Neema Peter Kessy,female,15/06/2012,Form 1,B,Grace Kessy,0788111222',
  'Upendo Michael Shirima,ke,01/09/2013,Form 1,B,Grace Kessy,0788111222',
  'Juma Ally,X,,Form 1,A,,',
  'Amina Hassan Juma,ke,12/03/2013,Form 1,A,Fatma Juma,0755123456',
  'Zawadi Omari,ke,,Form 9,Z,,',
].join('\n');
const up = await uploadCsv(owner.token, tenantId, 'students', `wanafunzi-${stamp}.csv`, studentsCsv);
if (up.status !== 201) throw new Error(`upload: ${JSON.stringify(up.body)}`);
const jobId = up.body.jobId;
if (up.body.rowCount !== 7) throw new Error(`rowCount: ${up.body.rowCount}`);
const sm = up.body.suggestedMapping;
if (sm['Jina Kamili']?.field !== 'fullName' || sm['Jina Kamili']?.confidence !== 'high')
  throw new Error(`suggestion fullName: ${JSON.stringify(sm['Jina Kamili'])}`);
if (sm['Simu ya Mzazi']?.field !== 'guardianPhone') throw new Error('suggestion guardianPhone');
if (sm['Jinsia']?.field !== 'gender') throw new Error('suggestion gender');
console.log('3. upload parsed; Swahili headers auto-mapped (high confidence)');

// 4. Validate (dry run): 4 valid, 3 invalid (bad gender, in-file dup, unknown class)
const mapping = Object.fromEntries(
  up.body.headers.map((h) => [h, sm[h]?.field ?? null]),
);
const val = await api(`/imports/${jobId}/mapping`, owner.token, tenantId, { mapping }, 'PUT');
if (val.status !== 200) throw new Error(`mapping: ${JSON.stringify(val.body)}`);
if (val.body.valid !== 4 || val.body.invalid !== 3 || val.body.duplicates !== 1) {
  throw new Error(`dry run: ${JSON.stringify(val.body)}`);
}
const codes = val.body.issues.flatMap((i) => i.errors.map((e) => e.code));
for (const expected of ['GENDER_INVALID', 'DUP_IN_FILE', 'SECTION_UNMATCHED']) {
  if (!codes.includes(expected)) throw new Error(`missing issue ${expected} in ${codes}`);
}
console.log('4. dry run: 4 valid / 3 invalid with correct issue codes');

// 5. Approve → worker commits → verify records + guardian dedupe
const approve = await api(`/imports/${jobId}/approve`, owner.token, tenantId);
if (approve.status !== 201 || approve.body.queued !== true) throw new Error(`approve: ${JSON.stringify(approve.body)}`);
runWorkerOnce();
const { data: job1 } = await admin.from('import_jobs').select('*').eq('id', jobId).single();
if (job1.status !== 'committed' || job1.committed_rows !== 4 || job1.failed_rows !== 0) {
  throw new Error(`job after commit: ${job1.status} committed=${job1.committed_rows} failed=${job1.failed_rows}`);
}
const { data: students } = await admin.from('students')
  .select('id, student_number, first_name, last_name, date_of_birth').eq('tenant_id', tenantId);
if (students.length !== 4) throw new Error(`students: ${students.length}`);
const amina = students.find((s) => s.first_name === 'Amina');
if (amina.date_of_birth !== '2013-03-12') throw new Error(`dob parse: ${amina.date_of_birth}`);
const { data: guardians } = await admin.from('guardians').select('id, phone').eq('tenant_id', tenantId);
if (guardians.length !== 3) throw new Error(`guardian dedupe: ${guardians.length} (want 3)`);
if (!guardians.some((g) => g.phone === '0766123456')) throw new Error('+255 phone not normalised');
const { data: enrolments } = await admin.from('class_enrolments').select('id').eq('tenant_id', tenantId);
if (enrolments.length !== 4) throw new Error(`enrolments: ${enrolments.length}`);
console.log('5. committed: 4 students, 3 guardians (deduped by phone), 4 enrolments, DOB + phone normalised');

// 6. Idempotency: re-running the worker must not duplicate anything
runWorkerOnce();
const { data: students2 } = await admin.from('students').select('id').eq('tenant_id', tenantId);
const { data: job1b } = await admin.from('import_jobs').select('committed_rows').eq('id', jobId).single();
if (students2.length !== 4 || job1b.committed_rows !== 4) {
  throw new Error(`idempotency: students=${students2.length} committed=${job1b.committed_rows}`);
}
console.log('6. worker re-run is a no-op (idempotent)');

// 7. Opening balances: invoices + journal (debit 1100 A/R, credit 3000 equity)
const stuNum = (name) => students.find((s) => s.first_name === name).student_number;
const obCsv = [
  'Namba ya Mwanafunzi,Salio,Maelezo',
  `${stuNum('Amina')},"1,250,000",Salio 2025`,
  `${stuNum('Baraka')},300000,`,
  'STU-99999,5000,',
  `${stuNum('Amina')},100,`,
].join('\n');
const up2 = await uploadCsv(owner.token, tenantId, 'opening_balances', `salio-${stamp}.csv`, obCsv);
if (up2.status !== 201) throw new Error(`ob upload: ${JSON.stringify(up2.body)}`);
const mapping2 = Object.fromEntries(up2.body.headers.map((h) => [h, up2.body.suggestedMapping[h]?.field ?? null]));
const val2 = await api(`/imports/${up2.body.jobId}/mapping`, owner.token, tenantId, { mapping: mapping2 }, 'PUT');
if (val2.body.valid !== 2 || val2.body.invalid !== 2) throw new Error(`ob dry run: ${JSON.stringify(val2.body)}`);
await api(`/imports/${up2.body.jobId}/approve`, owner.token, tenantId);
runWorkerOnce();
const { data: invoices } = await admin.from('invoices').select('total, student_id').eq('tenant_id', tenantId);
if (invoices.length !== 2) throw new Error(`ob invoices: ${invoices.length}`);
const totals = invoices.map((i) => Number(i.total)).sort((a, b) => a - b);
if (totals[0] !== 300000 || totals[1] !== 1250000) throw new Error(`ob totals: ${totals}`);
const { data: lines } = await admin.from('journal_lines').select('debit, credit, ledger_accounts(code)').eq('tenant_id', tenantId);
const sum = (code, kind) => lines.filter((l) => l.ledger_accounts.code === code).reduce((s, l) => s + Number(l[kind]), 0);
if (sum('1100', 'debit') !== 1550000 || sum('3000', 'credit') !== 1550000) {
  throw new Error(`ledger: AR ${sum('1100', 'debit')} OB ${sum('3000', 'credit')}`);
}
const debits = lines.reduce((s, l) => s + Number(l.debit), 0);
const credits = lines.reduce((s, l) => s + Number(l.credit), 0);
if (debits !== credits) throw new Error(`unbalanced: ${debits} vs ${credits}`);
console.log('7. opening balances → 2 invoices; ledger balanced (A/R 1,550,000 = Opening Balances equity)');

// 8. Double-import blocked: same file again → both rows ALREADY_IMPORTED
const up3 = await uploadCsv(owner.token, tenantId, 'opening_balances', `salio2-${stamp}.csv`, obCsv);
const val3 = await api(`/imports/${up3.body.jobId}/mapping`, owner.token, tenantId, { mapping: mapping2 }, 'PUT');
if (val3.body.valid !== 0) throw new Error(`re-import should have 0 valid: ${JSON.stringify(val3.body)}`);
const approve3 = await api(`/imports/${up3.body.jobId}/approve`, owner.token, tenantId);
if (approve3.status !== 400 || approve3.body.code !== 'IMPORT_NOTHING_TO_COMMIT') {
  throw new Error(`re-approve: ${JSON.stringify(approve3.body)}`);
}
console.log('8. opening-balance double-import blocked (ALREADY_IMPORTED)');

// 9. Error report + signed download links (private bucket)
const { data: job2 } = await admin.from('import_jobs').select('error_report_path').eq('id', up2.body.jobId).single();
if (!job2.error_report_path) throw new Error('error report missing');
const dl = await api(`/imports/${jobId}/download?target=original`, owner.token, tenantId, null, 'GET');
if (dl.status !== 200 || !dl.body.url?.includes('token=')) throw new Error(`signed url: ${JSON.stringify(dl.body)}`);
const dlErr = await api(`/imports/${up2.body.jobId}/download?target=errors`, owner.token, tenantId, null, 'GET');
if (dlErr.status !== 200 || !dlErr.body.url) throw new Error('errors.csv signed url');
console.log('9. error report CSV generated; downloads are signed URLs only');

// 10. Audit trail
const { data: audits } = await admin.from('audit_logs').select('action').eq('tenant_id', tenantId)
  .in('action', ['import.approved', 'import.committed']);
if (audits.length < 4) throw new Error(`audits: ${JSON.stringify(audits)}`);
console.log('10. audit trail complete');

// Cleanup
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` }).eq('id', tenantId);
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
console.log('11. test tenant archived\n\nSMOKE TEST PASSED');
