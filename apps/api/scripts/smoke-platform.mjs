/**
 * End-to-end smoke test: platform layer + subscription enforcement (CTO §7).
 * Platform RBAC (staff vs school owner vs read-only support), suspend →
 * school locked out → reactivate, plan change → caps enforced immediately
 * (students + staff), trial expiry → mutations blocked / reads open, trial
 * extension → restored, onboarding rate limit (AUD-016), audit trails.
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-platform.mjs
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

// 1. Onboard a school → trial subscription auto-created
const owner = await makeUser(`plat-owner-${stamp}@example.com`, 'Platform Smoke Owner');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke Platform ${stamp}`, slug: `smoke-plat-${stamp}`, email: `plat-owner-${stamp}@example.com`, defaultLanguage: 'sw' },
  academicYear: {
    name: '2027', startsOn: '2027-01-05', endsOn: '2027-12-04',
    terms: [{ name: 'Muhula wa Kwanza', startsOn: '2027-01-05', endsOn: '2027-06-12' }],
  },
  classes: [{ educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A'] }],
});
if (onboard.status !== 201) throw new Error(`onboard: ${JSON.stringify(onboard.body)}`);
const tenantId = onboard.body.tenantId;
const { data: sub } = await admin.from('subscriptions')
  .select('status, trial_ends_at, plans(key)').eq('tenant_id', tenantId).single();
if (sub.status !== 'trialing' || sub.plans.key !== 'trial' || !sub.trial_ends_at) {
  throw new Error(`subscription: ${JSON.stringify(sub)}`);
}
console.log('1. onboarding auto-creates a 30-day trial subscription');

// 2. Platform RBAC: school owner is NOT platform staff; support is read-only
const deniedOv = await api('/platform/overview', owner.token, null, null, 'GET');
if (deniedOv.status !== 403 || deniedOv.body.code !== 'NOT_PLATFORM_STAFF') {
  throw new Error(`owner overview: ${JSON.stringify(deniedOv)}`);
}
const platAdmin = await makeUser(`plat-admin-${stamp}@example.com`, 'Platform Admin');
await admin.from('profiles').update({ platform_role: 'super_admin' }).eq('id', platAdmin.id);
const support = await makeUser(`plat-support-${stamp}@example.com`, 'Platform Support');
await admin.from('profiles').update({ platform_role: 'support' }).eq('id', support.id);
const supportRead = await api('/platform/overview', support.token, null, null, 'GET');
if (supportRead.status !== 200) throw new Error(`support read: ${supportRead.status}`);
const supportWrite = await api(`/platform/tenants/${tenantId}/suspend`, support.token, null, { reason: 'should not work' });
if (supportWrite.status !== 403 || supportWrite.body.code !== 'PLATFORM_READ_ONLY_ROLE') {
  throw new Error(`support write: ${JSON.stringify(supportWrite)}`);
}
console.log('2. platform RBAC: school owner 403; support reads but cannot act');

// 3. Overview aggregates
const ov = await api('/platform/overview', platAdmin.token, null, null, 'GET');
if (ov.status !== 200 || Number(ov.body.totals.tenants) < 1 || !ov.body.tenantsByStatus) {
  throw new Error(`overview: ${JSON.stringify(ov.body)}`);
}
console.log(`3. overview: ${ov.body.totals.tenants} tenants, ${ov.body.totals.students} students platform-wide`);

// 4. Suspend → school API access stops; reactivate → restored
const suspend = await api(`/platform/tenants/${tenantId}/suspend`, platAdmin.token, null, { reason: 'Non-payment (smoke test)' });
if (suspend.status !== 201) throw new Error(`suspend: ${JSON.stringify(suspend.body)}`);
const lockedOut = await api('/staff', owner.token, tenantId, null, 'GET');
if (lockedOut.status !== 403 || lockedOut.body.message?.code !== 'TENANT_SUSPENDED' && lockedOut.body.code !== 'TENANT_SUSPENDED') {
  throw new Error(`locked out: ${JSON.stringify(lockedOut)}`);
}
await api(`/platform/tenants/${tenantId}/reactivate`, platAdmin.token, null);
const restored = await api('/staff', owner.token, tenantId, null, 'GET');
if (restored.status !== 200) throw new Error(`restored: ${restored.status}`);
console.log('4. suspend locks the school out of the API; reactivate restores');

// 5. Plan caps enforce immediately: tiny test plan (2 students, 2 staff)
await admin.from('plans').insert({
  key: `smoke-tiny-${stamp}`, name: `[test] Tiny ${stamp}`, is_active: true,
  monthly_price_tzs: 1000, limits: { students: 2, staff: 2, campuses: 1, smsMonthly: 10 },
});
const planChange = await api(`/platform/tenants/${tenantId}/plan`, platAdmin.token, null, { planKey: `smoke-tiny-${stamp}` });
if (planChange.status !== 201) throw new Error(`plan change: ${JSON.stringify(planChange.body)}`);
const s1 = await api('/students', owner.token, tenantId, { firstName: 'Moja', lastName: 'Smoke', gender: 'male' });
const s2 = await api('/students', owner.token, tenantId, { firstName: 'Mbili', lastName: 'Smoke', gender: 'female' });
if (s1.status !== 201 || s2.status !== 201) throw new Error('students within cap failed');
const s3 = await api('/students', owner.token, tenantId, { firstName: 'Tatu', lastName: 'Smoke', gender: 'male' });
if (s3.status !== 403 || s3.body.message?.code !== 'PLAN_LIMIT_STUDENTS' && s3.body.code !== 'PLAN_LIMIT_STUDENTS') {
  throw new Error(`student cap: ${JSON.stringify(s3)}`);
}
// staff cap: owner is 1 active member; invite+accept 1 more (=2), next invite blocked
const inv1 = await api('/invitations', owner.token, tenantId, { email: `plat-t1-${stamp}@example.com`, roleKeys: ['teacher'] });
if (inv1.status !== 201) throw new Error(`invite1: ${JSON.stringify(inv1.body)}`);
const t1 = await makeUser(`plat-t1-${stamp}@example.com`, 'Teacher Moja');
await api('/invitations/accept', t1.token, null, { token: inv1.body.inviteUrl.split('/invite/')[1] });
const inv2 = await api('/invitations', owner.token, tenantId, { email: `plat-t2-${stamp}@example.com`, roleKeys: ['teacher'] });
if (inv2.status !== 403 || inv2.body.message?.code !== 'PLAN_LIMIT_STAFF' && inv2.body.code !== 'PLAN_LIMIT_STAFF') {
  throw new Error(`staff cap: ${JSON.stringify(inv2)}`);
}
console.log('5. plan change applies instantly; student + staff caps enforced in the API');

// 6. Trial expiry: mutations blocked, reads open; extension restores
await admin.from('subscriptions')
  .update({ status: 'trialing', trial_ends_at: new Date(Date.now() - 86400e3).toISOString() })
  .eq('tenant_id', tenantId);
const expiredWrite = await api('/students', owner.token, tenantId, { firstName: 'Nne', lastName: 'Smoke', gender: 'male' });
if (expiredWrite.status !== 403 || expiredWrite.body.message?.code !== 'SUBSCRIPTION_EXPIRED' && expiredWrite.body.code !== 'SUBSCRIPTION_EXPIRED') {
  throw new Error(`expired write: ${JSON.stringify(expiredWrite)}`);
}
const expiredRead = await api('/staff', owner.token, tenantId, null, 'GET');
if (expiredRead.status !== 200) throw new Error(`expired read should stay open: ${expiredRead.status}`);
const extend = await api(`/platform/tenants/${tenantId}/trial-extend`, platAdmin.token, null, { days: 30 });
if (extend.status !== 201 || new Date(extend.body.trialEndsAt) < new Date()) {
  throw new Error(`extend: ${JSON.stringify(extend.body)}`);
}
const revivedWrite = await api('/students', owner.token, tenantId, { firstName: 'Nne', lastName: 'Smoke', gender: 'male' });
if (revivedWrite.status !== 403) throw new Error(`cap should still bind after revive: ${revivedWrite.status}`);
console.log('6. expired trial blocks mutations (reads open); extension restores — caps still bind');

// 7. Onboarding rate limit (AUD-016): burst hits 429
let throttled = false;
for (let i = 0; i < 8; i++) {
  const res = await api('/onboarding', owner.token, null, { bogus: true });
  if (res.status === 429) { throttled = true; break; }
}
if (!throttled) throw new Error('onboarding burst never hit 429');
console.log('7. onboarding burst rate-limited (429)');

// 8. Audit: platform log + mirrored tenant log
const { data: platAudits } = await admin.from('platform_audit_logs')
  .select('action').eq('tenant_id', tenantId);
const actions = platAudits.map((a) => a.action);
for (const expected of ['platform.tenant_suspended', 'platform.tenant_reactivated', 'platform.plan_changed', 'platform.trial_extended']) {
  if (!actions.includes(expected)) throw new Error(`missing platform audit ${expected}`);
}
const { data: mirrored } = await admin.from('audit_logs')
  .select('action').eq('tenant_id', tenantId).eq('action', 'platform.tenant_suspended');
if (mirrored.length !== 1) throw new Error('suspension not mirrored into tenant audit log');
console.log('8. platform actions audited (platform log + tenant mirror)');

// Cleanup
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` }).eq('id', tenantId);
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
await admin.from('plans').update({ is_active: false }).eq('key', `smoke-tiny-${stamp}`);
await admin.from('profiles').update({ platform_role: null }).in('id', [platAdmin.id, support.id]);
console.log('9. cleanup done\n\nSMOKE TEST PASSED');
