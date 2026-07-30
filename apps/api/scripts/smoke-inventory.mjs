/**
 * End-to-end smoke test: inventory items, in/out movements, insufficient-stock
 * guard rail, computed stock math, low-stock flag, movement history, RBAC.
 * Requires migration 00000000000022_inventory.sql to be applied.
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-inventory.mjs
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
const owner = await makeUser(`inv-owner-${stamp}@example.com`, 'Inv Owner');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke Inv ${stamp}`, slug: `smoke-inv-${stamp}`, email: `inv-owner-${stamp}@example.com`, defaultLanguage: 'sw' },
  academicYear: {
    name: '2027', startsOn: '2027-01-05', endsOn: '2027-12-04',
    terms: [{ name: 'Muhula wa Kwanza', startsOn: '2027-01-05', endsOn: '2027-06-12' }],
  },
  classes: [{ educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A'] }],
});
if (onboard.status !== 201) throw new Error(`onboard: ${onboard.status} ${JSON.stringify(onboard.body)}`);
const tenantId = onboard.body.tenantId;
console.log('1. school onboarded');

// 2. Item with a reorder level; duplicate name rejected with 409
const item = await api('/inventory/items', owner.token, tenantId, {
  name: 'Chaki nyeupe', unit: 'boksi', reorderLevel: 5,
});
if (item.status !== 201 || !item.body.itemId) throw new Error(`item: ${item.status} ${JSON.stringify(item.body)}`);
const dup = await api('/inventory/items', owner.token, tenantId, {
  name: 'Chaki nyeupe', unit: 'pcs',
});
if (dup.status !== 409 || dup.body.code !== 'INVENTORY_ITEM_DUPLICATE') {
  throw new Error(`dup item: ${dup.status} ${JSON.stringify(dup.body)}`);
}
console.log('2. item created (duplicate 409)');

// 3. Stock in 10, out 4 → stock 6 returned by the RPC each time
const inMove = await api('/inventory/movements', owner.token, tenantId, {
  itemId: item.body.itemId, kind: 'in', quantity: 10, note: 'Manunuzi',
});
if (inMove.status !== 201 || inMove.body.stock !== 10) {
  throw new Error(`in: ${inMove.status} ${JSON.stringify(inMove.body)}`);
}
const outMove = await api('/inventory/movements', owner.token, tenantId, {
  itemId: item.body.itemId, kind: 'out', quantity: 4, note: 'Darasa la kwanza',
});
if (outMove.status !== 201 || outMove.body.stock !== 6) {
  throw new Error(`out: ${outMove.status} ${JSON.stringify(outMove.body)}`);
}
console.log('3. in 10 / out 4 → stock 6');

// 4. Issuing more than the stock → INVENTORY_INSUFFICIENT (stock unchanged)
const tooMuch = await api('/inventory/movements', owner.token, tenantId, {
  itemId: item.body.itemId, kind: 'out', quantity: 100,
});
if (tooMuch.status !== 400 || tooMuch.body.code !== 'INVENTORY_INSUFFICIENT') {
  throw new Error(`insufficient: ${tooMuch.status} ${JSON.stringify(tooMuch.body)}`);
}
console.log('4. over-issue rejected (INVENTORY_INSUFFICIENT)');

// 5. Listing math: stock 6 > reorder 5 → not low; after out 2 → 4 → low
let list = await api('/inventory', owner.token, tenantId, null, 'GET');
let row = list.body.data.find((i) => i.id === item.body.itemId);
if (list.status !== 200 || row.stock !== 6 || row.lowStock !== false) {
  throw new Error(`list: ${JSON.stringify(list.body)}`);
}
await api('/inventory/movements', owner.token, tenantId, {
  itemId: item.body.itemId, kind: 'out', quantity: 2,
});
list = await api('/inventory', owner.token, tenantId, null, 'GET');
row = list.body.data.find((i) => i.id === item.body.itemId);
if (row.stock !== 4 || row.lowStock !== true) {
  throw new Error(`low stock: ${JSON.stringify(row)}`);
}
console.log('5. stock math + low-stock flag correct');

// 6. Movement history (newest first), rejected movement not recorded
const history = await api(`/inventory/items/${item.body.itemId}/movements`, owner.token, tenantId, null, 'GET');
if (history.status !== 200 || history.body.data.length !== 3) {
  throw new Error(`history: ${history.status} ${JSON.stringify(history.body)}`);
}
if (history.body.data[0].kind !== 'out' || history.body.data[0].quantity !== 2) {
  throw new Error(`history order: ${JSON.stringify(history.body.data)}`);
}
console.log('6. movement history correct (3 rows, newest first)');

// 7. RBAC: bursar can view + manage; teacher gets 403 on view
const bursarInvite = await api('/invitations', owner.token, tenantId, {
  email: `inv-bursar-${stamp}@example.com`, roleKeys: ['bursar'],
});
const bursar = await makeUser(`inv-bursar-${stamp}@example.com`, 'Inv Bursar');
await api('/invitations/accept', bursar.token, null, {
  token: bursarInvite.body.inviteUrl.split('/invite/')[1],
});
const bursarView = await api('/inventory', bursar.token, tenantId, null, 'GET');
if (bursarView.status !== 200) throw new Error(`bursar view: ${bursarView.status}`);
const bursarCreate = await api('/inventory/items', bursar.token, tenantId, {
  name: 'Madaftari', unit: 'pcs', reorderLevel: 50,
});
if (bursarCreate.status !== 201) throw new Error(`bursar create: ${bursarCreate.status} ${JSON.stringify(bursarCreate.body)}`);

const teacherInvite = await api('/invitations', owner.token, tenantId, {
  email: `inv-teacher-${stamp}@example.com`, roleKeys: ['teacher'],
});
const teacher = await makeUser(`inv-teacher-${stamp}@example.com`, 'Inv Teacher');
await api('/invitations/accept', teacher.token, null, {
  token: teacherInvite.body.inviteUrl.split('/invite/')[1],
});
const teacherView = await api('/inventory', teacher.token, tenantId, null, 'GET');
if (teacherView.status !== 403) throw new Error(`teacher view should be 403, got ${teacherView.status}`);
const { data: audits } = await admin
  .from('audit_logs').select('action').eq('tenant_id', tenantId)
  .eq('action', 'inventory.moved');
if (audits.length !== 3) throw new Error(`audit: ${JSON.stringify(audits)}`);
console.log('7. RBAC enforced (bursar manages, teacher blocked); movements audited');

// Cleanup: archive test tenant
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` }).eq('id', tenantId);
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
console.log('8. test tenant archived\n\nSMOKE TEST PASSED');
