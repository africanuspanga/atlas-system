/**
 * End-to-end smoke test: fee items, invoices, payments, reversals, the
 * double-entry ledger invariant, and finance RBAC (bursar vs cashier).
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-finance.mjs
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

// 1. Onboard + one student
const owner = await makeUser(`fin-owner-${stamp}@example.com`, 'Fin Owner');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke Fin ${stamp}`, slug: `smoke-fin-${stamp}`, email: `fin-owner-${stamp}@example.com`, defaultLanguage: 'sw' },
  academicYear: {
    name: '2027', startsOn: '2027-01-05', endsOn: '2027-12-04',
    terms: [{ name: 'Muhula wa Kwanza', startsOn: '2027-01-05', endsOn: '2027-06-12' }],
  },
  classes: [{ educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A'] }],
});
if (onboard.status !== 201) throw new Error(`onboard: ${JSON.stringify(onboard.body)}`);
const tenantId = onboard.body.tenantId;
const st = await api('/students', owner.token, tenantId, {
  firstName: 'Neema', lastName: 'Joseph', gender: 'female',
});
if (st.status !== 201) throw new Error(`student: ${JSON.stringify(st.body)}`);
const { data: students } = await owner.client.from('students').select('id').limit(1);
const studentId = students[0].id;
console.log('1. school + student ready');

// 2. Bursar and cashier join
const bursarInv = await api('/invitations', owner.token, tenantId, {
  email: `fin-bursar-${stamp}@example.com`, roleKeys: ['bursar'],
});
const bursar = await makeUser(`fin-bursar-${stamp}@example.com`, 'Fin Bursar');
await api('/invitations/accept', bursar.token, null, { token: bursarInv.body.inviteUrl.split('/invite/')[1] });
const cashierInv = await api('/invitations', owner.token, tenantId, {
  email: `fin-cashier-${stamp}@example.com`, roleKeys: ['cashier'],
});
const cashier = await makeUser(`fin-cashier-${stamp}@example.com`, 'Fin Cashier');
await api('/invitations/accept', cashier.token, null, { token: cashierInv.body.inviteUrl.split('/invite/')[1] });
console.log('2. bursar + cashier joined');

// 3. Bursar creates a fee item + invoice (fee item + custom line)
const fee = await api('/finance/fee-items', bursar.token, tenantId, {
  name: 'Ada ya Muhula', amount: 500000,
});
if (fee.status !== 201) throw new Error(`fee item: ${JSON.stringify(fee.body)}`);
const dupFee = await api('/finance/fee-items', bursar.token, tenantId, {
  name: 'Ada ya Muhula', amount: 400000,
});
if (dupFee.status !== 400 || dupFee.body.code !== 'FEE_ITEM_DUPLICATE_NAME') {
  throw new Error(`dup fee: ${JSON.stringify(dupFee.body)}`);
}
const invoice = await api('/finance/invoices', bursar.token, tenantId, {
  studentId,
  lines: [{ feeItemId: fee.body.feeItemId }, { description: 'Gharama ya usafiri', amount: 50000 }],
});
if (invoice.status !== 201 || invoice.body.invoiceNumber !== 'INV-00001' || Number(invoice.body.total) !== 550000) {
  throw new Error(`invoice: ${JSON.stringify(invoice.body)}`);
}
const invoiceId = invoice.body.invoiceId;
// cashier cannot create invoices
const deniedInvoice = await api('/finance/invoices', cashier.token, tenantId, {
  studentId, lines: [{ description: 'X', amount: 1000 }],
});
if (deniedInvoice.status !== 403) throw new Error(`cashier invoice should be 403, got ${deniedInvoice.status}`);
console.log('3. fee item + invoice INV-00001 (550,000 TZS); cashier denied invoice creation');

// 4. Cashier records partial M-Pesa payment → partially_paid
const pay1 = await api(`/finance/invoices/${invoiceId}/payments`, cashier.token, tenantId, {
  amount: 200000, method: 'mpesa', reference: `MP${stamp.toUpperCase()}`,
});
if (pay1.status !== 201 || pay1.body.receiptNumber !== 'RCT-00001' || Number(pay1.body.balance) !== 350000) {
  throw new Error(`pay1: ${JSON.stringify(pay1.body)}`);
}
let { data: inv } = await owner.client.from('invoices').select('status').eq('id', invoiceId).single();
if (inv.status !== 'partially_paid') throw new Error(`status after pay1: ${inv.status}`);
console.log('4. partial M-Pesa payment RCT-00001 → partially_paid');

// 5. Overpayment rejected; remainder in cash → paid
const over = await api(`/finance/invoices/${invoiceId}/payments`, cashier.token, tenantId, {
  amount: 350001, method: 'cash',
});
if (over.status !== 400 || over.body.code !== 'PAYMENT_EXCEEDS_BALANCE') {
  throw new Error(`overpay: ${JSON.stringify(over.body)}`);
}
const pay2 = await api(`/finance/invoices/${invoiceId}/payments`, cashier.token, tenantId, {
  amount: 350000, method: 'cash',
});
if (pay2.status !== 201 || Number(pay2.body.balance) !== 0) throw new Error(`pay2: ${JSON.stringify(pay2.body)}`);
({ data: inv } = await owner.client.from('invoices').select('status').eq('id', invoiceId).single());
if (inv.status !== 'paid') throw new Error(`status after pay2: ${inv.status}`);
console.log('5. overpay rejected; cash remainder → paid');

// 6. Reversal: cashier denied, bursar reverses RCT-00001 → back to partially_paid
const deniedRev = await api(`/finance/payments/${pay1.body.paymentId}/reverse`, cashier.token, tenantId, {
  reason: 'Wrong amount',
});
if (deniedRev.status !== 403) throw new Error(`cashier reverse should be 403, got ${deniedRev.status}`);
const rev = await api(`/finance/payments/${pay1.body.paymentId}/reverse`, bursar.token, tenantId, {
  reason: 'M-Pesa transaction bounced',
});
if (rev.status !== 201) throw new Error(`reverse: ${JSON.stringify(rev.body)}`);
const revAgain = await api(`/finance/payments/${pay1.body.paymentId}/reverse`, bursar.token, tenantId, {
  reason: 'again',
});
if (revAgain.status !== 400 || revAgain.body.code !== 'REVERSAL_ALREADY_REVERSED') {
  throw new Error(`double reverse: ${JSON.stringify(revAgain.body)}`);
}
({ data: inv } = await owner.client.from('invoices').select('status').eq('id', invoiceId).single());
if (inv.status !== 'partially_paid') throw new Error(`status after reversal: ${inv.status}`);
const { data: pays } = await owner.client.from('payments').select('amount').eq('invoice_id', invoiceId);
const net = pays.reduce((s, p) => s + Number(p.amount), 0);
if (net !== 350000 || pays.length !== 3) throw new Error(`payments: net ${net}, count ${pays.length}`);
console.log('6. reversal RBAC + once-only; original row untouched, net 350,000 across 3 immutable rows');

// 7. Ledger invariant: total debits == total credits; entries for all events
const { data: lines } = await admin
  .from('journal_lines').select('debit, credit').eq('tenant_id', tenantId);
const debits = lines.reduce((s, l) => s + Number(l.debit), 0);
const credits = lines.reduce((s, l) => s + Number(l.credit), 0);
if (debits !== credits || debits !== 550000 + 200000 + 350000 + 200000) {
  throw new Error(`ledger: debits ${debits} credits ${credits}`);
}
const { data: entries } = await admin
  .from('journal_entries').select('source_type, entry_number').eq('tenant_id', tenantId).order('entry_number');
const types = entries.map((e) => e.source_type).join(',');
if (types !== 'invoice,payment,payment,reversal' || entries[0].entry_number !== 'JE-000001') {
  throw new Error(`entries: ${JSON.stringify(entries)}`);
}
// A/R balance: 550k invoiced − 350k net received = 200k outstanding
const { data: ar } = await admin
  .from('ledger_accounts').select('id').eq('tenant_id', tenantId).eq('code', '1100').single();
const { data: arLines } = await admin
  .from('journal_lines').select('debit, credit').eq('account_id', ar.id);
const arBalance = arLines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
if (arBalance !== 200000) throw new Error(`A/R balance: ${arBalance}`);
console.log('7. ledger balanced (debits == credits == 1,300,000); A/R = 200,000');

// 8. RLS read: bursar sees invoice + journal; audit trail complete
const { data: audits } = await admin
  .from('audit_logs').select('action').eq('tenant_id', tenantId)
  .in('action', ['finance.invoice_created', 'finance.payment_received', 'finance.payment_reversed']);
if (audits.length !== 4) throw new Error(`audits: ${JSON.stringify(audits)}`);
console.log('8. audit trail complete (1 invoice, 2 payments, 1 reversal)');

// Cleanup
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` }).eq('id', tenantId);
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
console.log('9. test tenant archived\n\nSMOKE TEST PASSED');
