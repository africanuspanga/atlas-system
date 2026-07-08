/**
 * End-to-end smoke test: reporting module (CTO §12).
 * Seeds a school with invoices/payments (incl. a student named "=SUM(A1)" to
 * prove CSV formula-injection escaping), generates fee-collection CSV,
 * outstanding XLSX, trial-balance PDF and student-statement PDF via the
 * worker, verifies totals reconcile to the ledger, RBAC, signed downloads.
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-reports.mjs
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

function runReportsWorker() {
  execFileSync('node', ['apps/workers/dist/process-reports.js', '--once'], {
    cwd: process.cwd(), env: process.env, stdio: 'pipe',
  });
}

async function generate(token, tenantId, reportKey, format, params = {}) {
  const created = await api('/reports', token, tenantId, { reportKey, format, params });
  if (created.status !== 201) throw new Error(`${reportKey}: ${JSON.stringify(created.body)}`);
  runReportsWorker();
  const detail = await api(`/reports/${created.body.jobId}`, token, tenantId, null, 'GET');
  if (detail.body.job.status !== 'completed') {
    throw new Error(`${reportKey} status: ${detail.body.job.status} ${detail.body.job.error ?? ''}`);
  }
  const dl = await api(`/reports/${created.body.jobId}/download`, token, tenantId, null, 'GET');
  if (dl.status !== 200 || !dl.body.url) throw new Error(`${reportKey} download: ${JSON.stringify(dl.body)}`);
  const file = await fetch(dl.body.url);
  const buffer = Buffer.from(await file.arrayBuffer());
  return { job: detail.body.job, buffer };
}

// 1. School + bursar + students + money movements
const owner = await makeUser(`rep-owner-${stamp}@example.com`, 'Report Owner');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke Reports ${stamp}`, slug: `smoke-rep-${stamp}`, email: `rep-owner-${stamp}@example.com`, defaultLanguage: 'sw' },
  academicYear: {
    name: '2027', startsOn: '2027-01-05', endsOn: '2027-12-04',
    terms: [{ name: 'Muhula wa Kwanza', startsOn: '2027-01-05', endsOn: '2027-06-12' }],
  },
  classes: [{ educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A'] }],
});
if (onboard.status !== 201) throw new Error(`onboard: ${JSON.stringify(onboard.body)}`);
const tenantId = onboard.body.tenantId;

// Student with a hostile name to prove CSV escaping
const st1 = await api('/students', owner.token, tenantId, {
  firstName: '=SUM(A1)', lastName: 'Injection', gender: 'male',
});
const st2 = await api('/students', owner.token, tenantId, {
  firstName: 'Rehema', lastName: 'Daudi', gender: 'female',
});
if (st1.status !== 201 || st2.status !== 201) throw new Error('students failed');
const { data: students } = await owner.client.from('students').select('id, first_name');
const hostile = students.find((s) => s.first_name === '=SUM(A1)');
const rehema = students.find((s) => s.first_name === 'Rehema');

const inv1 = await api('/finance/invoices', owner.token, tenantId, {
  studentId: hostile.id, lines: [{ description: 'Ada ya Muhula', amount: 400000 }],
});
const inv2 = await api('/finance/invoices', owner.token, tenantId, {
  studentId: rehema.id, lines: [{ description: 'Ada ya Muhula', amount: 600000 }],
});
await api(`/finance/invoices/${inv1.body.invoiceId}/payments`, owner.token, tenantId, {
  amount: 150000, method: 'mpesa', reference: `MP${stamp}`,
});
await api(`/finance/invoices/${inv2.body.invoiceId}/payments`, owner.token, tenantId, {
  amount: 600000, method: 'cash',
});
console.log('1. school seeded: 2 students, 2 invoices (1,000,000), payments 750,000');

// 2. RBAC: teacher denied catalogue; owner sees full catalogue
const teacherInv = await api('/invitations', owner.token, tenantId, {
  email: `rep-teacher-${stamp}@example.com`, roleKeys: ['teacher'],
});
const teacher = await makeUser(`rep-teacher-${stamp}@example.com`, 'Report Teacher');
await api('/invitations/accept', teacher.token, null, { token: teacherInv.body.inviteUrl.split('/invite/')[1] });
const deniedCat = await api('/reports/catalogue', teacher.token, tenantId, null, 'GET');
if (deniedCat.status !== 403) throw new Error(`teacher catalogue should be 403, got ${deniedCat.status}`);
const cat = await api('/reports/catalogue', owner.token, tenantId, null, 'GET');
if (cat.body.reports.length !== 5) throw new Error(`catalogue: ${JSON.stringify(cat.body)}`);
console.log('2. RBAC: teacher denied; owner catalogue has 5 reports');

// 3. Fee collection CSV — totals + formula escaping + BOM
const today = new Date().toISOString().slice(0, 10);
const fc = await generate(owner.token, tenantId, 'fee_collection', 'csv', { from: today, to: today });
const csv = fc.buffer.toString('utf8');
if (!csv.startsWith('﻿')) throw new Error('CSV missing UTF-8 BOM');
if (!csv.includes('"\'=SUM(A1) Injection"')) throw new Error('formula injection not escaped');
if (!csv.includes('Total collected') || !csv.includes('750,000')) throw new Error(`CSV totals: ${csv.slice(-200)}`);
if (Number(fc.job.totals.total) !== 750000) throw new Error(`fee total: ${fc.job.totals.total}`);
console.log('3. fee-collection CSV: BOM + escaped "=SUM(A1)" + total 750,000');

// 4. Outstanding balances XLSX — reconciles to A/R
const ob = await generate(owner.token, tenantId, 'outstanding_balances', 'xlsx');
if (ob.buffer.subarray(0, 2).toString() !== 'PK') throw new Error('not a valid XLSX (zip)');
if (Number(ob.job.totals.outstanding) !== 250000 || Number(ob.job.totals.ledgerAR) !== 250000) {
  throw new Error(`outstanding: ${JSON.stringify(ob.job.totals)}`);
}
console.log('4. outstanding XLSX: 250,000 == ledger A/R (reconciled)');

// 5. Trial balance PDF — debits == credits
const tb = await generate(owner.token, tenantId, 'trial_balance', 'pdf');
if (tb.buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('not a valid PDF');
if (Number(tb.job.totals.debits) !== Number(tb.job.totals.credits)) {
  throw new Error(`trial balance: ${JSON.stringify(tb.job.totals)}`);
}
console.log(`5. trial-balance PDF: debits == credits == ${Number(tb.job.totals.debits).toLocaleString()}`);

// 6. Student statement PDF — closing balance reconciles
const ss = await generate(owner.token, tenantId, 'student_statement', 'pdf', { studentId: hostile.id });
if (ss.buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('statement not a PDF');
if (Number(ss.job.totals.closingBalance) !== 250000) {
  throw new Error(`statement closing: ${JSON.stringify(ss.job.totals)}`);
}
console.log('6. student-statement PDF: closing balance 250,000 (reconciled)');

// 7. Ledger tamper → report REFUSES to generate (integrity gate).
//    An orphan journal entry unbalances A/R vs receivables. Trigger blocks
//    UPDATE/DELETE on journal_lines, so insert a bogus balanced-entry with
//    A/R on one side only being unbalanced vs invoices.
const { data: acct } = await admin.from('ledger_accounts').select('id')
  .eq('tenant_id', tenantId).eq('code', '1100').single();
const { data: acct2 } = await admin.from('ledger_accounts').select('id')
  .eq('tenant_id', tenantId).eq('code', '4000').single();
const { data: badEntry } = await admin.from('journal_entries').insert({
  tenant_id: tenantId, entry_number: 'JE-TAMPER', description: 'tamper',
  source_type: 'invoice', source_id: inv1.body.invoiceId,
}).select('id').single();
await admin.from('journal_lines').insert([
  { tenant_id: tenantId, entry_id: badEntry.id, account_id: acct.id, debit: 99999, credit: 0 },
  { tenant_id: tenantId, entry_id: badEntry.id, account_id: acct2.id, debit: 0, credit: 99999 },
]);
const tampered = await api('/reports', owner.token, tenantId, {
  reportKey: 'outstanding_balances', format: 'csv', params: {},
});
runReportsWorker();
const tamperedDetail = await api(`/reports/${tampered.body.jobId}`, owner.token, tenantId, null, 'GET');
if (tamperedDetail.body.job.status !== 'failed' || !tamperedDetail.body.job.error.includes('REPORT_RECONCILE_FAILED')) {
  throw new Error(`tamper gate: ${JSON.stringify(tamperedDetail.body.job)}`);
}
console.log('7. tampered ledger → report generation REFUSED (REPORT_RECONCILE_FAILED)');

// 8. Audit trail for request + download
const { data: audits } = await admin.from('audit_logs').select('action').eq('tenant_id', tenantId)
  .in('action', ['report.requested', 'report.downloaded']);
if (audits.filter((a) => a.action === 'report.requested').length < 5) throw new Error('missing request audits');
if (audits.filter((a) => a.action === 'report.downloaded').length < 4) throw new Error('missing download audits');
console.log('8. audit trail complete');

// Cleanup
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` }).eq('id', tenantId);
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
console.log('9. test tenant archived\n\nSMOKE TEST PASSED');
