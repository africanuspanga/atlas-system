/**
 * Demo school seeder — "Chief Sarwatt School" (Babati, Manyara).
 *
 * Builds a fully-populated demo tenant through the real APIs so school owners
 * can see every module working with realistic Tanzanian data: ~260 students
 * across Form 1-6, guardians (with sibling phone sharing), 12 school days of
 * attendance registers, two published exams per O-Level stream with NECTA
 * grading, invoices + mobile-money payments (including partials and one
 * audited reversal), announcements and queued fee reminders.
 *
 * Idempotent: exits early if the demo school already exists.
 *
 * Run: set -a && source .env && set +a && node apps/api/scripts/seed-demo.mjs
 * Requires the API running on :4000.
 *
 * Demo logins (password for all: DemoAtlas2026!):
 *   demo@chiefsarwatt.sc.tz          school owner (the login-page demo button)
 *   mwalimumkuu@chiefsarwatt.sc.tz   head teacher
 *   mwalimu@chiefsarwatt.sc.tz       teacher
 *   bursar@chiefsarwatt.sc.tz        bursar
 *   mzazi@chiefsarwatt.sc.tz         parent (portal)
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const PASSWORD = 'DemoAtlas2026!';
const SLUG = 'chief-sarwatt';
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

// Seeded RNG so re-creating the demo produces the same school.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260705);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const MALE = ['Baraka', 'Daudi', 'Emmanuel', 'Frank', 'Godfrey', 'Hamisi', 'Ibrahim', 'Juma', 'Kelvin', 'Lukas', 'Musa', 'Noel', 'Obadia', 'Peter', 'Rajabu', 'Samweli', 'Thomas', 'Yohana', 'Zablon', 'Amani', 'Boniface', 'Castro', 'Dickson', 'Elisha'];
const FEMALE = ['Neema', 'Zawadi', 'Rehema', 'Anna', 'Beatrice', 'Catherine', 'Dorcas', 'Esther', 'Furaha', 'Gloria', 'Halima', 'Irene', 'Joyce', 'Lulu', 'Mariam', 'Naomi', 'Pendo', 'Queen', 'Ruth', 'Salome', 'Tumaini', 'Upendo', 'Vumilia', 'Witness'];
const SURNAMES = ['Sarwatt', 'Mushi', 'Komba', 'Mwakyusa', 'Massawe', 'Mollel', 'Laizer', 'Sanga', 'Mbise', 'Swai', 'Urio', 'Macha', 'Temba', 'Kimaro', 'Lyimo', 'Shirima', 'Mmari', 'Tarimo', 'Munuo', 'Ngowi', 'Bayo', 'Gidamis', 'Hhando', 'Qamara'];

async function makeUser(email, fullName) {
  const { data, error } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: fullName },
  });
  let id = data?.user?.id;
  if (error) {
    if (!/already/i.test(error.message)) throw new Error(`${email}: ${error.message}`);
    const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
    id = list.users.find((u) => u.email === email)?.id;
  }
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data: signin, error: e2 } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (e2) throw new Error(`${email} signin: ${e2.message}`);
  return { id, client, token: signin.session.access_token };
}

let ownerToken;
let tenantId;
async function api(path, body, method = 'POST', token = ownerToken) {
  const res = await fetch(`${apiUrl}/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

/** Run tasks with limited concurrency. */
async function pool(items, worker, size = 6) {
  const results = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (index < items.length) {
        const i = index++;
        results[i] = await worker(items[i], i);
      }
    }),
  );
  return results;
}

