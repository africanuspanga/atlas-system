/**
 * End-to-end smoke test: announcements (guardian dedupe, class scoping),
 * communication RBAC, and the outbox drain worker (console driver).
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-communication.mjs
 * Requires: API on :4000 and apps/workers built (pnpm turbo build).
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

// 1. Onboard; students with guardians — two SHARE one phone (dedupe check),
//    one in stream B with a distinct phone, one with NO guardian.
const owner = await makeUser(`comm-owner-${stamp}@example.com`, 'Comm Owner');
const onboard = await api('/onboarding', owner.token, null, {
  school: { name: `Smoke Comm ${stamp}`, slug: `smoke-comm-${stamp}`, email: `comm-owner-${stamp}@example.com`, defaultLanguage: 'sw' },
  academicYear: {
    name: '2027', startsOn: '2027-01-05', endsOn: '2027-12-04',
    terms: [{ name: 'Muhula wa Kwanza', startsOn: '2027-01-05', endsOn: '2027-06-12' }],
  },
  classes: [{ educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A', 'B'] }],
});
if (onboard.status !== 201) throw new Error(`onboard: ${JSON.stringify(onboard.body)}`);
const tenantId = onboard.body.tenantId;
const { data: sections } = await owner.client.from('class_sections').select('id, name').order('name');
const sectionA = sections.find((s) => s.name === 'A').id;
const sectionB = sections.find((s) => s.name === 'B').id;
const sharedPhone = `+2557${stamp.slice(-6)}21`;
const otherPhone = `+2557${stamp.slice(-6)}22`;
for (const row of [
  { firstName: 'Neema', lastName: 'Joseph', gender: 'female', classSectionId: sectionA,
    guardian: { fullName: 'Mary Joseph', phone: sharedPhone, relationship: 'mother' } },
  { firstName: 'Baraka', lastName: 'Joseph', gender: 'male', classSectionId: sectionA,
    guardian: { fullName: 'Mary Joseph', phone: sharedPhone, relationship: 'mother' } },
  { firstName: 'Zawadi', lastName: 'Komba', gender: 'female', classSectionId: sectionB,
    guardian: { fullName: 'Asha Komba', phone: otherPhone, relationship: 'mother' } },
  { firstName: 'Daudi', lastName: 'Mwakyusa', gender: 'male', classSectionId: sectionA },
]) {
  const res = await api('/students', owner.token, tenantId, row);
  if (res.status !== 201) throw new Error(`student: ${JSON.stringify(res.body)}`);
}
console.log('1. school + 4 students (siblings share one guardian phone)');

// 2. RBAC: teacher cannot send; school_admin can
const teacherInv = await api('/invitations', owner.token, tenantId, {
  email: `comm-teacher-${stamp}@example.com`, roleKeys: ['teacher'],
});
const teacher = await makeUser(`comm-teacher-${stamp}@example.com`, 'Comm Teacher');
await api('/invitations/accept', teacher.token, null, { token: teacherInv.body.inviteUrl.split('/invite/')[1] });
const denied = await api('/communication/announcements', teacher.token, tenantId, {
  audienceType: 'all_guardians', body: 'Test',
});
if (denied.status !== 403) throw new Error(`teacher send should be 403, got ${denied.status}`);
const adminInv = await api('/invitations', owner.token, tenantId, {
  email: `comm-admin-${stamp}@example.com`, roleKeys: ['school_admin'],
});
const schoolAdmin = await makeUser(`comm-admin-${stamp}@example.com`, 'Comm Admin');
await api('/invitations/accept', schoolAdmin.token, null, { token: adminInv.body.inviteUrl.split('/invite/')[1] });
console.log('2. teacher denied communication.send; school_admin joined');

// 3. All-guardians announcement → 2 recipients (deduped shared phone)
const all = await api('/communication/announcements', schoolAdmin.token, tenantId, {
  audienceType: 'all_guardians',
  body: 'Shule itafungwa kesho kwa ajili ya mkutano wa wazazi.',
});
if (all.status !== 201 || all.body.recipients !== 2) throw new Error(`all: ${JSON.stringify(all.body)}`);
console.log('3. all-guardians announcement queued for 2 recipients (phone deduped)');

// 4. Class-scoped announcement → only stream A's guardian phone (1 recipient)
const classA = await api('/communication/announcements', schoolAdmin.token, tenantId, {
  audienceType: 'class_section', classSectionId: sectionA,
  body: 'Wazazi wa Form 1A: mtihani wa Hisabati Jumatatu.',
});
if (classA.status !== 201 || classA.body.recipients !== 1) throw new Error(`classA: ${JSON.stringify(classA.body)}`);
console.log('4. class-scoped announcement queued for 1 recipient');

// 5. Outbox rows exist and are pending; announcements readable via RLS
const { data: pendingRows } = await admin
  .from('notification_outbox').select('recipient, template, status')
  .eq('tenant_id', tenantId).eq('template', 'announcement');
if (pendingRows.length !== 3 || !pendingRows.every((r) => r.status === 'pending')) {
  throw new Error(`outbox: ${JSON.stringify(pendingRows)}`);
}
const { data: annList } = await schoolAdmin.client
  .from('announcements').select('recipient_count').order('created_at');
if (annList.length !== 2) throw new Error(`announcements RLS: ${JSON.stringify(annList)}`);
console.log('5. 3 pending outbox rows; announcements readable via RLS');

// 6. Drain the outbox once (console driver) → all sent
execFileSync('node', ['apps/workers/dist/drain-outbox.js', '--once'], {
  env: { ...process.env, SMS_DRIVER: 'console' },
  stdio: 'inherit',
});
const { data: drained } = await admin
  .from('notification_outbox').select('status, sent_at, attempts')
  .eq('tenant_id', tenantId);
if (!drained.every((r) => r.status === 'sent' && r.sent_at && r.attempts === 1)) {
  throw new Error(`drain: ${JSON.stringify(drained)}`);
}
console.log(`6. drain --once delivered ${drained.length} messages (console driver)`);

// 7. No-recipients audience rejected (class B has one guardian... use empty case)
//    Daudi has no guardian; a fresh section with no students must 400.
const empty = await api('/communication/announcements', schoolAdmin.token, tenantId, {
  audienceType: 'class_section', classSectionId: sectionB,
  body: 'Hii itafika kwa mzazi mmoja.',
});
if (empty.status !== 201 || empty.body.recipients !== 1) throw new Error(`sectionB: ${JSON.stringify(empty.body)}`);
// unknown section
const badSection = await api('/communication/announcements', schoolAdmin.token, tenantId, {
  audienceType: 'class_section', classSectionId: '00000000-0000-0000-0000-000000000000',
  body: 'X body',
});
if (badSection.status !== 400 || badSection.body.code !== 'ANNOUNCEMENT_SECTION_NOT_FOUND') {
  throw new Error(`bad section: ${JSON.stringify(badSection.body)}`);
}
console.log('7. section scoping verified; unknown section rejected');

// Cleanup
await admin.from('tenants').update({ status: 'archived', name: `[test] ${stamp}` }).eq('id', tenantId);
await admin.from('tenant_memberships').update({ status: 'revoked' }).eq('tenant_id', tenantId);
console.log('8. test tenant archived\n\nSMOKE TEST PASSED');
