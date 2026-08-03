/**
 * End-to-end smoke test: staff salaries, payroll runs, exact PAYE band math,
 * ledger posting (accounts 5000/2100), run immutability and payroll RBAC.
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-payroll.mjs
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

async function api(path, token, tenantId, body, method) {
  const res = await fetch(`${apiUrl}/api/v1${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// Expected PAYE from the DEFAULT bands seeded by migration 0025 — computed
// here independently so the smoke asserts the RPC math EXACTLY.
const BANDS = [
  { upTo: 270000, rate: 0 },
  { upTo: 520000, rate: 0.08 },
  { upTo: 760000, rate: 0.2 },
  { upTo: 1000000, rate: 0.25 },
  { upTo: null, rate: 0.3 },
];
function expectedPaye(income) {
  let prev = 0;
  let tax = 0;
  for (const band of BANDS) {
    if (band.upTo === null || income <= band.upTo) {
      tax += band.rate * (income - prev);
      break;
    }
    tax += band.rate * (band.upTo - prev);
    prev = band.upTo;
  }
  return Math.round(tax * 100) / 100;
}

// 1. Onboard + two teachers
const owner = await makeUser(`pay-owner-${stamp}@example.com`, 'Pay Owner');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke Pay ${stamp}`, slug: `smoke-pay-${stamp}`, email: `pay-owner-${stamp}@example.com`, defaultLanguage: 'sw' },
  academicYear: {
    name: '2027', startsOn: '2027-01-05', endsOn: '2027-12-04',
    terms: [{ name: 'Muhula wa Kwanza', startsOn: '2027-01-05', endsOn: '2027-06-12' }],
  },
  classes: [{ educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A'] }],
});
if (onboard.status !== 201) throw new Error(`onboard: ${JSON.stringify(onboard.body)}`);
const tenantId = onboard.body.tenantId;

const inv1 = await api('/invitations', owner.token, tenantId, {
  email: `pay-t1-${stamp}@example.com`, roleKeys: ['teacher'],
});
const teacher1 = await makeUser(`pay-t1-${stamp}@example.com`, 'Amani Mushi');
await api('/invitations/accept', teacher1.token, null, { token: inv1.body.inviteUrl.split('/invite/')[1] });
const inv2 = await api('/invitations', owner.token, tenantId, {
  email: `pay-t2-${stamp}@example.com`, roleKeys: ['teacher'],
});
const teacher2 = await makeUser(`pay-t2-${stamp}@example.com`, 'Beatrice Komba');
await api('/invitations/accept', teacher2.token, null, { token: inv2.body.inviteUrl.split('/invite/')[1] });
console.log('1. school + two teachers ready');

// 2. No salaries yet — running payroll is rejected
const noSalaries = await api('/payroll/runs', owner.token, tenantId, { period: '2027-02' });
if (noSalaries.status !== 400 || noSalaries.body.code !== 'PAYROLL_NO_SALARIES') {
  throw new Error(`no-salaries run: ${JSON.stringify(noSalaries.body)}`);
}
console.log('2. run without salaries rejected (PAYROLL_NO_SALARIES)');

// 3. Salaries: teacher1 set twice (replacement keeps one active row);
//    teacher2 flagged for HESLB. Non-member rejected.
const badMember = await api('/payroll/salaries', owner.token, tenantId, {
  userId: '00000000-0000-4000-8000-000000000000', basic: 100000,
});
if (badMember.status !== 400 || badMember.body.code !== 'SALARY_MEMBER_NOT_FOUND') {
  throw new Error(`bad member: ${JSON.stringify(badMember.body)}`);
}
const sal1a = await api('/payroll/salaries', owner.token, tenantId, {
  userId: teacher1.id, basic: 500000, allowances: 0,
});
if (sal1a.status !== 201) throw new Error(`sal1a: ${JSON.stringify(sal1a.body)}`);
const sal1b = await api('/payroll/salaries', owner.token, tenantId, {
  userId: teacher1.id, basic: 600000, allowances: 50000,
});
if (sal1b.status !== 201) throw new Error(`sal1b: ${JSON.stringify(sal1b.body)}`);
const sal2 = await api('/payroll/salaries', owner.token, tenantId, {
  userId: teacher2.id, basic: 1200000, allowances: 0, hasHeslb: true,
});
if (sal2.status !== 201) throw new Error(`sal2: ${JSON.stringify(sal2.body)}`);

const salaries = await api('/payroll/salaries', owner.token, tenantId);
if (salaries.status !== 200 || salaries.body.data.length !== 2) {
  throw new Error(`salaries list: ${JSON.stringify(salaries.body)}`);
}
const t1Sal = salaries.body.data.find((s) => s.userId === teacher1.id);
if (t1Sal.basic !== 600000 || t1Sal.allowances !== 50000 || t1Sal.hasHeslb !== false) {
  throw new Error(`t1 salary replacement: ${JSON.stringify(t1Sal)}`);
}
console.log('3. salaries set; replacement keeps one active row; non-member rejected');

// 4. Teachers cannot read salaries (payroll.view is bursar/accountant/admin)
const denied = await api('/payroll/salaries', teacher1.token, tenantId);
if (denied.status !== 403) throw new Error(`teacher salaries should be 403, got ${denied.status}`);
console.log('4. teacher denied salary read (403)');

// Statutory settings are seeded but must be explicitly reviewed before a run.
const settings = await api('/payroll/settings', owner.token, tenantId);
if (settings.status !== 200 || !settings.body.rates || settings.body.verifiedAt !== null) {
  throw new Error(`payroll settings: ${JSON.stringify(settings.body)}`);
}
const blockedUnverified = await api('/payroll/runs', owner.token, tenantId, { period: '2027-02' });
if (blockedUnverified.status !== 400
  || blockedUnverified.body.code !== 'PAYROLL_SETTINGS_UNVERIFIED') {
  throw new Error(`unverified run: ${JSON.stringify(blockedUnverified.body)}`);
}
const verified = await api('/payroll/settings', owner.token, tenantId, {
  rates: settings.body.rates,
  verified: true,
}, 'PUT');
if (verified.status !== 200 || verified.body.verified !== true) {
  throw new Error(`verify settings: ${JSON.stringify(verified.body)}`);
}
console.log('5. statutory settings gate blocks unverified payroll; reviewed rates accepted');

// 6. Run payroll and verify the maths EXACTLY against the default rates
const run = await api('/payroll/runs', owner.token, tenantId, { period: '2027-02' });
if (run.status !== 201 || run.body.employees !== 2) throw new Error(`run: ${JSON.stringify(run.body)}`);
const runId = run.body.runId;

// teacher1: mid-band earner — gross 650,000
const t1 = { gross: 650000, nssf: 65000, heslb: 0 };
t1.paye = expectedPaye(t1.gross - t1.nssf);
t1.net = t1.gross - t1.paye - t1.nssf - t1.heslb;
if (t1.paye !== 33000) throw new Error(`script self-check: PAYE(585000) = ${t1.paye}, expected 33000`);
// teacher2: top-band + HESLB — gross 1,200,000
const t2 = { gross: 1200000, nssf: 120000, heslb: 180000 };
t2.paye = expectedPaye(t2.gross - t2.nssf);
t2.net = t2.gross - t2.paye - t2.nssf - t2.heslb;
if (t2.paye !== 152000) throw new Error(`script self-check: PAYE(1080000) = ${t2.paye}, expected 152000`);

const detail = await api(`/payroll/runs/${runId}`, owner.token, tenantId);
if (detail.status !== 200 || detail.body.status !== 'draft' || detail.body.items.length !== 2) {
  throw new Error(`run detail: ${JSON.stringify(detail.body)}`);
}
const i1 = detail.body.items.find((i) => i.userId === teacher1.id);
const i2 = detail.body.items.find((i) => i.userId === teacher2.id);
for (const [item, exp, who] of [[i1, t1, 'teacher1'], [i2, t2, 'teacher2']]) {
  for (const key of ['gross', 'paye', 'nssf', 'heslb', 'net']) {
    if (item[key] !== exp[key]) {
      throw new Error(`${who}.${key}: got ${item[key]}, expected ${exp[key]}`);
    }
  }
}
const totalGross = t1.gross + t2.gross;           // 1,850,000
const totalDeductions = t1.paye + t1.nssf + t2.paye + t2.nssf + t2.heslb; // 550,000
const totalNet = t1.net + t2.net;                 // 1,300,000
if (detail.body.totals.gross !== totalGross || detail.body.totals.net !== totalNet) {
  throw new Error(`run totals: ${JSON.stringify(detail.body.totals)}`);
}
// employer contributions are stored and later posted as a separate journal.
if (detail.body.employer.nssf !== 185000
    || detail.body.employer.wcf !== 9250
    || detail.body.employer.sdl !== 64750) {
  throw new Error(`employer nssf: ${JSON.stringify(detail.body.employer)}`);
}
console.log('6. draft maths exact: PAYE 33,000 / 152,000; net 552,000 / 748,000');

// 7. Duplicate period rejected
const dup = await api('/payroll/runs', owner.token, tenantId, { period: '2027-02' });
if (dup.status !== 400 || dup.body.code !== 'PAYROLL_PERIOD_EXISTS') {
  throw new Error(`dup run: ${JSON.stringify(dup.body)}`);
}
console.log('7. duplicate period rejected (PAYROLL_PERIOD_EXISTS)');

// 8. Post to the ledger: wages plus employer statutory contributions.
const post = await api(`/payroll/runs/${runId}/post`, owner.token, tenantId, {});
if (post.status !== 201 || !post.body.journalEntryId) throw new Error(`post: ${JSON.stringify(post.body)}`);
if (Number(post.body.totalGross) !== totalGross
    || Number(post.body.totalDeductions) !== totalDeductions
    || Number(post.body.totalNet) !== totalNet) {
  throw new Error(`post totals: ${JSON.stringify(post.body)}`);
}
const { data: entry } = await admin
  .from('journal_entries').select('id, source_type').eq('id', post.body.journalEntryId).single();
if (entry.source_type !== 'payroll') throw new Error(`entry source: ${entry.source_type}`);
const { data: lines } = await admin
  .from('journal_lines').select('debit, credit, ledger_accounts(code, type)').eq('entry_id', entry.id);
const debits = lines.reduce((s, l) => s + Number(l.debit), 0);
const credits = lines.reduce((s, l) => s + Number(l.credit), 0);
if (debits !== credits || debits !== totalGross) {
  throw new Error(`journal unbalanced: debits ${debits} credits ${credits}`);
}
const byCode = Object.fromEntries(lines.map((l) => [l.ledger_accounts.code, l]));
if (Number(byCode['5000']?.debit) !== totalGross
    || Number(byCode['2100']?.credit) !== totalDeductions
    || Number(byCode['1000']?.credit) !== totalNet) {
  throw new Error(`journal lines: ${JSON.stringify(lines)}`);
}
const { data: accounts } = await admin
  .from('ledger_accounts').select('code, name, type').eq('tenant_id', tenantId)
  .in('code', ['5000', '2100', '5010', '2110']);
if (accounts.length !== 4) throw new Error(`payroll accounts missing: ${JSON.stringify(accounts)}`);
const { data: employerEntries } = await admin
  .from('journal_entries').select('id').eq('tenant_id', tenantId)
  .eq('source_type', 'payroll').eq('source_id', runId).neq('id', entry.id);
if (employerEntries.length !== 1) throw new Error(`employer journal missing: ${JSON.stringify(employerEntries)}`);
const { data: employerLines } = await admin
  .from('journal_lines').select('debit, credit, ledger_accounts(code)')
  .eq('entry_id', employerEntries[0].id);
const employerByCode = Object.fromEntries(employerLines.map((l) => [l.ledger_accounts.code, l]));
if (Number(employerByCode['5010']?.debit) !== 259000
    || Number(employerByCode['2110']?.credit) !== 259000) {
  throw new Error(`employer journal lines: ${JSON.stringify(employerLines)}`);
}
const { data: runRow } = await admin
  .from('payroll_runs').select('status, journal_entry_id, posted_at').eq('id', runId).single();
if (runRow.status !== 'posted' || runRow.journal_entry_id !== entry.id || !runRow.posted_at) {
  throw new Error(`run row after post: ${JSON.stringify(runRow)}`);
}
console.log('8. wage journal balanced at 1,850,000; employer journal balanced at 259,000');

// 9. Posted run is immutable — second post rejected
const again = await api(`/payroll/runs/${runId}/post`, owner.token, tenantId, {});
if (again.status !== 400 || again.body.code !== 'PAYROLL_ALREADY_POSTED') {
  throw new Error(`double post: ${JSON.stringify(again.body)}`);
}
console.log('9. second post rejected (PAYROLL_ALREADY_POSTED)');

// 10. Audit trail
const { data: audits } = await admin
  .from('audit_logs').select('action').eq('tenant_id', tenantId)
  .in('action', ['payroll.salary_set', 'payroll.run_created', 'payroll.run_posted']);
const counts = audits.reduce((m, a) => ({ ...m, [a.action]: (m[a.action] ?? 0) + 1 }), {});
if (counts['payroll.salary_set'] !== 3 || counts['payroll.run_created'] !== 1 || counts['payroll.run_posted'] !== 1) {
  throw new Error(`audits: ${JSON.stringify(counts)}`);
}
console.log('10. audit trail complete (3 salary sets, 1 run, 1 post)');

// Cleanup
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` }).eq('id', tenantId);
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
console.log('11. test tenant archived\n\nSMOKE TEST PASSED');
