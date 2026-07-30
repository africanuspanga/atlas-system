/**
 * End-to-end smoke test: invoice instalment plans (validation, replace,
 * paid-waterfall states), the ledger-reconciled debtors report (wadaiwa),
 * reminder dedupe and finance RBAC. Requires migration 0017.
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-instalments.mjs
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

async function api(path, token, tenantId, body, method = body ? 'POST' : 'GET') {
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

const today = new Date().toISOString().slice(0, 10);
/** ISO date offset by N days from today — keeps overdue/upcoming states stable whenever the suite runs. */
const d = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

// 1. Onboard; one student with class + primary guardian (phone)
const owner = await makeUser(`ins-owner-${stamp}@example.com`, 'Ins Owner');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke Ins ${stamp}`, slug: `smoke-ins-${stamp}`, email: `ins-owner-${stamp}@example.com`, defaultLanguage: 'sw' },
  academicYear: {
    name: '2027', startsOn: '2027-01-05', endsOn: '2027-12-04',
    terms: [{ name: 'Muhula wa Kwanza', startsOn: '2027-01-05', endsOn: '2027-06-12' }],
  },
  classes: [{ educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A'] }],
});
if (onboard.status !== 201) throw new Error(`onboard: ${JSON.stringify(onboard.body)}`);
const tenantId = onboard.body.tenantId;
const { data: sections } = await owner.client.from('class_sections').select('id').limit(1);
const st = await api('/students', owner.token, tenantId, {
  firstName: 'Neema', lastName: 'Joseph', gender: 'female', classSectionId: sections[0].id,
  guardian: { fullName: 'Mary Joseph', phone: `+2557${stamp.slice(-6)}31`, email: `ins-parent-${stamp}@example.com`, relationship: 'mother' },
});
if (st.status !== 201) throw new Error(`student: ${JSON.stringify(st.body)}`);
const { data: students } = await owner.client.from('students').select('id').limit(1);
const studentId = students[0].id;
console.log('1. school + student (Form 1 A, guardian with phone) ready');

// 2. Invoice of 600,000 TZS with a PAST due date
const invoice = await api('/finance/invoices', owner.token, tenantId, {
  studentId, dueOn: d(-160),
  lines: [{ description: 'Ada ya Mwaka', amount: 600000 }],
});
if (invoice.status !== 201 || Number(invoice.body.total) !== 600000) {
  throw new Error(`invoice: ${JSON.stringify(invoice.body)}`);
}
const invoiceId = invoice.body.invoiceId;
console.log(`2. invoice ${invoice.body.invoiceNumber} (600,000 TZS, due ${d(-160)})`);

// 3. Debtors BEFORE any schedule: no plan + past invoice due date → whole
//    balance is overdue; report reconciles to the A/R ledger.
let debtors = await api(`/finance/debtors?asOf=${today}`, owner.token, tenantId);
if (debtors.status !== 200) throw new Error(`debtors: ${JSON.stringify(debtors.body)}`);
if (debtors.body.classes.length !== 1 || debtors.body.classes[0].className !== 'Form 1 A') {
  throw new Error(`debtors classes: ${JSON.stringify(debtors.body.classes)}`);
}
let row = debtors.body.classes[0].rows[0];
if (Number(row.balance) !== 600000 || Number(row.overdue) !== 600000 || !row.guardianPhone) {
  throw new Error(`debtors row: ${JSON.stringify(row)}`);
}
if (Number(debtors.body.totals.outstanding) !== 600000
  || Number(debtors.body.totals.ledgerAR) !== 600000) {
  throw new Error(`debtors totals: ${JSON.stringify(debtors.body.totals)}`);
}
console.log('3. unscheduled invoice past its due date → fully overdue; ties to A/R 600,000');

// 4. Schedule validation: sum mismatch, non-ascending dates, too many rows
const badSum = await api(`/finance/invoices/${invoiceId}/instalments`, owner.token, tenantId, {
  rows: [{ amount: 300000, dueOn: d(-120) }, { amount: 200000, dueOn: d(-10) }],
});
if (badSum.status !== 400 || badSum.body.code !== 'INSTALMENTS_SUM_MISMATCH') {
  throw new Error(`bad sum: ${JSON.stringify(badSum.body)}`);
}
const badDates = await api(`/finance/invoices/${invoiceId}/instalments`, owner.token, tenantId, {
  rows: [{ amount: 300000, dueOn: d(-10) }, { amount: 300000, dueOn: d(-10) }],
});
if (badDates.status !== 400 || badDates.body.code !== 'INSTALMENTS_DATES_INVALID') {
  throw new Error(`bad dates: ${JSON.stringify(badDates.body)}`);
}
const tooMany = await api(`/finance/invoices/${invoiceId}/instalments`, owner.token, tenantId, {
  rows: Array.from({ length: 7 }, (_, i) => ({ amount: 100000, dueOn: `2026-0${i + 1}-01` })),
});
if (tooMany.status !== 400 || tooMany.body.code !== 'INSTALMENTS_INVALID') {
  throw new Error(`too many: ${JSON.stringify(tooMany.body)}`);
}
console.log('4. sum mismatch, non-ascending dates and 7 rows all rejected');

// 5. Valid 3-part plan, then REPLACED by the final 3-part plan (2 past, 1 future)
const first = await api(`/finance/invoices/${invoiceId}/instalments`, owner.token, tenantId, {
  rows: [
    { amount: 100000, dueOn: d(-150) },
    { amount: 100000, dueOn: d(-140) },
    { amount: 400000, dueOn: d(-130) },
  ],
});
if (first.status !== 201 || first.body.instalments !== 3) {
  throw new Error(`first plan: ${JSON.stringify(first.body)}`);
}
// Final plan: two instalments already due, one far in the future.
const plan = await api(`/finance/invoices/${invoiceId}/instalments`, owner.token, tenantId, {
  rows: [
    { amount: 200000, dueOn: d(-120) },
    { amount: 200000, dueOn: d(-10) },
    { amount: 200000, dueOn: d(300) },
  ],
});
if (plan.status !== 201 || plan.body.instalments !== 3 || Number(plan.body.total) !== 600000) {
  throw new Error(`plan: ${JSON.stringify(plan.body)}`);
}
const { data: planRows } = await admin
  .from('invoice_instalments').select('seq, amount, due_on')
  .eq('invoice_id', invoiceId).order('seq');
if (planRows.length !== 3 || planRows[0].due_on !== d(-120)
  || Number(planRows[2].amount) !== 200000) {
  throw new Error(`plan rows: ${JSON.stringify(planRows)}`);
}
console.log('5. plan set (3 instalments) and replaced atomically — 3 rows in DB');

// 6. Partial payment 250,000 → waterfall: #1 paid, #2 overdue (50k in), #3 due
const pay = await api(`/finance/invoices/${invoiceId}/payments`, owner.token, tenantId, {
  amount: 250000, method: 'mpesa', reference: `MP${stamp.toUpperCase()}`,
});
if (pay.status !== 201) throw new Error(`pay: ${JSON.stringify(pay.body)}`);
const schedule = await api(`/finance/invoices/${invoiceId}/instalments`, owner.token, tenantId);
if (schedule.status !== 200 || schedule.body.rows.length !== 3) {
  throw new Error(`schedule: ${JSON.stringify(schedule.body)}`);
}
const [i1, i2, i3] = schedule.body.rows;
if (i1.state !== 'paid' || Number(i1.paid) !== 200000) throw new Error(`i1: ${JSON.stringify(i1)}`);
if (i2.state !== 'overdue' || Number(i2.paid) !== 50000 || Number(i2.balance) !== 150000) {
  throw new Error(`i2: ${JSON.stringify(i2)}`);
}
if (i3.state !== 'due' || Number(i3.paid) !== 0) throw new Error(`i3: ${JSON.stringify(i3)}`);
console.log('6. 250,000 paid waterfalls by seq: paid / overdue / due');

// 7. Net-of-reversals: an extra 50,000 payment that is immediately reversed
//    must not move the debtors numbers.
const extra = await api(`/finance/invoices/${invoiceId}/payments`, owner.token, tenantId, {
  amount: 50000, method: 'cash',
});
if (extra.status !== 201) throw new Error(`extra pay: ${JSON.stringify(extra.body)}`);
const rev = await api(`/finance/payments/${extra.body.paymentId}/reverse`, owner.token, tenantId, {
  reason: 'Posted in error',
});
if (rev.status !== 201) throw new Error(`reverse: ${JSON.stringify(rev.body)}`);
debtors = await api(`/finance/debtors?asOf=${today}`, owner.token, tenantId);
if (debtors.status !== 200) throw new Error(`debtors2: ${JSON.stringify(debtors.body)}`);
row = debtors.body.classes[0].rows[0];
// due by today: instalments #1+#2 = 400,000; paid net 250,000 → overdue 150,000
if (Number(row.paid) !== 250000 || Number(row.balance) !== 350000 || Number(row.overdue) !== 150000) {
  throw new Error(`debtors row2: ${JSON.stringify(row)}`);
}
if (Number(debtors.body.totals.outstanding) !== 350000
  || Number(debtors.body.totals.ledgerAR) !== 350000
  || Number(debtors.body.totals.overdue) !== 150000) {
  throw new Error(`debtors totals2: ${JSON.stringify(debtors.body.totals)}`);
}
// Floor at zero: before instalment #1's due date nothing is overdue.
const early = await api(`/finance/debtors?asOf=${d(-130)}`, owner.token, tenantId);
if (Number(early.body.classes[0].rows[0].overdue) !== 0) {
  throw new Error(`early overdue: ${JSON.stringify(early.body.classes[0].rows[0])}`);
}
console.log('7. reversal leaves paid net 250,000; overdue 150,000 today, 0 before first due date; ties to A/R');

// 8. Reminders queue once, dedupe on the second call
const reminders = await api('/finance/reminders', owner.token, tenantId, {});
if (reminders.status !== 201 || reminders.body.queued !== 1) {
  throw new Error(`reminders: ${JSON.stringify(reminders.body)}`);
}
const again = await api('/finance/reminders', owner.token, tenantId, {});
if (again.body.queued !== 0) throw new Error(`reminder dedupe: ${JSON.stringify(again.body)}`);
console.log('8. fee reminder queued once, deduped while pending');

// 9. RBAC: cashier may read the schedule but not the debtors report
const cashierInv = await api('/invitations', owner.token, tenantId, {
  email: `ins-cashier-${stamp}@example.com`, roleKeys: ['cashier'],
});
const cashier = await makeUser(`ins-cashier-${stamp}@example.com`, 'Ins Cashier');
await api('/invitations/accept', cashier.token, null, { token: cashierInv.body.inviteUrl.split('/invite/')[1] });
const deniedDebtors = await api(`/finance/debtors?asOf=${today}`, cashier.token, tenantId);
if (deniedDebtors.status !== 403) {
  throw new Error(`cashier debtors should be 403, got ${deniedDebtors.status}`);
}
const cashierSchedule = await api(`/finance/invoices/${invoiceId}/instalments`, cashier.token, tenantId);
if (cashierSchedule.status !== 200) {
  throw new Error(`cashier schedule should be 200, got ${cashierSchedule.status}`);
}
const deniedSet = await api(`/finance/invoices/${invoiceId}/instalments`, cashier.token, tenantId, {
  rows: [{ amount: 600000, dueOn: d(30) }],
});
if (deniedSet.status !== 403) {
  throw new Error(`cashier set instalments should be 403, got ${deniedSet.status}`);
}
console.log('9. cashier: schedule readable, debtors + set-instalments denied');

// 10. Fully paid invoice: schedule can no longer be changed
const settle = await api(`/finance/invoices/${invoiceId}/payments`, owner.token, tenantId, {
  amount: 350000, method: 'cash',
});
if (settle.status !== 201 || Number(settle.body.balance) !== 0) {
  throw new Error(`settle: ${JSON.stringify(settle.body)}`);
}
const onPaid = await api(`/finance/invoices/${invoiceId}/instalments`, owner.token, tenantId, {
  rows: [{ amount: 600000, dueOn: d(60) }],
});
if (onPaid.status !== 400 || onPaid.body.code !== 'INSTALMENTS_INVOICE_PAID') {
  throw new Error(`on paid: ${JSON.stringify(onPaid.body)}`);
}
const paidSchedule = await api(`/finance/invoices/${invoiceId}/instalments`, owner.token, tenantId);
if (paidSchedule.body.rows.some((r) => r.state !== 'paid')) {
  throw new Error(`paid states: ${JSON.stringify(paidSchedule.body.rows)}`);
}
const emptyDebtors = await api(`/finance/debtors?asOf=${today}`, owner.token, tenantId);
if (emptyDebtors.status !== 200 || emptyDebtors.body.classes.length !== 0
  || Number(emptyDebtors.body.totals.ledgerAR) !== 0) {
  throw new Error(`empty debtors: ${JSON.stringify(emptyDebtors.body)}`);
}
console.log('10. settled: schedule locked, all instalments paid, debtors empty, A/R 0');

// Cleanup
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` }).eq('id', tenantId);
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
console.log('11. test tenant archived\n\nSMOKE TEST PASSED');
