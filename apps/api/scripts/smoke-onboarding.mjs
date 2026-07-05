/**
 * End-to-end smoke test for auth + onboarding.
 * Creates a throwaway user, signs in, calls the onboarding API, then
 * verifies rows and RLS through the user's own (anon) session.
 *
 * Usage: node scripts/smoke-onboarding.mjs   (expects .env vars in process.env)
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const stamp = Date.now().toString(36);
const email = `smoke-${stamp}@example.com`;
const password = `Smoke-${stamp}-Aa1!`;
const slug = `smoke-shule-${stamp}`;

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

// 1. Create a confirmed user (no email round-trip needed for the test)
const { data: created, error: createErr } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { full_name: 'Smoke Tester' },
});
if (createErr) throw new Error(`createUser: ${createErr.message}`);
console.log('1. user created:', created.user.id);

// 2. Sign in as the user
const userClient = createClient(url, anonKey, { auth: { persistSession: false } });
const { data: signin, error: signinErr } = await userClient.auth.signInWithPassword({ email, password });
if (signinErr) throw new Error(`signIn: ${signinErr.message}`);
console.log('2. signed in, token acquired');

// 3. Call the onboarding endpoint
const payload = {
  school: {
    name: `Smoke Shule ${stamp}`,
    slug,
    email,
    phone: '+255700000000',
    region: 'Dar es Salaam',
    district: 'Kinondoni',
    defaultLanguage: 'sw',
  },
  academicYear: {
    name: '2027',
    startsOn: '2027-01-05',
    endsOn: '2027-12-04',
    terms: [
      { name: 'Muhula wa Kwanza', startsOn: '2027-01-05', endsOn: '2027-06-12' },
      { name: 'Muhula wa Pili', startsOn: '2027-07-06', endsOn: '2027-12-04' },
    ],
  },
  classes: [
    { educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A', 'B'] },
    { educationLevel: 'o_level', gradeName: 'Form 2', sequence: 2, streams: ['A'] },
  ],
};

const response = await fetch(`${apiUrl}/api/v1/onboarding`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${signin.session.access_token}`,
  },
  body: JSON.stringify(payload),
});
const body = await response.json();
if (!response.ok) throw new Error(`onboarding HTTP ${response.status}: ${JSON.stringify(body)}`);
console.log('3. onboarded:', body);

// 4. Verify through the USER session (exercises RLS, not service role)
const { data: myTenants } = await userClient.from('tenants').select('id,name,slug,status');
if (myTenants?.length !== 1 || myTenants[0].slug !== slug) {
  throw new Error(`RLS tenant read failed: ${JSON.stringify(myTenants)}`);
}
const { data: sections } = await userClient.from('class_sections').select('name, grade_levels(name)');
console.log('4. RLS reads OK — tenant:', myTenants[0].name, '| sections:', sections.length);
if (sections.length !== 3) throw new Error(`expected 3 class sections, got ${sections.length}`);

// 5. Verify counts + audit through service role
const tenantId = body.tenantId;
const [terms, roles, audit] = await Promise.all([
  admin.from('academic_terms').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
  admin.from('membership_roles').select('role_id, roles(key)').limit(5),
  admin.from('audit_logs').select('action').eq('tenant_id', tenantId),
]);
console.log('5. terms:', terms.count, '| audit:', audit.data.map((a) => a.action).join(','));
if (terms.count !== 2) throw new Error('expected 2 terms');
if (!audit.data.some((a) => a.action === 'tenant.onboarded')) throw new Error('missing audit entry');

// 6. Negative test: a SECOND user must NOT see this tenant (RLS isolation)
const { data: intruder, error: intruderErr } = await admin.auth.admin.createUser({
  email: `intruder-${stamp}@example.com`,
  password,
  email_confirm: true,
});
if (intruderErr) throw new Error(intruderErr.message);
const intruderClient = createClient(url, anonKey, { auth: { persistSession: false } });
await intruderClient.auth.signInWithPassword({ email: `intruder-${stamp}@example.com`, password });
const { data: leaked } = await intruderClient.from('tenants').select('id');
if (leaked?.length) throw new Error(`TENANT LEAK: intruder sees ${leaked.length} tenants`);
console.log('6. RLS isolation OK — intruder sees 0 tenants');

// 7. Duplicate slug must be rejected
const dup = await fetch(`${apiUrl}/api/v1/onboarding`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signin.session.access_token}` },
  body: JSON.stringify(payload),
});
if (dup.status !== 409) throw new Error(`expected 409 on duplicate slug, got ${dup.status}`);
console.log('7. duplicate slug rejected with 409');

// Cleanup: the append-only audit log makes hard-deleting a tenant impossible
// by design, so archive the test tenant instead (mirrors the real
// tenant-deletion workflow, which is a process, not a DELETE).
await admin
  .from('tenants')
  .update({ status: 'archived', name: `[test] Smoke Shule ${stamp}` })
  .eq('id', tenantId);
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
console.log('8. test tenant archived (audit trail intentionally preserved)');
console.log('\nSMOKE TEST PASSED');