// ---------------------------------------------------------------------------
// 0. Guard: skip if the demo school already exists
// ---------------------------------------------------------------------------
const { data: existing } = await admin.from('tenants').select('id').eq('slug', SLUG).maybeSingle();
if (existing) {
  console.log(`Demo school already exists (tenant ${existing.id}) — nothing to do.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Owner + school
// ---------------------------------------------------------------------------
const owner = await makeUser('demo@chiefsarwatt.sc.tz', 'Amani Sarwatt');
ownerToken = owner.token;
const onboard = await api('/onboarding', {
  school: {
    name: 'Chief Sarwatt School', slug: SLUG, email: 'demo@chiefsarwatt.sc.tz',
    phone: '+255744000001', region: 'Manyara', district: 'Babati', defaultLanguage: 'sw',
  },
  academicYear: {
    name: '2026', startsOn: '2026-01-05', endsOn: '2026-12-04',
    terms: [
      { name: 'Muhula wa Kwanza', startsOn: '2026-01-05', endsOn: '2026-07-17' },
      { name: 'Muhula wa Pili', startsOn: '2026-07-27', endsOn: '2026-12-04' },
    ],
  },
  classes: [
    { educationLevel: 'o_level', gradeName: 'Form 1', sequence: 1, streams: ['A', 'B'] },
    { educationLevel: 'o_level', gradeName: 'Form 2', sequence: 2, streams: ['A', 'B'] },
    { educationLevel: 'o_level', gradeName: 'Form 3', sequence: 3, streams: ['A', 'B'] },
    { educationLevel: 'o_level', gradeName: 'Form 4', sequence: 4, streams: ['A', 'B'] },
    { educationLevel: 'a_level', gradeName: 'Form 5', sequence: 5, streams: ['A'] },
    { educationLevel: 'a_level', gradeName: 'Form 6', sequence: 6, streams: ['A'] },
  ],
});
tenantId = onboard.tenantId;
console.log(`1. Chief Sarwatt School created (${tenantId})`);

// ---------------------------------------------------------------------------
// 2. Staff
// ---------------------------------------------------------------------------
const STAFF = [
  { email: 'mwalimumkuu@chiefsarwatt.sc.tz', name: 'Eliakimu Mollel', roles: ['head_teacher'] },
  { email: 'mwalimu@chiefsarwatt.sc.tz', name: 'Joyce Kimaro', roles: ['teacher', 'class_teacher'] },
  { email: 'bursar@chiefsarwatt.sc.tz', name: 'Grace Massawe', roles: ['bursar'] },
  { email: 'kaimu@chiefsarwatt.sc.tz', name: 'Hamisi Bayo', roles: ['school_admin'] },
];
for (const staff of STAFF) {
  const invite = await api('/invitations', { email: staff.email, roleKeys: staff.roles });
  const user = await makeUser(staff.email, staff.name);
  await api('/invitations/accept', { token: invite.inviteUrl.split('/invite/')[1] }, 'POST', user.token);
}
console.log('2. 4 staff joined (head teacher, class teacher, bursar, admin)');

// ---------------------------------------------------------------------------
// 3. Students with guardians
// ---------------------------------------------------------------------------
const SECTION_PLAN = [
  { className: 'Form 1', stream: 'A', count: 30 }, { className: 'Form 1', stream: 'B', count: 28 },
  { className: 'Form 2', stream: 'A', count: 29 }, { className: 'Form 2', stream: 'B', count: 27 },
  { className: 'Form 3', stream: 'A', count: 28 }, { className: 'Form 3', stream: 'B', count: 26 },
  { className: 'Form 4', stream: 'A', count: 27 }, { className: 'Form 4', stream: 'B', count: 25 },
  { className: 'Form 5', stream: 'A', count: 20 }, { className: 'Form 6', stream: 'A', count: 18 },
];
let phoneCounter = 100;
let lastGuardian = null;
let studentIndex = 0;
for (const plan of SECTION_PLAN) {
  const rows = [];
  for (let i = 0; i < plan.count; i++) {
    studentIndex += 1;
    const female = rand() < 0.5;
    const surname = pick(SURNAMES);
    const yearOfBirth = 2013 - Number(plan.className.slice(-1));
    // every ~9th student is a sibling of the previous one (same guardian phone)
    const sibling = lastGuardian && studentIndex % 9 === 0;
    const guardian = sibling
      ? { ...lastGuardian }
      : {
          fullName: `${pick(rand() < 0.5 ? MALE : FEMALE)} ${surname}`,
          phone: `+2557440${String(phoneCounter++).padStart(5, '0')}`,
          email: rand() < 0.4 ? `guardian${studentIndex}@example.com` : undefined,
          relationship: pick(['mother', 'father', 'guardian']),
        };
    lastGuardian = guardian;
    rows.push({
      firstName: female ? pick(FEMALE) : pick(MALE),
      lastName: sibling ? guardian.fullName.split(' ').at(-1) : surname,
      gender: female ? 'female' : 'male',
      dateOfBirth: `${yearOfBirth}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`,
      boardingStatus: rand() < 0.3 ? 'boarding' : 'day',
      className: plan.className,
      stream: plan.stream,
      guardian,
    });
  }
  await api('/students/import', { rows, dryRun: false });
}
console.log(`3. ${studentIndex} students imported across 10 streams (siblings share guardians)`);

// section id → enrolled students
const { data: sections } = await owner.client
  .from('class_sections')
  .select('id, name, grade_levels(name, education_level)');
const { data: enrolments } = await owner.client
  .from('class_enrolments')
  .select('class_section_id, student_id');
const bySection = new Map();
for (const e of enrolments) {
  if (!bySection.has(e.class_section_id)) bySection.set(e.class_section_id, []);
  bySection.get(e.class_section_id).push(e.student_id);
}
const { data: terms } = await owner.client.from('academic_terms').select('id, name').order('starts_on');
const term1 = terms[0].id;

// per-student "ability" drives marks and attendance
const ability = new Map();
for (const ids of bySection.values()) for (const id of ids) ability.set(id, 0.3 + rand() * 0.7);

// ---------------------------------------------------------------------------
// 4. Attendance — the last 12 school days (weekdays before today)
// ---------------------------------------------------------------------------
const days = [];
for (let d = new Date('2026-07-05'); days.length < 12; d.setDate(d.getDate() - 1)) {
  const day = d.getDay();
  if (day !== 0 && day !== 6) days.push(d.toISOString().slice(0, 10));
}
days.reverse();
const sessionJobs = [];
for (const [sectionId, studentIds] of bySection) {
  for (const date of days) {
    sessionJobs.push({ sectionId, date, studentIds });
  }
}
await pool(sessionJobs, async (job) => {
  await api('/attendance', {
    classSectionId: job.sectionId,
    date: job.date,
    records: job.studentIds.map((studentId) => {
      const r = rand();
      const skill = ability.get(studentId);
      const status = r < 0.90 + skill * 0.07 ? 'present' : r < 0.96 ? 'absent' : r < 0.985 ? 'late' : 'excused';
      return { studentId, status };
    }),
  });
});
console.log(`4. ${sessionJobs.length} attendance registers marked (${days.length} school days × 10 streams)`);

// ---------------------------------------------------------------------------
// 5. Subjects + two published exams per O-Level stream
// ---------------------------------------------------------------------------
await api('/subjects/preset', { educationLevel: 'o_level' });
await api('/subjects/preset', { educationLevel: 'a_level' });
const { data: subjects } = await owner.client
  .from('subjects').select('id, code, education_level').eq('education_level', 'o_level').order('code');
const CORE = ['CIV', 'HIS', 'GEO', 'KIS', 'ENG', 'PHY', 'CHE', 'BIO', 'BAM'];
const coreSubjects = CORE.map((code) => subjects.find((s) => s.code === code));

const oLevelSections = sections.filter((s) => s.grade_levels.education_level === 'o_level');
const scoreJobs = [];
for (const section of oLevelSections) {
  const studentIds = bySection.get(section.id) ?? [];
  for (const exam of [
    { name: 'Mtihani wa Kati ya Muhula', type: 'midterm', weight: 1 },
    { name: 'Mtihani wa Mwisho wa Muhula', type: 'terminal', weight: 2 },
  ]) {
    const created = await api('/assessments', {
      name: exam.name, type: exam.type, weight: exam.weight,
      classSectionId: section.id, academicTermId: term1,
    });
    for (const subject of coreSubjects) {
      scoreJobs.push({
        assessmentId: created.assessmentId,
        subjectId: subject.id,
        rows: studentIds.map((studentId) => ({
          studentId,
          marks: Math.max(8, Math.min(98, Math.round(
            20 + ability.get(studentId) * 65 + (rand() - 0.5) * 24,
          ))),
        })),
      });
    }
  }
}
await pool(scoreJobs, (job) =>
  api(`/assessments/${job.assessmentId}/scores`, { subjectId: job.subjectId, rows: job.rows }),
);
const { data: draftAssessments } = await owner.client
  .from('assessments').select('id').eq('status', 'draft');
await pool(draftAssessments, (a) => api(`/assessments/${a.id}/publish`));
console.log(`5. ${draftAssessments.length} exams published (${scoreJobs.length} subject sheets, 9 NECTA subjects)`);

// ---------------------------------------------------------------------------
// 6. Finance — fee items, invoices, payments (with one reversal)
// ---------------------------------------------------------------------------
const bursar = await makeUser('bursar@chiefsarwatt.sc.tz', 'Grace Massawe');
const feeDay = await api('/finance/fee-items', { name: 'Ada ya Shule (Kutwa)', amount: 850000 }, 'POST', bursar.token);
const feeBoard = await api('/finance/fee-items', { name: 'Ada ya Shule (Bweni)', amount: 1250000 }, 'POST', bursar.token);
const feeDev = await api('/finance/fee-items', { name: 'Mchango wa Maendeleo', amount: 50000 }, 'POST', bursar.token);
const feeBus = await api('/finance/fee-items', { name: 'Usafiri wa Shule', amount: 180000 }, 'POST', bursar.token);

const { data: allStudents } = await owner.client
  .from('students').select('id, boarding_status').order('student_number');
const METHODS = ['mpesa', 'mpesa', 'mpesa', 'mpesa', 'tigopesa', 'tigopesa', 'airtel_money', 'halopesa', 'bank', 'bank', 'cash'];
let paymentCount = 0;
let reversalDone = false;
await pool(allStudents, async (student) => {
  const lines = [{ feeItemId: student.boarding_status === 'boarding' ? feeBoard.feeItemId : feeDay.feeItemId },
    { feeItemId: feeDev.feeItemId }];
  if (student.boarding_status === 'day' && rand() < 0.2) lines.push({ feeItemId: feeBus.feeItemId });
  const invoice = await api('/finance/invoices', {
    studentId: student.id, academicTermId: term1, dueOn: '2026-03-31', lines,
  }, 'POST', bursar.token);

  const total = Number(invoice.total);
  const r = rand();
  const payments = [];
  if (r < 0.65) {
    // fully paid, often in two instalments
    if (rand() < 0.5) {
      const first = Math.round(total * (0.3 + rand() * 0.4) / 1000) * 1000;
      payments.push(first, total - first);
    } else payments.push(total);
  } else if (r < 0.85) {
    payments.push(Math.round(total * (0.2 + rand() * 0.5) / 1000) * 1000);
  }
  for (const amount of payments) {
    if (amount <= 0) continue;
    const method = pick(METHODS);
    const pay = await api(`/finance/invoices/${invoice.invoiceId}/payments`, {
      amount, method,
      reference: method === 'cash' ? undefined : `TX${Math.floor(rand() * 1e9)}`,
    }, 'POST', bursar.token);
    paymentCount += 1;
    if (!reversalDone && r < 0.65 && payments.length === 2 && amount === payments[0]) {
      // one demo reversal with its paper trail
      await api(`/finance/payments/${pay.paymentId}/reverse`, { reason: 'Muamala wa M-Pesa ulirudishwa na mtandao' }, 'POST', bursar.token);
      await api(`/finance/invoices/${invoice.invoiceId}/payments`, { amount, method: 'bank', reference: `TX${Math.floor(rand() * 1e9)}` }, 'POST', bursar.token);
      paymentCount += 1;
      reversalDone = true;
    }
  }
}, 5);
console.log(`6. ${allStudents.length} invoices + ${paymentCount} payments recorded (1 audited reversal)`);

// ---------------------------------------------------------------------------
// 7. Communication + parent portal + fee reminders
// ---------------------------------------------------------------------------
await api('/communication/announcements', {
  audienceType: 'all_guardians',
  body: 'Ndugu mzazi/mlezi, mkutano wa wazazi utafanyika Jumamosi tarehe 18 Julai saa tatu asubuhi shuleni. Karibuni sana.',
});
const f1a = sections.find((s) => s.grade_levels.name === 'Form 1' && s.name === 'A');
await api('/communication/announcements', {
  audienceType: 'class_section', classSectionId: f1a.id,
  body: 'Wazazi wa Form 1A: matokeo ya Mtihani wa Mwisho wa Muhula yametoka. Karibuni kupokea ripoti.',
});

// link a demo parent to the first Form 1A student's guardian
const firstF1A = bySection.get(f1a.id)[0];
const { data: guardianLink } = await owner.client
  .from('student_guardians').select('guardian_id').eq('student_id', firstF1A).limit(1);
await admin.from('guardians')
  .update({ email: 'mzazi@chiefsarwatt.sc.tz' })
  .eq('id', guardianLink[0].guardian_id);
const parentInvite = await api(`/guardians/${guardianLink[0].guardian_id}/invite`, null);
const parent = await makeUser('mzazi@chiefsarwatt.sc.tz', 'Mzazi Demo');
await api('/invitations/accept', { token: parentInvite.inviteUrl.split('/invite/')[1] }, 'POST', parent.token);

const reminders = await api('/finance/reminders', null, 'POST', bursar.token);
console.log(`7. 2 announcements + parent portal account linked + ${reminders.queued} fee reminders queued`);

// ---------------------------------------------------------------------------
// 8. Verification spot checks
// ---------------------------------------------------------------------------
const report = await api(`/assessments/report-card?studentId=${firstF1A}&termId=${term1}`, null, 'GET');
if (!report.division || report.subjects.length !== 9) {
  throw new Error(`report check failed: ${JSON.stringify({ division: report.division, subjects: report.subjects.length })}`);
}
const portal = await api('/portal/children', null, 'GET', parent.token);
if (portal.children.length < 1) throw new Error('portal check failed');
const { data: jl } = await admin.from('journal_lines').select('debit, credit').eq('tenant_id', tenantId);
const debits = jl.reduce((s, l) => s + Number(l.debit), 0);
const credits = jl.reduce((s, l) => s + Number(l.credit), 0);
if (debits !== credits) throw new Error(`ledger unbalanced: ${debits} vs ${credits}`);
console.log(`8. checks OK — report card Division ${report.division}, portal live, ledger balanced (TZS ${debits.toLocaleString()})`);

console.log(`\nDEMO READY — Chief Sarwatt School
  Owner:        demo@chiefsarwatt.sc.tz / ${PASSWORD}
  Head teacher: mwalimumkuu@chiefsarwatt.sc.tz / ${PASSWORD}
  Teacher:      mwalimu@chiefsarwatt.sc.tz / ${PASSWORD}
  Bursar:       bursar@chiefsarwatt.sc.tz / ${PASSWORD}
  Parent:       mzazi@chiefsarwatt.sc.tz / ${PASSWORD}`);
