/**
 * End-to-end smoke test: platform super-dashboard metrics (migration 0024).
 * Revenue/MRR aggregates, per-tenant health buckets (fresh tenant = silent /
 * never, silent-first ordering), unit costs over a date range, platform RBAC
 * (school owner 403), input validation, archive cleanup.
 * Requires migration 00000000000024_platform_metrics.sql applied.
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-platform-metrics.mjs
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

// 1. Onboard a fresh throwaway school (no activity → must show as silent/never)
const owner = await makeUser(`metrics-owner-${stamp}@example.com`, 'Metrics Smoke Owner');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke Metrics ${stamp}`, slug: `smoke-metrics-${stamp}`, email: `metrics-owner-${stamp}@example.com`, defaultLanguage: 'sw' },
  academicYear: {
    name: '2027', startsOn: '2027-01-05', endsOn: '2027-12-04',
    terms: [{ name: 'Muhula wa Kwanza', startsOn: '2027-01-05', endsOn: '2027-06-12' }],
  },
  classes: [{ educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A'] }],
});
if (onboard.status !== 201) throw new Error(`onboard: ${JSON.stringify(onboard.body)}`);
const tenantId = onboard.body.tenantId;
console.log('1. fresh throwaway tenant onboarded');

// 2. RBAC: school owner is not platform staff → 403 on all three endpoints
for (const path of ['/platform/revenue', '/platform/health', '/platform/unit-costs']) {
  const denied = await api(path, owner.token, null, null, 'GET');
  if (denied.status !== 403 || denied.body.code !== 'NOT_PLATFORM_STAFF') {
    throw new Error(`owner ${path}: ${JSON.stringify(denied)}`);
  }
}
console.log('2. non-platform user gets 403 NOT_PLATFORM_STAFF on all three endpoints');

// 3. Read-only platform staff (support) can read revenue
const support = await makeUser(`metrics-support-${stamp}@example.com`, 'Metrics Support');
await admin.from('profiles').update({ platform_role: 'support' }).eq('id', support.id);
const rev = await api('/platform/revenue', support.token, null, null, 'GET');
if (rev.status !== 200) throw new Error(`revenue: ${JSON.stringify(rev.body)}`);
if (typeof rev.body.mrrTzs !== 'number' && typeof rev.body.mrrTzs !== 'string') {
  throw new Error(`revenue.mrrTzs: ${JSON.stringify(rev.body.mrrTzs)}`);
}
if (!Array.isArray(rev.body.perPlan) || !Array.isArray(rev.body.trialsExpiringSoon)) {
  throw new Error(`revenue shape: ${JSON.stringify(Object.keys(rev.body))}`);
}
const trialPlan = rev.body.perPlan.find((p) => p.planKey === 'trial');
if (!trialPlan || Number(trialPlan.tenants) < 1) {
  throw new Error(`perPlan trial row: ${JSON.stringify(rev.body.perPlan)}`);
}
if (Number(rev.body.subscriptionsByStatus.trialing ?? 0) < 1) {
  throw new Error(`subscriptionsByStatus: ${JSON.stringify(rev.body.subscriptionsByStatus)}`);
}
if (!rev.body.tenantsByStatus || typeof rev.body.payingTenants !== 'number') {
  throw new Error(`revenue pipeline/paying: ${JSON.stringify(rev.body)}`);
}
console.log(`3. revenue: MRR TZS ${rev.body.mrrTzs}, ${rev.body.payingTenants} paying, ${rev.body.perPlan.length} plans`);

// 4. Health: fresh tenant is silent / never; silent bucket sorted first
const health = await api('/platform/health', support.token, null, null, 'GET');
if (health.status !== 200 || !Array.isArray(health.body.tenants)) {
  throw new Error(`health: ${JSON.stringify(health.body)}`);
}
const mine = health.body.tenants.find((h) => h.tenantId === tenantId);
if (!mine) throw new Error('fresh tenant missing from health list');
if (mine.health !== 'silent' || mine.lastActivityAt !== null) {
  throw new Error(`fresh tenant should be silent/never: ${JSON.stringify(mine)}`);
}
if (Number(mine.staff) < 1 || Number(mine.students) !== 0) {
  throw new Error(`fresh tenant counts: ${JSON.stringify(mine)}`);
}
for (const key of ['attendanceSessions7d', 'assessmentScores7d', 'payments7d', 'aiMessages7d']) {
  if (Number(mine[key]) !== 0) throw new Error(`fresh tenant ${key} should be 0`);
}
const rank = { silent: 0, quiet: 1, active: 2 };
for (let i = 1; i < health.body.tenants.length; i++) {
  if (rank[health.body.tenants[i - 1].health] > rank[health.body.tenants[i].health]) {
    throw new Error('health list is not ordered silent-first');
  }
}
console.log(`4. health: ${health.body.tenants.length} tenants, fresh tenant silent/never, silent-first order holds`);

// 5. Unit costs: default range (current month) + explicit range; fresh tenant all-zero
const costsDefault = await api('/platform/unit-costs', support.token, null, null, 'GET');
if (costsDefault.status !== 200 || !costsDefault.body.from || !costsDefault.body.to) {
  throw new Error(`unit-costs default: ${JSON.stringify(costsDefault.body)}`);
}
const from = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
const to = new Date().toISOString().slice(0, 10);
const costs = await api(`/platform/unit-costs?from=${from}&to=${to}`, support.token, null, null, 'GET');
if (costs.status !== 200 || !Array.isArray(costs.body.tenants)) {
  throw new Error(`unit-costs: ${JSON.stringify(costs.body)}`);
}
const myCosts = costs.body.tenants.find((c) => c.tenantId === tenantId);
if (!myCosts) throw new Error('fresh tenant missing from unit costs');
if (Number(myCosts.smsQueued) !== 0 || Number(myCosts.aiRequests) !== 0 || Number(myCosts.aiTokens) !== 0) {
  throw new Error(`fresh tenant should have zero costs: ${JSON.stringify(myCosts)}`);
}
if (myCosts.planKey !== 'trial') throw new Error(`plan on cost row: ${JSON.stringify(myCosts)}`);
console.log('5. unit costs: default month range works; fresh tenant zero SMS / zero AI on trial plan');

// 6. Validation: malformed and inverted ranges → 400 INVALID_DATE_RANGE
const bad = await api('/platform/unit-costs?from=not-a-date', support.token, null, null, 'GET');
if (bad.status !== 400 || bad.body.code !== 'INVALID_DATE_RANGE') {
  throw new Error(`bad date: ${JSON.stringify(bad)}`);
}
const inverted = await api(`/platform/unit-costs?from=${to}&to=${from}`, support.token, null, null, 'GET');
if (inverted.status !== 400 || inverted.body.code !== 'INVALID_DATE_RANGE') {
  throw new Error(`inverted range: ${JSON.stringify(inverted)}`);
}
console.log('6. unit-costs validates the date range (400 INVALID_DATE_RANGE)');

// 7. Archive → tenant drops out of health and unit costs
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` }).eq('id', tenantId);
const healthAfter = await api('/platform/health', support.token, null, null, 'GET');
if (healthAfter.body.tenants.some((h) => h.tenantId === tenantId)) {
  throw new Error('archived tenant still listed in health');
}
const costsAfter = await api('/platform/unit-costs', support.token, null, null, 'GET');
if (costsAfter.body.tenants.some((c) => c.tenantId === tenantId)) {
  throw new Error('archived tenant still listed in unit costs');
}
console.log('7. archived tenant excluded from health and unit costs');

// Cleanup
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
await admin.from('profiles').update({ platform_role: null }).eq('id', support.id);
console.log('8. cleanup done\n\nSMOKE TEST PASSED');
