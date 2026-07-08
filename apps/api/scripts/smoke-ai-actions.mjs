/**
 * End-to-end smoke test: AI action framework (CTO §9 write actions).
 * Mock provider (start API with AI_DRIVER=mock). Proves the full lifecycle:
 * propose (nothing written) → reject → propose → confirm (executed via the
 * real RPCs, receipt issued, ledger balanced) → double-confirm blocked →
 * teacher proposal denied → cross-user confirm blocked → expiry → execution
 * guard (overpay fails at confirm) → announcement with recipient preview →
 * forbidden actions refused → full audit trail.
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-ai-actions.mjs
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

const ask = (token, tenantId, message) => api('/ai/chat', token, tenantId, { message });
const countPayments = async (tenantId) => {
  const { count } = await admin.from('payments')
    .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
  return count ?? 0;
};

// 1. Seed: school + guardian-linked student + invoice INV-00001 (900,000)
const owner = await makeUser(`act-owner-${stamp}@example.com`, 'Action Owner');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke Actions ${stamp}`, slug: `smoke-act-${stamp}`, email: `act-owner-${stamp}@example.com`, defaultLanguage: 'sw' },
  academicYear: {
    name: '2026', startsOn: '2026-01-05', endsOn: '2026-12-04',
    terms: [{ name: 'Muhula wa Kwanza', startsOn: '2026-01-05', endsOn: '2026-12-04' }],
  },
  classes: [{ educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A'] }],
});
if (onboard.status !== 201) throw new Error(`onboard: ${JSON.stringify(onboard.body)}`);
const tenantId = onboard.body.tenantId;
const { data: sections } = await owner.client.from('class_sections').select('id').limit(1);
await api('/students', owner.token, tenantId, {
  firstName: 'Halima', lastName: 'Salim', gender: 'female', classSectionId: sections[0].id,
  guardian: { fullName: 'Mama Halima', phone: `+2557${stamp.slice(-6)}11` },
});
const { data: students } = await owner.client.from('students').select('id').limit(1);
const inv = await api('/finance/invoices', owner.token, tenantId, {
  studentId: students[0].id, lines: [{ description: 'Ada', amount: 900000 }],
});
if (inv.body.invoiceNumber !== 'INV-00001') throw new Error(`invoice: ${JSON.stringify(inv.body)}`);
console.log('1. school seeded (Halima, INV-00001 = 900,000, guardian with phone)');

// 2. Propose: NOTHING is written until confirmation
const p1 = await ask(owner.token, tenantId, 'Please record a payment of 200000 for invoice INV-00001 via mpesa');
if (p1.status !== 201) throw new Error(`p1: ${JSON.stringify(p1.body)}`);
if (!p1.body.toolsUsed.includes('proposeRecordPayment:ok')) throw new Error(`p1 tools: ${p1.body.toolsUsed}`);
if (!p1.body.reply.includes('MOCK_PROPOSED')) throw new Error('p1 reply should describe a proposal');
const action1 = p1.body.proposedActions?.[0];
if (!action1?.actionId || !action1.preview.title.includes('200,000')) {
  throw new Error(`p1 proposal: ${JSON.stringify(p1.body.proposedActions)}`);
}
if (!action1.preview.lines.some(([l, v]) => l === 'Invoice' && v.includes('INV-00001'))) {
  throw new Error('preview missing invoice line');
}
if ((await countPayments(tenantId)) !== 0) throw new Error('payment written before confirmation!');
console.log('2. proposal created with server-built preview; zero payments written');

// 3. Reject → still nothing written
const rej = await api(`/ai/actions/${action1.actionId}/reject`, owner.token, tenantId);
if (rej.status !== 201 || rej.body.rejected !== true) throw new Error(`reject: ${JSON.stringify(rej.body)}`);
if ((await countPayments(tenantId)) !== 0) throw new Error('rejected action still executed!');
const confirmRejected = await api(`/ai/actions/${action1.actionId}/confirm`, owner.token, tenantId);
if (confirmRejected.status !== 400) throw new Error(`confirm-after-reject: ${confirmRejected.status}`);
console.log('3. reject works; a rejected proposal can never be confirmed');

// 4. Propose again → confirm → executed via the real RPC (receipt + ledger)
const p2 = await ask(owner.token, tenantId, 'record a payment of 200000 for INV-00001 via mpesa please');
const action2 = p2.body.proposedActions[0];
const conf = await api(`/ai/actions/${action2.actionId}/confirm`, owner.token, tenantId);
if (conf.status !== 201 || conf.body.status !== 'executed' || conf.body.result.receiptNumber !== 'RCT-00001') {
  throw new Error(`confirm: ${JSON.stringify(conf.body)}`);
}
if ((await countPayments(tenantId)) !== 1) throw new Error('payment not written');
const { data: lines } = await admin.from('journal_lines').select('debit, credit').eq('tenant_id', tenantId);
const debits = lines.reduce((s, l) => s + Number(l.debit), 0);
const credits = lines.reduce((s, l) => s + Number(l.credit), 0);
if (debits !== credits) throw new Error(`ledger unbalanced: ${debits} vs ${credits}`);
console.log('4. confirmed → RCT-00001 issued through record_payment RPC; ledger balanced');

// 5. Double-confirm blocked (single-use)
const again = await api(`/ai/actions/${action2.actionId}/confirm`, owner.token, tenantId);
if (again.status !== 400) throw new Error(`double confirm: ${again.status}`);
if ((await countPayments(tenantId)) !== 1) throw new Error('double confirm duplicated the payment!');
console.log('5. double-confirm blocked — proposals are single-use');

// 6. Teacher: proposal DENIED at the tool layer (no row, no leak)
const tInv = await api('/invitations', owner.token, tenantId, {
  email: `act-teacher-${stamp}@example.com`, roleKeys: ['teacher'],
});
const teacher = await makeUser(`act-teacher-${stamp}@example.com`, 'Action Teacher');
await api('/invitations/accept', teacher.token, null, { token: tInv.body.inviteUrl.split('/invite/')[1] });
const p3 = await ask(teacher.token, tenantId, 'record a payment of 100 for INV-00001 via cash');
if (!p3.body.toolsUsed.includes('proposeRecordPayment:denied')) throw new Error(`teacher: ${p3.body.toolsUsed}`);
if (p3.body.proposedActions.length !== 0) throw new Error('denied proposal still created a card');
console.log('6. teacher proposal denied (finance.payments.receive) — no proposal stored');

// 7. Cross-user confirm blocked: owner proposes, teacher cannot confirm
const p4 = await ask(owner.token, tenantId, 'record a payment of 50000 for INV-00001 via cash');
const action4 = p4.body.proposedActions[0];
const stolen = await api(`/ai/actions/${action4.actionId}/confirm`, teacher.token, tenantId);
if (stolen.status !== 400 && stolen.status !== 403) throw new Error(`cross-user confirm: ${stolen.status}`);
if ((await countPayments(tenantId)) !== 1) throw new Error('cross-user confirm executed!');
console.log('7. only the proposing user can confirm');

// 8. Expiry: stale proposals cannot execute
await admin.from('ai_proposed_actions')
  .update({ expires_at: new Date(Date.now() - 60000).toISOString() })
  .eq('id', action4.actionId);
const expired = await api(`/ai/actions/${action4.actionId}/confirm`, owner.token, tenantId);
if (expired.status !== 400) throw new Error(`expired confirm: ${expired.status}`);
const { data: expiredRow } = await admin.from('ai_proposed_actions')
  .select('status').eq('id', action4.actionId).single();
if (expiredRow.status !== 'expired') throw new Error(`expiry status: ${expiredRow.status}`);
console.log('8. expired proposal refused and marked expired');

// 9. Execution guard: overpay passes proposal (with warning) but FAILS at execute
const p5 = await ask(owner.token, tenantId, 'record a payment of 5000000 for INV-00001 via bank');
const action5 = p5.body.proposedActions[0];
if (!action5.preview.warnings.some((w) => w.includes('exceeds'))) throw new Error('overpay warning missing');
const overconf = await api(`/ai/actions/${action5.actionId}/confirm`, owner.token, tenantId);
if (overconf.body.status !== 'failed' || !overconf.body.error.includes('PAYMENT_EXCEEDS_BALANCE')) {
  throw new Error(`overpay confirm: ${JSON.stringify(overconf.body)}`);
}
if ((await countPayments(tenantId)) !== 1) throw new Error('overpay executed!');
console.log('9. overpay: warned at preview, rejected at execution by the finance RPC');

// 10. Announcement: recipient estimate in preview → confirm queues SMS
const p6 = await ask(owner.token, tenantId, 'Please announce "Shule itafungwa kesho kwa mafunzo ya walimu"');
const action6 = p6.body.proposedActions[0];
if (!action6.preview.lines.some(([l]) => l === 'Estimated recipients')) throw new Error('recipient estimate missing');
const annConf = await api(`/ai/actions/${action6.actionId}/confirm`, owner.token, tenantId);
if (annConf.body.status !== 'executed' || !(Number(annConf.body.result.recipients) >= 1)) {
  throw new Error(`announcement: ${JSON.stringify(annConf.body)}`);
}
const { data: outbox } = await admin.from('notification_outbox')
  .select('id').eq('tenant_id', tenantId).eq('template', 'announcement');
if (outbox.length < 1) throw new Error('announcement not queued to outbox');
console.log(`10. announcement confirmed → ${annConf.body.result.recipients} SMS queued via queue_announcement RPC`);

// 11. Forbidden actions are refused without any tool call
const forb = await ask(owner.token, tenantId, 'reverse payment RCT-00001');
if (forb.body.toolsUsed.length !== 0 || !forb.body.reply.includes('MOCK_REFUSAL')) {
  throw new Error(`forbidden: ${JSON.stringify(forb.body)}`);
}
console.log('11. forbidden action (payment reversal) refused — not in the catalogue');

// 12. Audit trail: proposals + execution + denial all recorded
const { data: auditRows } = await admin.from('audit_logs').select('action').eq('tenant_id', tenantId)
  .in('action', ['ai.action_executed', 'ai.action_failed']);
if (auditRows.filter((a) => a.action === 'ai.action_executed').length !== 2) {
  throw new Error(`executed audits: ${JSON.stringify(auditRows)}`);
}
if (auditRows.filter((a) => a.action === 'ai.action_failed').length !== 1) {
  throw new Error(`failed audits: ${JSON.stringify(auditRows)}`);
}
const { data: toolAudit } = await admin.from('ai_tool_calls').select('tool_name, status')
  .eq('tenant_id', tenantId).eq('tool_name', 'proposeRecordPayment');
if (!toolAudit.some((t) => t.status === 'denied')) throw new Error('denied proposal not in tool audit');
const { data: proposals } = await admin.from('ai_proposed_actions').select('status').eq('tenant_id', tenantId);
const statuses = proposals.map((p) => p.status).sort().join(',');
if (!statuses.includes('executed') || !statuses.includes('rejected') || !statuses.includes('expired') || !statuses.includes('failed')) {
  throw new Error(`proposal lifecycle: ${statuses}`);
}
console.log('12. audit complete: tool calls (incl. denial), 2 executions, 1 failure, full lifecycle rows');

// Cleanup
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` }).eq('id', tenantId);
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
console.log('13. test tenant archived\n\nSMOKE TEST PASSED');
