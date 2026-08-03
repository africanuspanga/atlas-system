# ATLAS — Full Code Review & Bug Hunt (2026-07-31)

> **Historical review, superseded 3 August 2026.** Do not use its pending-
> migration statements or proposed commands as the current handover. The
> verified system is at migration `0033`; see `GO_LIVE_READINESS_2026-08-03.md`
> and `../ATLAS_TESTING_GUIDE.md`.

Branch `audit/production-readiness`. Scope: entire working tree — 51,508 LOC across
`apps/api` (NestJS), `apps/web` (Next 16), `apps/workers`, `apps/mobile` (Expo),
`packages/i18n`, `supabase/migrations` 0001–0028, `apps/api/scripts`.

**Method.** 14 parallel dimension finders (tenant isolation, authz, RLS/SQL, finance,
TZ payroll+NECTA, AI surface, input validation, concurrency, web security, web
correctness, schema/perf, workers, config/ops, mobile/i18n) → dedup → adversarial
verification (every finding attacked by a refuter whose default position was "this is
wrong"; critical/high findings additionally attacked by a second exploitability lens)
→ completeness critic → 5 targeted gap sweeps. 171 agents, 12.2M tokens.

**Result.** 123 raw → 112 deduped → **26 refuted** → **103 confirmed**:
1 critical, 10 high, 41 medium, 51 low.

Independently re-verified by hand before publication: the profiles privilege escalation,
the finance RLS permission gap, the absent student-status writer, the missing body limit,
the turbo gate (14/14 green), and the systemic UTC/EAT date defect.

---


## CRITICAL (1)

### 1. Any signed-in user can self-promote to platform super_admin and read/archive every school

- **Location:** `supabase/migrations/00000000000001_control_plane.sql:327`
- **Category:** privilege-escalation · **Verdict:** CONFIRMED (high) · **Found by:** tenant-isolation+authz-permissions+web-security

**What is wrong.** The `own profile update` RLS policy has no WITH CHECK and no column scoping, and Supabase grants `authenticated` table-wide UPDATE on public.profiles, so a user can set their own `profiles.platform_role` to 'super_admin' — the single value PlatformGuard uses to authorize the cross-tenant /platform/* API.

**How it fails.** A teacher at School A signs in to the web app, opens devtools and issues `PATCH /rest/v1/profiles?id=eq.<their own uuid>` with body `{"platform_role":"super_admin"}` using the anon key + their own JWT. The policy's USING clause (`id = auth.uid()`) passes, no WITH CHECK restricts the new row, and no column grant blocks the write. They then call `GET /api/v1/platform/tenants` and receive the name, slug, status and subscription of EVERY school on the platform; `GET /api/v1/platform/tenants/:id` returns any school's entitlements plus its 20 most recent audit_log actions; `GET /api/v1/platform/revenue` returns platform-wide finances; and `POST /api/v1/platform/tenants/<competitor-school-id>/archive` with `{reason:'x',force:true}` sets that school's status to 'archived', at which point TenantGuard throws TENANT_ARCHIVED for every one of its staff and the school is locked out of ATLAS entirely.

**Evidence.**

```
supabase/migrations/00000000000001_control_plane.sql:327-328
```sql
create policy "own profile update" on public.profiles
  for update using (id = auth.uid());
```
profiles carries the platform role (same file, line 158-159):
```sql
  platform_role text
    check (platform_role in ('super_admin','support','finance','implementation','auditor')),
```
apps/api/src/platform/platform.guard.ts:36-51 — this column is the ONLY authorization in front of every cross-tenant endpoint:
```ts
    const { data: profile } = await this.supabase.admin
      .from('profiles')
      .select('platform_role')
      .eq('id', request.user.id)
      .maybeSingle();
    const role = profile?.platform_role as string | null | undefined;
    if (!role) {
      throw new ForbiddenException({ code: 'NOT_PLATFORM_STAFF' });
    }
    ...
    if (needsWrite && role !== 'super_admin') {
```
```

**Fix.** No code change is needed — the fix is already written. Apply supabase/migrations/00000000000026_production_hardening.sql:34-43 to the live database (revoke update on public.profiles from anon, authenticated; grant update (full_name, phone, preferred_language, avatar_path) on public.profiles to authenticated; recreate the "own profile update" policy with an explicit WITH CHECK (id = auth.uid())). The API uses the service-role key so it is unaffected by the grant change, and no web/mobile code writes profiles from the client. Human must run: set -a && source .env && set +a && /usr/local/opt/postgresql@17/bin/psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/00000000000026_production_hardening.sql (or the full {16..28} loop from CLAUDE.md). Two hardening additions worth making while there, both in a new additive migration: (1) add a BEFORE UPDATE trigger on public.profiles that raises unless platform_role is unchanged or current_user is the service role, so the column is protected by data rules and not only by a privilege grant that a future ALTER DEFAULT PRIVILEGES or a `grant all` convenience statement could silently restore; (2) in apps/api/src/platform/platform.guard.ts, log an audit row on every successful platform-role resolution so an out-of-band promotion is detectable.

---


## HIGH (10)

### 2. Re-uploading a student roster silently duplicates every student (DUP_EXISTING is a committable 'warning' and there is no way to skip a row)

- **Location:** `apps/api/src/imports/imports.controller.ts:727`
- **Category:** idempotency · **Verdict:** CONFIRMED (high) · **Found by:** concurrency-idempotency

**What is wrong.** A row flagged as an exact duplicate of an existing student is classified 'warning', and warning rows are committed by the import worker. `import_staging_rows.decision` ('import' | 'skip') is never written by any endpoint or UI, so a school has no way to exclude duplicates — re-running an import creates a second copy of every student.

**How it fails.** A 620-student school imports roster.xlsx. The bursar notices one wrong date of birth, fixes it in Excel and re-uploads the same file. Validation marks all 620 rows duplicate_status='existing' / validation_status='warning' (only DUP_IN_FILE is a hard stop). The approve button offers `valid + warnings` = 620 rows; `app.import_commit_chunk` selects `decision='import' and validation_status in ('valid','warning')` and inserts 620 NEW students with fresh STU- numbers, new guardians links and new class_enrolments (the unique (student_id, academic_year_id) constraint does not fire because the student ids are new). The school now has 1,240 students, its plan `usage.students` doubles, every class roster is doubled, and students cannot be deleted (only archived) so cleanup is manual, row by row.

**Evidence.**

```
imports.controller.ts:717-736 —
```
} else if (existingKeys.has(dupKey)) {
  duplicate = 'existing';
  issues.push({ field: 'name', code: 'DUP_EXISTING',
    message: 'A student with this name + date of birth already exists' });
}
...
const hard = issues.some((i) =>
  ['NAME_REQUIRED','NAME_INCOMPLETE','GENDER_INVALID','DOB_UNPARSEABLE','SECTION_UNMATCHED','DUP_IN_FILE'].includes(i.code),
);   // DUP_EXISTING deliberately absent -> validation_status = 'warning'
```
imports.controller.ts:427-431 — `const committable = Number(job.valid_rows ?? 0) + Number(job.warning_rows ?? 0);`
supabase/migrations/00000000000011_import_pipeline.sql:178-187 —
```
select * from public.import_staging_rows
where import_job_id = p_job_id
  and decision = 'import'
  and validation_status in ('valid','warning')
```
`grep -rn "decision" apps/api/src apps/web/src` returns no write to `import_staging_rows.decision` anywhere — the column keeps its `default 'import'` (0011:67). Contrast the opening_balances validator (imports.controller.ts:852) where `const hard = issues.some((i) => i.code !== 'DATE_UNPARSEABLE')` correctly makes ALREADY_IMPORTED a hard stop.
```

**Fix.** Minimal fix (one line, matches the opening_balances posture): in `/Users/admin/Atlas-System/apps/api/src/imports/imports.controller.ts`, add `'DUP_EXISTING'` to the `hard` code list at line 727-735 in `validateStudents`, so rows matching an existing student become `validation_status='invalid'`, drop out of `valid_rows + warning_rows` at line 427-429, and are excluded by `app.import_commit_chunk`'s `validation_status in ('valid','warning')` filter. They still appear in the dry-run issue list and the worker's errors.csv, so the operator sees exactly which rows were skipped.

Two fixes that must ship with it, or the first one is unreliable:
1. Line 596 (`.from('students').select('first_name, last_name, date_of_birth').eq('tenant_id', …).limit(10000)`): replace with `.range()` pagination in 1000-row pages (copy `loadStagingRows` at lines 105-129, or `writeErrorReport` in `apps/workers/src/process-imports.ts`). Today PostgREST truncates this at 1000 rows, so schools above 1000 students get no duplicate detection at all. The same bare `.limit(10000)` at line 761 in `validateOpeningBalances` has the identical bug and should be paginated too.
2. Include `middleName` in the duplicate key at line 706 (and select `middle_name` into `existingKeys` at 589-596) so two genuinely distinct students sharing first+last+DOB are not hard-blocked — the false-positive risk that presumably motivated 'warning' in the first place.

Proper follow-up (restores operator control, which hard-blocking removes): add `decision` to the write-back upsert column list at lines 341-353, defaulting to `'skip'` whenever `duplicate_status !== 'none'`, and add `PUT /imports/:id/rows/:rowNumber/decision` (`@RequirePermission('imports.manage')`, zod `z.enum(['import','skip'])`, job status must be `'validated'`) plus a per-row toggle in the step-3 card of `/Users/admin/Atlas-System/apps/web/src/app/imports/imports-view.tsx` (around lines 335-389, where the Approve label must then read the recomputed committable count rather than `summary.valid + summary.warnings`). A DB backstop is not required once the commit filter excludes duplicates, but a partial unique index on `(tenant_id, lower(first_name), lower(last_name), date_of_birth) where status = 'active'` in a new additive migration would make the commit genuinely idempotent — note it needs a data audit first, since existing tenants may already hold colliding rows.

---

### 3. Import duplicate/lookup reads use .limit(10000)/.limit(20000), silently truncated to 1000 by PostgREST — opening balances for students 1001+ are rejected and prior imports re-import

- **Location:** `apps/api/src/imports/imports.controller.ts:761`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** data-integrity-perf+workers-outbox

**What is wrong.** Three import-validation reads use `.limit(10000)`/`.limit(20000)` on tables that routinely exceed 1000 rows. PostgREST caps the response at 1000 rows regardless of `.limit()` (documented in this repo at apps/workers/src/process-imports.ts:67-68 and in CLAUDE.md), so the student-number map, the existing-student duplicate set, and the already-imported opening-balance set are all silently truncated, producing both false rejections and duplicate financial postings.

**How it fails.** A Premium-plan school with 1,600 active students uploads an opening-balances file for all 1,600. `validateOpeningBalances` builds `byNumber` from a truncated 1,000-row `students` read (line 757-761, arbitrary order — no `.order()`). The ~600 students missing from the map produce `STUDENT_NOT_FOUND`, which is in the `hard` set (line 852: every issue except `DATE_UNPARSEABLE` is hard), so those 600 rows become `validation_status='invalid'` and `import_commit_chunk` never commits them (migration 0011 line 182 selects only `valid`/`warning`). The bursar sees 1,000 imported and 600 'no such student' errors for students that plainly exist. Worse: on the retry upload, `alreadyImported` (line 771-791) is also truncated to 1,000 prior rows, so students whose balance DID import are no longer recognised as duplicates, get `duplicate_status='none'`, validate as `valid`, and `import_commit_chunk` posts a SECOND opening-balance invoice + a second `debit 1100 / credit 3000` journal entry (migration 0011 lines 248-269). Those invoices are immutable — the only correction is a manual reversal, and every affected parent is now double-billed and appears on the debtors report at 2× their real balance.

**Evidence.**

```
apps/api/src/imports/imports.controller.ts:757-761:
```ts
    const { data: students } = await this.supabase.admin
      .from('students')
      .select('id, student_number')
      .eq('tenant_id', req.tenant.tenantId)
      .limit(10000);
```
line 778-786:
```ts
      const { data: priorRows } = await this.supabase.admin
        .from('import_staging_rows')
        .select('mapped_data')
        .in('import_job_id', priorJobs.map((j) => j.id as string))
        .not('final_record_id', 'is', null)
        .limit(20000);
```
and line 592-596 (same bug for student duplicate detection):
```ts
    const { data: existing } = await this.supabase.admin
      .from('students')
      .select('first_name, last_name, date_of_birth')
      .eq('tenant_id', req.tenant.tenantId)
      .limit(10000);
```
The cap is documented in this very repo — apps/workers/src/process-imports.ts:67-68:
```ts
  // Paginate past PostgREST's 1000-row cap (a bare .limit(5000) silently
  // truncates at 1000). Cap the report at 5000 problem rows.
```
and `loadStagingRows` (same controller, lines 110-129) already paginates correctly with `.range()`.
```

**Fix.** In apps/api/src/imports/imports.controller.ts, replace all three `.limit(N>1000)` reads with paginated reads modelled on the existing `loadStagingRows` (lines 110-129), each with an explicit `.order()` so pages are stable:

1. Add a small generic helper next to `loadStagingRows`, e.g.
```ts
private async readAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = []; const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw new InternalServerErrorException({ code: 'IMPORT_LOOKUP_FAILED' });
    out.push(...(data ?? []));
    if (!data || data.length < page) break;
  }
  return out;
}
```
2. Line 757-761 (`validateOpeningBalances` student-number map): page over `students` with `.order('id')` (or `.order('student_number')`) instead of `.limit(10000)`. Cheaper alternative that also fixes it: since the file is capped at 5000 rows, look up only the numbers actually present — chunk the distinct uppercased `studentNumber` values into batches of 500 and issue `.in('student_number', batch)` reads (each returns ≤500 rows, well under the cap).
3. Line 778-786 (`alreadyImported`): page over `import_staging_rows` with `.order('id')` instead of `.limit(20000)` — this one must be exhaustive, it is the ONLY guard against re-posting an opening balance (no DB uniqueness exists on invoices per student).
4. Line 592-596 (`validateStudents` duplicate set): same pagination with `.order('id')`; consider also `.eq('status','active')`-style narrowing if withdrawn/graduated students should not raise DUP_EXISTING.

Optional hardening worth doing at the same time: add a partial unique index or a check in `app.import_commit_chunk` so a student cannot receive a second opening-balance invoice, since invoices are immutable and the only correction is a manual reversal. Also fix the same pattern at apps/api/src/library/library.controller.ts:107, which has the identical `.limit(10000)` truncation bug.

---

### 4. Students flagged as already existing are imported anyway — `decision='skip'` has no writer anywhere in the codebase

- **Location:** `apps/api/src/imports/imports.controller.ts:717`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** workers-outbox

**What is wrong.** `DUP_EXISTING` is deliberately excluded from the `hard` list, so a row matching an existing student becomes `validation_status='warning'`, and `import_staging_rows.decision` defaults to `'import'`. No API endpoint, web view, mobile screen, or migration ever sets `decision='skip'` (verified by grep across apps/ and supabase/), so `app.import_commit_chunk` — which selects `decision = 'import' and validation_status in ('valid','warning')` — creates a second student record for every flagged duplicate.

**How it fails.** A school imports its 2026 roster in January. In May it re-uploads a corrected spreadsheet containing the same 480 students plus 20 new ones. Validation flags 480 rows `DUP_EXISTING` / `warning` ('A student with this name + date of birth already exists') and the wizard shows them as warnings the user is invited to accept. The bursar clicks Approve. `import_commit_chunk` commits all 500 rows: 480 brand-new students are created with fresh `STU-00xxx` numbers, fresh guardian links (`is_primary = true` — migration 0011 line 221) and fresh class enrolments. The school now has every child twice; every child is invoiced twice by the next fee run, appears twice on the register and the debtors report, and `usage.students` doubles against the plan cap. There is no undo — the only cleanup is manual archival of 480 records plus reversal of 480 invoices.

**Evidence.**

```
apps/api/src/imports/imports.controller.ts:716-724 sets the flag but not a skip decision:
```ts
        } else if (existingKeys.has(dupKey)) {
          duplicate = 'existing';
          issues.push({
            field: 'name',
            code: 'DUP_EXISTING',
            message: 'A student with this name + date of birth already exists',
          });
        }
```
and lines 727-736 keep it out of the hard set (note `DUP_IN_FILE` is there, `DUP_EXISTING` is not):
```ts
      const hard = issues.some((i) =>
        [ 'NAME_REQUIRED', 'NAME_INCOMPLETE', 'GENDER_INVALID',
          'DOB_UNPARSEABLE', 'SECTION_UNMATCHED', 'DUP_IN_FILE',
        ].includes(i.code),
      );
```
The write-back at lines 343-353 persists `duplicate_status` but never `decision`. supabase/migrations/00000000000011_import_pipeline.sql:178-187 then commits it:
```sql
    select * from public.import_staging_rows
    where import_job_id = p_job_id
      and decision = 'import'
      and validation_status in ('valid','warning')
```
`grep -rn "decision" apps/api/src apps/web/src apps/mobile/src` returns only unrelated AI-confirm matches — nothing writes `import_staging_rows.decision`.
```

**Fix.** Minimal fix (one line, matches the codebase's own convention): in apps/api/src/imports/imports.controller.ts add 'DUP_EXISTING' to the hard-issue list at lines 727-736, so a row matching an existing student becomes validation_status='invalid' — exactly how validateOpeningBalances (lines 815-852) already treats ALREADY_IMPORTED. app.import_commit_chunk then skips it, the row appears in the downloadable error report, and the existing UI copy ("Invalid rows are skipped. Fix them in the source file and re-upload, or approve to import the valid rows now.") already describes the resulting behaviour, so no wizard change is needed to make the flow safe. Same-file companion fix, required for the above to protect real schools: validateStudents' existing-students query (~line 583) uses a bare .limit(10000), which PostgREST truncates at 1000 (see apps/workers/src/process-imports.ts:69-70) — replace it with a paginated .range() loop like loadStagingRows so schools over 1000 students actually get duplicates detected. Follow-up (the full feature, not required for the fix): add PUT /imports/:id/decisions writing import_staging_rows.decision ('import'|'skip') plus per-row checkboxes in imports-view.tsx, so a school can knowingly import a genuine same-name+same-DOB record. Do NOT add `and duplicate_status <> 'existing'` to import_commit_chunk's row selector as the primary fix — it would permanently foreclose that per-row decision path; the controller-side hard flag is the correct minimal change. Extend apps/api/scripts/smoke-imports.mjs (which today asserts only DUP_IN_FILE at lines 116-120) with a DUP_EXISTING case that asserts no second student row is created.

---

### 5. Spreadsheet upload is fully decompressed and parsed before any row/size cap — a 1.7 MB file freezes the whole API for 93 s

- **Location:** `apps/api/src/imports/imports.parser.ts:30`
- **Category:** dos-resource-exhaustion · **Verdict:** CONFIRMED (high) · **Found by:** input-validation

**What is wrong.** `parseImportFile` runs `XLSX.read` on the raw upload and only checks `MAX_ROWS` (5000) *after* the entire workbook has been decompressed and materialised, so a small, highly-compressible .xlsx expands to hundreds of MB of XML and blocks the single-threaded NestJS event loop for every tenant.

**How it fails.** A user with `imports.manage` (bursar / school_admin — the smallest paid role that can import) POSTs a crafted 1.68 MB .xlsx to `/api/v1/imports` (well under the 4 MB `MAX_FILE_BYTES` cap). I built exactly this file and ran the production parse options against the vendored `xlsx@0.20.3`: `XLSX.read` took **92.8 s of synchronous CPU** and pushed RSS to **2.5 GB**; a 0.84 MB variant took 28.8 s / 1.4 GB. During those 93 seconds the API answers nothing — a teacher saving a register, a cashier recording an M-Pesa payment, and every other school on the box all hang. `dataRows.length > MAX_ROWS` fires only afterwards (it reported 399,999 rows), so the cap never prevents the work. Repeating the upload a handful of times (only the global 300 req/min throttler applies) exceeds Node's default old-space and OOM-kills the API process.

**Evidence.**

```
apps/api/src/imports/imports.parser.ts:30-42
```ts
    workbook = XLSX.read(buffer, {
      type: 'buffer',
      raw: false, // formatted text — preserves leading zeros
      cellFormula: false,
      cellHTML: false,
      dense: true,
    });
```
apps/api/src/imports/imports.parser.ts:86-92 (the cap, applied only after the full parse)
```ts
  const dataRows = grid.slice(1);
  if (dataRows.length > MAX_ROWS) {
    throw new ImportParseError(
      'IMPORT_TOO_MANY_ROWS',
      `File has ${dataRows.length} rows; the limit is ${MAX_ROWS}. Split the file.`,
    );
```
apps/api/src/imports/imports.controller.ts:68,137,165 — the only pre-parse gate is the byte cap:
```ts
const MAX_FILE_BYTES = 4 * 1024 * 1024;
...
    FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }),
...
      sheet = parseImportFile(file.buffer, file.originalname);
```
Measured output of my repro (upload built from repeated `<c t="inlineStr"><is><t>A</t></is></c>`, deflate ratio 274:1):
```
UPLOAD SIZE: 1.68 MB (limit is 4 MB)  |  decompressed sheet XML: 460 MB
XLSX.read OK in 92.8 s   RSS 2502 MB
sheet_to_json rows 400000 in 0.6 s   RSS 2667 MB
MAX_ROWS check (5000) would only now reject: 399999
```
```

**Fix.** In imports.parser.ts, bound the work BEFORE XLSX.read decompresses: (1) Read the zip central directory to sum the uncompressed sizes of xl/worksheets/*.xml and xl/sharedStrings.xml (available without inflating) and throw ImportParseError('IMPORT_FILE_TOO_LARGE', ...) above a threshold (~25 MB) — this is the primary defense and the only one that stops the amplification, since sheetRows alone still streams the whole XML. (2) Pass sheetRows: MAX_ROWS + 2 to XLSX.read so SheetJS stops parsing past the cap (partial, combine with #1), and add an explicit grid[0].length column cap. (3) Move parseImportFile onto a worker_threads worker (or the existing imports worker) so a pathological file can never block the API event loop for other tenants. (4) Wrap the XLSX.utils.sheet_to_json call at parser.ts:60 in the same try/catch as XLSX.read so a RangeError surfaces as a typed IMPORT_FILE_UNREADABLE 400 instead of an untyped 500. Additionally, add a per-route @Throttle to the imports upload endpoint (controller.ts:134) to limit repeated abuse beyond the global 300/min.

---

### 6. A student can never leave: `students.status` is never written, so leavers hold a paid plan seat, keep being invoiced, keep getting absence SMS and stay visible in the parent portal

- **Location:** `apps/api/src/students/students.controller.ts:71`
- **Category:** missing-lifecycle · **Verdict:** CONFIRMED (high) · **Found by:** gap:student-enrolment-lifecycle (zero findings; entire feature absent)

**What is wrong.** `students.status` allows `transferred/withdrawn/graduated/archived` (0004:19-20) but no code path in the repo ever updates the `students` table — `grep -rn '\.update(' apps/api/src` returns zero hits on `students`, and there is no PATCH/DELETE route anywhere. Every seat-cap, billing, SMS and portal query keys off `status = 'active'`, so a departed pupil is indistinguishable from an enrolled one, forever.

**How it fails.** A school on the 300-seat Standard plan (`'{"students": 300, ...}'`, 0013:17) has 300 pupils. In March, 25 Form 4 leavers transfer to another school. There is no endpoint or button to mark them transferred, so `app.tenant_entitlements` still returns `usage.students = 300` (0013:108-109, `count(*) ... where status = 'active'`). Three concrete outcomes: (1) `assertStudentCapacity` throws `403 PLAN_LIMIT_STUDENTS` on every new admission — the registrar cannot admit a single replacement pupil until the school buys a bigger plan for children who left; (2) `POST /finance/reminders` → `app.queue_fee_reminders` joins `public.students s on s.id = u.student_id and s.status = 'active'` (0009:203), so the 25 ex-pupils' guardians keep receiving "unpaid fees" SMS for the rest of the year; (3) `/portal/children` keeps serving each leaver's balance and attendance to their guardian because the only status gate is `student.status !== 'active'` (parents.controller.ts:127), which never becomes true.

**Evidence.**

```
apps/api/src/students/students.controller.ts:70-79
  /** Plan cap (mig 0013): active students + incoming rows must fit the plan. */
  private assertStudentCapacity(req: TenantRequest, adding: number) {
    const { limits, usage, planKey } = req.tenant.entitlements;
    if (limits.students !== null && usage.students + adding > limits.students) {
      throw new ForbiddenException({ code: 'PLAN_LIMIT_STUDENTS', ... });

supabase/migrations/00000000000013_platform.sql:108
      'students', (select count(*) from public.students
                   where tenant_id = p_tenant_id and status = 'active'),

supabase/migrations/00000000000004_students_guardians_invitations.sql:19-20
  status text not null default 'active'
    check (status in ('active','transferred','withdrawn','graduated','archived')),

apps/api/src/parents/parents.controller.ts:127
      if (!student || student.status !== 'active') continue;
```

**Fix.** Minimal fix — add the missing writer, DB-side, plus the two dependent status columns:

1. New migration `supabase/migrations/00000000000029_student_lifecycle.sql` (additive): `create or replace function app.set_student_status(p_tenant_id uuid, p_actor uuid, p_student_id uuid, p_status text, p_reason text)` that (a) validates `p_status in ('active','transferred','withdrawn','graduated','archived')` and that the student row's `tenant_id = p_tenant_id` (raise `STUDENT_NOT_FOUND` otherwise), (b) `update public.students set status = p_status where id = p_student_id and tenant_id = p_tenant_id`, (c) when the new status is not 'active', `update public.class_enrolments set status = 'left' where student_id = p_student_id and tenant_id = p_tenant_id and status = 'active'` (uses the existing `'left'` value from 0004:67 — no constraint change needed), and when it returns to 'active' leave enrolments alone (re-enrolment is a separate flow), (d) insert an `audit_logs` row with the reason. Add the service-role-only `public.set_student_status` wrapper with explicit `revoke all … from public, anon, authenticated; grant execute … to service_role`, per the house rule that PostgREST only sees `public`.

2. `apps/api/src/students/students.controller.ts`: add `@Patch(':id/status')` with `@RequirePermission('students.archive')` (already seeded, currently unused) and a zod `safeParse` on `{ status: z.enum([...]), reason: z.string().max(500).optional() }` returning `{ code: 'STUDENT_STATUS_INVALID', issues }` on failure; call `supabase.admin.rpc('set_student_status', {...})` and map `STUDENT_NOT_FOUND` to a 400 with that stable code. Import `Patch` and `Param` from `@nestjs/common`.

3. `apps/web/src/app/students/students-view.tsx`: turn the read-only status `<Badge>` at line 302 into a row action that PATCHes the new endpoint; add EN+SW keys in `packages/i18n/src/index.ts` (mirrored key sets), not in `apps/web/src/i18n/index.ts`.

4. Add `apps/api/scripts/smoke-students.mjs` assertions: after PATCH to 'transferred', assert `students.status`, `class_enrolments.status = 'left'`, that `tenant_entitlements.usage.students` dropped by one, and that `queue_fee_reminders` no longer emits for that student.

Do NOT implement the finder's proposed `withdrawStudent` propose→confirm AI action: `apps/api/src/ai/ai-actions.service.ts:15` documents "HARD-BLOCKED (never in this catalogue): deleting/archiving students" — adding it would violate an explicit, intentional design decision.

---

### 7. Tenant membership grants school-wide RLS reads, so /finance, /accounting and /parents leak all money and guardian PII to permission-less staff

- **Location:** `apps/web/src/app/finance/page.tsx:20`
- **Category:** authorization · **Verdict:** CONFIRMED (high) · **Found by:** web-security

**What is wrong.** Server pages read invoices, payments, journal_entries and guardians straight through RLS whose only predicate is `app.is_tenant_member(tenant_id)`. No page checks a view permission, and the API's finance.invoices.view / finance.reports.view / guardians.view keys are never consulted on this path. Every active member of a school — including the `teacher` role, which the seed grants no finance or guardian permissions — can load the school's entire fee ledger, receipts, general journal and every guardian's phone and email.

**How it fails.** Chief Sarwatt School invites a maths teacher; accept_invitation gives them tenant_memberships.status='active' with role `teacher` (supabase/seed.sql:75-78 → students.view, attendance.*, marks.enter, timetable.view, hostel.view, transport.view, library.view, clinic.view — no finance.*, no guardians.view). The teacher clicks /finance in the sidebar (apps/web/src/components/app-shared.tsx:66 shows it to everyone): the page renders 200 invoices with every family's name, total and amount paid. /accounting renders the last 20 journal entries with debit/credit lines. /parents renders 50 guardians per page with full_name, phone and email and a server-side search box over all of them. The same rows are also reachable outside the UI with the public anon key: `GET {SUPABASE_URL}/rest/v1/payments?select=*` with the teacher's access token returns every payment row for the tenant.

**Evidence.**

```
apps/web/src/app/finance/page.tsx:15-20 — the only gate is a session check:
  export default async function FinancePage() {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) redirect("/login");
apps/web/src/app/finance/page.tsx:50-63 then reads `.from("invoices")` and `.from("payments")` with only `.eq("tenant_id", tenantId)`.

apps/web/src/app/accounting/page.tsx:20,34 — `if (!user) redirect("/login");` … `.from("journal_entries")`
apps/web/src/app/parents/page.tsx:28-35 — `.from("guardians").select(\`id, full_name, phone, email, occupation, user_id, …\`).eq("tenant_id", tenant.id)`

supabase/migrations/00000000000007_finance.sql:147-157
  create policy "members read invoices" on public.invoices for select using (app.is_tenant_member(tenant_id));
  create policy "members read payments" on public.payments for select using (app.is_tenant_member(tenant_id));
  create policy "members read journal entries" on public.journal_entries for select using (app.is_tenant_member(tenant_id));

supabase/migrations/00000000000009_parents.sql:3-5 already acknowledges the semantics: "Parents deliberately do NOT become tenant members: membership grants school-wide RLS reads, which is wrong for a parent." The same reasoning applies to low-privilege staff.
```

**Fix.** Fix at the DB layer first — page-level checks alone leave the PostgREST vector open (the anon key is public and the user's JWT is in their own cookies).

1) New migration supabase/migrations/00000000000029_permission_aware_rls.sql:
   - Add `app.has_permission(target_tenant uuid, p_key text) returns boolean, language sql, stable, security definer, set search_path = public`, defined as: active membership in target_tenant AND (the membership holds a role in ('school_owner','director') — mirroring SUPER_ROLES in apps/api/src/tenancy/tenant.guard.ts:54 — OR exists a join tenant_memberships -> membership_roles -> role_permissions where role_permissions.permission_key = p_key). Grant execute to authenticated; keep it in the `app` schema so PostgREST cannot call it directly.
   - Follow the 0027:220-236 house pattern (`drop policy if exists ...` then `create policy ...`) to replace the SELECT policies:
     * public.invoices, public.invoice_lines, public.payments, public.fee_items -> `using (app.has_permission(tenant_id, 'finance.invoices.view'))`
     * public.journal_entries, public.ledger_accounts -> `using (app.has_permission(tenant_id, 'finance.reports.view'))`
     * public.journal_lines -> same key, via `exists (select 1 from public.journal_entries je where je.id = journal_lines.entry_id and app.has_permission(je.tenant_id, 'finance.reports.view'))` (journal_lines is keyed by entry_id, not tenant_id)
     * public.guardians -> `using (app.has_permission(tenant_id, 'guardians.view'))`, and rewrite "members read student guardians" (0004:93-99) to use the same key against the parent student's tenant_id. Keep the existing parent self-read policy from 0009 intact so /portal routing still works.

2) apps/web: after the RLS change these pages would silently render empty for a teacher, which is a worse UX than a refusal. In apps/web/src/app/finance/page.tsx, accounting/page.tsx, parents/page.tsx and the finance blocks of app/page.tsx (lines 83-102), load the caller's permission set server-side (reuse the same membership_roles -> role_permissions read, or expose a small API endpoint) and `redirect("/")` — or render a "no access" card — when the required key is absent; skip the finance tiles on the dashboard rather than failing the whole page.

3) apps/web/src/components/app-shared.tsx buildNavGroups (:66-73): filter the money and community groups by the caller's permissions, removing the stale "once subscriptions are wired" comment at :42.

4) Mirror the same permission-aware reads in apps/mobile ((tabs)/finance.tsx, (tabs)/dashboard.tsx, finance/[id].tsx, students/[id].tsx), which hit the same RLS tables and will otherwise start returning empty lists.

5) Extend apps/api/scripts/smoke-isolation.mjs with a vertical case: create a teacher-role member, assert their own Supabase session returns 0 rows from invoices, payments, journal_entries and guardians in their OWN tenant, and that a bursar still reads them.

Note: migrations 0016-0028 are not yet applied to the live dev DB, so this new migration should be appended to the same pending batch rather than applied ahead of it.

---

### 8. Invoice creation silently drops every student past the 500th — a >500-student school cannot bill the alphabetically-later families

- **Location:** `apps/web/src/app/finance/page.tsx:76`
- **Category:** data-truncation · **Verdict:** CONFIRMED (high) · **Found by:** web-correctness

**What is wrong.** The "New invoice" student picker is a plain <select> populated from a server read hard-capped at 500 rows ordered by last_name, with no search and no indication that the list is truncated.

**How it fails.** A secondary school with 620 active students (routine in Tanzania). The bursar opens Fees & Payments → New invoice and types/scrolls looking for "Yusuph Zakaria". Because the server fetched only `.order("last_name").limit(500)`, students from roughly surname "S" onward are absent from the <option> list entirely. There is no search box, no "showing 500 of 620", no error. The bursar concludes the student "isn't in the system" and either re-admits a duplicate or bills the family off-system. Those ~120 families are unbillable from the web UI.

**Evidence.**

```
apps/web/src/app/finance/page.tsx:70-76
```
			supabase
				.from("students")
				.select("id, first_name, last_name, student_number")
				.eq("tenant_id", tenantId)
				.eq("status", "active")
				.order("last_name")
				.limit(500),
```
Rendered as a bare select with no search — apps/web/src/app/finance/finance-view.tsx:388-393:
```
							<option value="">{t("finance.student")} —</option>
							{students.map((s) => (
								<option key={s.id} value={s.id}>
									{s.label}
								</option>
							))}
```
The same silent-truncation pattern (at 1000) exists in reports/page.tsx:32, library/page.tsx:32, hostel/page.tsx:32, transport/page.tsx:32 and clinic/page.tsx:32 — note that students/page.tsx and finance's payments read DO paginate correctly (`fetchAllRows`, `.range()`), so the omission here is inconsistent, not deliberate.
```

**Fix.** Fix in the UI layer (two files):

1. /Users/admin/Atlas-System/apps/web/src/app/finance/finance-view.tsx — in `CreateInvoiceDialog` (lines 297-394), replace the bare `<select>` student picker with a debounced type-ahead that queries the server on each keystroke, copying the pattern already proven in /Users/admin/Atlas-System/apps/web/src/app/students/students-view.tsx:186-200: create a browser supabase client, `.from("students").select("id, first_name, last_name, student_number", { count: "exact" }).eq("tenant_id", tenantId).eq("status","active").or(\`first_name.ilike.%${q}%,middle_name.ilike.%${q}%,last_name.ilike.%${q}%,student_number.ilike.%${q}%\`).order("last_name").range(0, 19)`, with `sanitizeSearch` on the query, 300ms debounce, and set `studentId` from the chosen row. Keep the server-provided `students` prop only as the initial/unsearched list.

2. /Users/admin/Atlas-System/apps/web/src/app/finance/page.tsx:70-76 — keep the read but make the truncation explicit rather than silent: request `{ count: "exact" }` and pass the true active-student count to FinanceView so the dialog can render "showing N of M — type to search". Do not simply swap `.limit(500)` for `fetchAllRows`: a `<select>` with thousands of `<option>`s is unusable and PostgREST still caps at 1000 per page.

Same treatment is needed (lower priority, same defect class) for the 1000-row student props in reports/page.tsx:32, library/page.tsx:32, hostel/page.tsx:32, transport/page.tsx:32 and clinic/page.tsx:32, whose dialogs filter the capped array client-side; library/page.tsx's students read additionally lacks an explicit `.eq("tenant_id", tenantId)` filter and should get one.

---

### 9. No way to create a second academic year, term, grade level or class section — ATLAS cannot roll into a second school year

- **Location:** `supabase/migrations/00000000000002_academics_onboarding.sql:190`
- **Category:** missing-lifecycle · **Verdict:** CONFIRMED (high) · **Found by:** gap:student-enrolment-lifecycle (zero findings; entire feature absent)

**What is wrong.** `academic_years`, `academic_terms`, `grade_levels` and `class_sections` are written in exactly one place in the whole codebase — inside `app.onboard_school`, which runs once per tenant. No controller, RPC, AI action or migration ever inserts into them again, so a school is permanently frozen in the single year it typed into the onboarding wizard.

**How it fails.** Chief Sarwatt School onboards in Jan 2026 with academic year "2026" (Term 1/2/3) and sections Form 1 A…Form 4 B. In January 2027 the bursar wants to open the 2027 year. `grep -n 'insert into public.\(academic_years\|academic_terms\|grade_levels\|class_sections\)' supabase/migrations/*.sql` returns only lines 190, 202, 214 and 225 of migration 0002 (inside `app.onboard_school`), and `grep -rn 'RequirePermission(' apps/api/src` shows no endpoint that creates them — `academics.manage` is only used for subjects/combinations. Consequences, all reachable the same week: (a) `app.create_invoice` resolves `v_year_id` via `where tenant_id = p_tenant_id and status = 'active' order by starts_on desc limit 1` (0007:272-274), so every 2027 invoice is stamped `academic_year_id` = 2026; (b) `POST /finance/fee-items` re-creating "Ada ya Muhula 1" at the 2027 price hits `unique (tenant_id, academic_year_id, name)` (0007:26) and returns `FEE_ITEM_DUPLICATE_NAME` (finance.controller.ts:100-102) — the school literally cannot raise tuition; (c) pupils cannot be enrolled for 2027 because `class_enrolments` has `unique (student_id, academic_year_id)` (0004:70) and their 2026 row already occupies it. The product is unusable from day 366.

**Evidence.**

```
supabase/migrations/00000000000002_academics_onboarding.sql:190
  insert into public.academic_years (tenant_id, name, starts_on, ends_on)
  values (
    v_tenant_id,
    p_payload->'academicYear'->>'name',
...
:225
      insert into public.class_sections (tenant_id, campus_id, academic_year_id, grade_level_id, name)
      values (v_tenant_id, v_campus_id, v_year_id, v_grade_id, v_stream);

-- and the only consumer, which assumes exactly one 'active' year forever:
apps/api/src/students/students.controller.ts:41-48
        this.supabase.admin
          .from('academic_years')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('status', 'active')
          .order('starts_on', { ascending: false })
          .limit(1)
```

**Fix.** Downgraded from critical to high: no data loss, security hole or live outage — it is a missing lifecycle that hard-blocks at a known future date, and part (b) has a rename workaround. The present-day defect (no enrolment UPDATE at all) is what makes it more than a roadmap item.

Minimal concrete fix:
1. New migration `supabase/migrations/00000000000029_year_rollover.sql`:
   - `app.create_academic_year(p_tenant_id, p_actor, p_payload jsonb)` — inserts `academic_years` + `academic_terms` (sequence 1..n), plus a service-role-only `public.create_academic_year` wrapper with explicit `revoke ... from public, anon, authenticated`.
   - `app.rollover_academic_year(p_tenant_id, p_actor, p_from_year_id, p_to_year_id)` — clones `class_sections` (campus_id, grade_level_id, name, capacity) into the new year; sets the old year `status='closed'` and its `class_enrolments` to `status='completed'`; inserts new `class_enrolments` rows pointing at the next `grade_levels.sequence` section (leavers at the top sequence stay `completed`). Note: `grade_levels` has NO `academic_year_id` and is `unique (tenant_id, name)` — do NOT clone it, contrary to the finder's proposal; only years, terms and sections need creating.
   - `app.add_class_section(...)` for new streams mid-year.
2. New `apps/api/src/academics/academics-admin.controller.ts` (copy the `finance.controller.ts` house pattern): `POST /academics/years`, `POST /academics/years/:id/rollover`, `POST /academics/sections`, `PATCH /academics/years/:id/status`, all `@UseGuards(AuthGuard, TenantGuard)` + `@RequirePermission('academics.manage')` (key already exists — used at academics.controller.ts:342) + zod `safeParse`, business errors as stable-code 400s.
3. Add `PATCH /students/:id/enrolment` (transfer between sections inside one year) backed by an `update public.class_enrolments set class_section_id = ...` RPC — today there is no update path at all, which is the bug that bites before Jan 2027.
4. Let the bursar target a year explicitly: add optional `academicYearId` to `createFeeItemSchema` / `createInvoiceSchema` (finance.schema.ts) and use it at finance.controller.ts:53-62 instead of the unconditional "newest active year"; when omitted and more than one active year exists, 400 with `AMBIGUOUS_ACTIVE_YEAR` rather than silently binding to the newest. Same explicit-error treatment at students.controller.ts:41-48 and ai-actions.service.ts:361-367.
5. Ship the matching AI catalogue entries per the iron rule (read tool for years/sections in `ai-tools.service.ts`, a proposable `rollover_academic_year` action in `ai-actions.service.ts`), EN+SW strings in `packages/i18n/src/index.ts`, and `apps/api/scripts/smoke-academics-rollover.mjs`.

---

### 10. A mis-assigned class can never be corrected — `unique (student_id, academic_year_id)` blocks a second enrolment and no UPDATE path exists

- **Location:** `supabase/migrations/00000000000004_students_guardians_invitations.sql:70`
- **Category:** missing-lifecycle · **Verdict:** CONFIRMED (high) · **Found by:** gap:student-enrolment-lifecycle (zero findings; entire feature absent)

**What is wrong.** Once a `class_enrolments` row exists, the unique constraint on `(student_id, academic_year_id)` prevents inserting a corrected one, and nothing in the API, the RPCs or the AI action catalogue (`AI_ACTIONS`, ai-actions.service.ts:776-2220) ever issues an UPDATE or DELETE against the table. A class assignment is therefore write-once and permanent for the life of the academic year.

**How it fails.** During the bulk import, Juma Hassan is put in "Form 1 A" when he actually belongs to "Form 1 B" (a mistyped stream column — `class_sections.name` holds the stream label, so "A"/"B" is a single-character typo). For the whole year: Form 1 B's class teacher opens `/attendance?section=<FormB>` and Juma is not on the register (page.tsx:68-73 filters `class_enrolments.class_section_id`), so he is never marked present or absent; the Form 1 B subject teacher entering marks gets `SCORES_STUDENT_NOT_ENROLLED` from `app.record_scores` (0006:198-208) and cannot save; and his report card prints "Form 1 A" because `app.report_card` derives the class from the enrolment row (0006:300-311). The admin has no PATCH endpoint, no UI control and no AI action to move him — the only fix is manual SQL on the live database.

**Evidence.**

```
supabase/migrations/00000000000004_students_guardians_invitations.sql:61-70
create table public.class_enrolments (
  ...
  status text not null default 'active' check (status in ('active','completed','left')),
  enrolled_on date not null default current_date,
  created_at timestamptz not null default now(),
  unique (student_id, academic_year_id)
);

supabase/migrations/00000000000006_assessments.sql:198-208
  select (r->>'studentId')::uuid into v_bad
  from jsonb_array_elements(p_rows) r
  where not exists (
    select 1 from public.class_enrolments e
    where e.student_id = (r->>'studentId')::uuid
      and e.class_section_id = v_assessment.class_section_id
      ...
  if v_bad is not null then
    raise exception 'SCORES_STUDENT_NOT_ENROLLED:%', v_bad;
```

**Fix.** Minimal fix, following house patterns. (a) New migration `supabase/migrations/00000000000029_enrolment_transfer.sql`: `app.transfer_enrolment(p_tenant_id uuid, p_actor uuid, p_student_id uuid, p_class_section_id uuid)` — security definer, `set search_path = public` — that (i) verifies the target section belongs to p_tenant_id (raise `TRANSFER_SECTION_NOT_FOUND`, the AUD-001 discipline used in 0010:74-79/0011:224-230), (ii) locates the student's active row for the current academic year (raise `TRANSFER_NOT_ENROLLED` if none, `TRANSFER_SAME_SECTION` if unchanged), (iii) **UPDATEs `class_section_id` in place** rather than inserting a second row — the unique key is unconditional, so the finder's "mark 'left' + insert" would fail with 23505; if a history trail is wanted, either add a `class_enrolment_moves` audit table in the same migration or replace the table constraint with a partial index `create unique index … on public.class_enrolments (student_id, academic_year_id) where status = 'active'` (a sanctioned constraint change like 0025's, and required before any 'left'+insert design), (iv) writes an `audit_logs` row (`'students.transferred'`, before/after section ids). Add the `public.transfer_enrolment` wrapper with `revoke execute … from public, anon, authenticated; grant execute … to service_role;` (pattern at 0005:200-202). (b) `apps/api/src/students/students.controller.ts`: `@Post(':id/enrolment')` with `@RequirePermission('students.update')` — the key is already seeded (seed.sql:7) and granted (0005:219,225), so no new permission row/FK is needed — zod `safeParse` on `{ classSectionId: z.string().uuid() }`, mapping the raise-strings to `{ code: 'TRANSFER_SECTION_NOT_FOUND' | 'TRANSFER_NOT_ENROLLED' | 'TRANSFER_SAME_SECTION' }` 400s. (c) Per the iron rule that every write flow ships a proposable action, add a `transferStudent` entry to `AI_ACTIONS` in `apps/api/src/ai/ai-actions.service.ts` (permission `students.update`, args `{ studentNumber, className, stream }`, preview reusing `resolveSection`, execute calling the new RPC), and a "Move class" control in `apps/web/src/app/students/students-view.tsx` with EN+SW error keys in `packages/i18n/src/index.ts`. (d) Add a `smoke-students` assertion that a transferred student disappears from the old section's roster and can be marked/scored in the new one.

---

### 11. A student created without a class can never be given one — no assign/transfer path exists for `class_enrolments`

- **Location:** `supabase/migrations/00000000000010_audit_hardening.sql:73`
- **Category:** missing-lifecycle · **Verdict:** CONFIRMED (high) · **Found by:** gap:student-enrolment-lifecycle (zero findings; entire feature absent)

**What is wrong.** `app.import_students` inserts a `class_enrolments` row only when the caller supplies `classSectionId`; the class picker in the Add-Student dialog defaults to blank and `className` is optional in the bulk-import schema. `class_enrolments` is only ever INSERTed (0004:175, 0009:152, 0010:81, 0011:236) and never UPDATEd or DELETEd anywhere, so a student who lands without an enrolment is permanently invisible to every roster-driven feature.

**How it fails.** A registrar uploads a 400-row spreadsheet whose class column is blank (or titled something the resolver does not match, so they clear it to get past the `Unknown class` validation at students.controller.ts:146-152). All 400 students are created with zero `class_enrolments` rows. From then on: they never appear on any attendance register (`apps/web/src/app/attendance/page.tsx:68-73` selects from `class_enrolments` by `class_section_id`), a teacher who tries to enter their marks gets `SCORES_STUDENT_NOT_ENROLLED` (0006:198-208), and `app.report_card` raises `REPORT_STUDENT_NOT_ENROLLED` (0006:311) so no report card can ever be printed for them. The `/admissions` page shows them in a read-only "No class assigned" tally (admissions-view.tsx:178-181) with no button to fix it. The only remedy is hand-written SQL against production.

**Evidence.**

```
supabase/migrations/00000000000010_audit_hardening.sql:73-84
    if nullif(v_row->>'classSectionId','') is not null then
      ...
      insert into public.class_enrolments
        (tenant_id, student_id, class_section_id, academic_year_id)
      values (p_tenant_id, v_student_id, v_section, p_year_id);
    end if;

apps/web/src/app/students/students-view.tsx:540-546  (class picker defaults to blank)
					<select ... onChange={(e) => set("classSectionId", e.target.value)} value={form.classSectionId}>
						<option value="">{t("students.class")} —</option>

apps/web/src/app/admissions/admissions-view.tsx:178-181  (surfaced, no action)
								{unassigned > 0 && (
									<div className="flex items-center justify-between py-1.5 text-sm text-muted-foreground">
										<span>{t("admissions.unassigned")}</span>
```

**Fix.** Add the missing write path, additively. (1) New migration `supabase/migrations/00000000000029_class_enrolment_assign.sql`: `app.set_class_enrolment(p_tenant_id uuid, p_actor uuid, p_student_id uuid, p_section_id uuid, p_year_id uuid default null)` — security definer, verifies the student AND the section both belong to `p_tenant_id` (raise `ENROLMENT_STUDENT_NOT_FOUND` / `ENROLMENT_SECTION_NOT_FOUND`), defaults `p_year_id` to the active `academic_years` row (raise `ENROLMENT_NO_ACTIVE_YEAR` if none), then `insert into public.class_enrolments (tenant_id, student_id, class_section_id, academic_year_id) values (...) on conflict (student_id, academic_year_id) do update set class_section_id = excluded.class_section_id, status = 'active'`, and writes an `audit_logs` row (`students.enrolment_set`, before/after section). Add the service-role-only `public.set_class_enrolment` wrapper with explicit `revoke ... from public, anon, authenticated; grant ... to service_role`, following the 0011/0019 wrapper pattern. Keep RLS on `class_enrolments` select-only — the write stays API-side. (2) `apps/api/src/students/students.controller.ts`: add `@Post(':id/enrolment') @RequirePermission('students.update')` with a zod `safeParse` on `{ classSectionId: z.string().uuid(), academicYearId: z.string().uuid().optional() }`, calling the RPC and mapping the raised codes to `{ code: 'ENROLMENT_...' }` 400s (copy the error-mapping shape from `runImport`). This finally gives the seeded `students.update` permission a consumer. (3) `apps/web/src/app/students/students-view.tsx`: add an "Assign class" row action opening a section picker that POSTs to the new endpoint, and make the Add-Student `<select>` at line 540 required (drop the blank option, or keep it but block submit) so the default path can no longer create an unassigned student. (4) `apps/web/src/app/admissions/admissions-view.tsx:178-181`: make the unassigned tile a link to `/students?unassigned=1` filtered to students with no `class_enrolments` row. (5) Per the iron rule that every module ships proposable write actions, add an `assignClass` entry to `ACTIONS` in `apps/api/src/ai/ai-actions.service.ts` (permission `students.update`, args `{ studentNumber, className, stream? }`, reusing `resolveSection`, preview warning when it replaces an existing section) so the same fix is reachable from Ask ATLAS. (6) Add EN+SW keys in `packages/i18n/src/index.ts` for the new strings, and extend `apps/api/scripts/smoke-students.mjs` to create a student with no class, assert zero enrolments, call the new endpoint, and assert the row exists and that a re-call transfers rather than duplicates.

---


## MEDIUM (41)

### 12. sendAnnouncement preview counts students, not guardian phones — the confirm card understates the SMS bill it authorises

- **Location:** `apps/api/src/ai/ai-actions.service.ts:1299`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** ai-security

**What is wrong.** For a class audience the preview counts rows in class_enrolments (one per STUDENT) and labels it "Estimated recipients ~N (deduped by phone)", while app.queue_announcement actually queues one outbox row per DISTINCT GUARDIAN PHONE of every actively-enrolled student in that section.

**How it fails.** A bursar asks the assistant to SMS Form 4 A about fee deadlines. The section has 40 active enrolments and most students have both a mother and a father recorded as guardians with phones. The confirm card reads "Estimated recipients ~40 (deduped by phone)" and "Sending SMS costs money and cannot be recalled." The bursar confirms. queue_announcement's `select distinct on (g.phone) … join student_guardians … join students … where exists (class_enrolments … status='active')` queues ~75 messages, nearly double the quoted figure — real money spent and the tenant's smsMonthly allowance consumed on a number the operator never agreed to. The whole-school branch is wrong in the opposite direction: it counts every guardians row with a phone, including guardians of archived/inactive students, whom the RPC excludes via `s.status = 'active'`.

**Evidence.**

```
const { count } = await supabase.admin
          .from('class_enrolments')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', ctx.tenantId)
          .eq('class_section_id', section.id)
          .eq('status', 'active');
        recipientEstimate = count ?? 0;
…
['Estimated recipients', `~${recipientEstimate} (deduped by phone)`],
```

**Fix.** Make the preview count come from the same SQL as the send. Add an additive migration (e.g. `supabase/migrations/00000000000029_announcement_recipient_count.sql`) with `app.count_announcement_recipients(p_tenant_id uuid, p_audience_type text, p_class_section_id uuid) returns int`, whose body is exactly the `select count(*) from (select distinct on (g.phone) g.phone from public.guardians g join public.student_guardians sg on sg.guardian_id = g.id join public.students s on s.id = sg.student_id and s.status = 'active' where g.tenant_id = p_tenant_id and g.phone is not null and (p_audience_type = 'all_guardians' or exists (select 1 from public.class_enrolments e where e.student_id = s.id and e.class_section_id = p_class_section_id and e.status = 'active')) order by g.phone) r` — i.e. the identical predicate block from `app.queue_announcement`. Add the service-role-only `public.count_announcement_recipients` wrapper with `revoke execute … from public, anon, authenticated; grant execute … to service_role;` per the house rule.

Then in `apps/api/src/ai/ai-actions.service.ts`, replace the whole 1291-1313 if/else with a single call:
```ts
const { data: est, error } = await supabase.admin.rpc('count_announcement_recipients', {
  p_tenant_id: ctx.tenantId,
  p_audience_type: sectionId ? 'class_section' : 'all_guardians',
  p_class_section_id: sectionId,
});
if (error) rpcThrow(error);
recipientEstimate = (est as number) ?? 0;
```
(resolve `section`/`sectionId` first, as the existing code does, to keep the `scope` label). Keep the "deduped by phone" wording only once it is true — it then is. Optionally add a warning when the count is 0 ("no guardians with phones — sending will be rejected") so the operator is not asked to confirm a send that will throw ANNOUNCEMENT_NO_RECIPIENTS.

---

### 13. Student health records, names, dates of birth and guardian phone numbers are POSTed verbatim to Moonshot with no redaction or data-processing boundary

- **Location:** `apps/api/src/ai/ai-provider.ts:65`
- **Category:** privacy · **Verdict:** CONFIRMED (medium) · **Found by:** ai-security

**What is wrong.** Every tool result is JSON.stringify'd straight into the provider message array and sent to api.moonshot.ai; getClinicVisits returns named minors' symptoms and treatment, getStudentProfile returns dates of birth plus guardian names and phones, and getDebtors returns guardian phone numbers. There is no redaction, pseudonymisation, opt-out flag or configuration switch anywhere in the AI module.

**How it fails.** A school nurse holding clinic.view asks "Show me clinic visits this month". getClinicVisits (ai-tools.service.ts:1226-1257) returns up to 500 rows of `{student: "Neema Mushi (STU-00042)", symptoms: "…", treatment: "…"}`. ai.controller.ts:264 does `const content = JSON.stringify(toolResult)` and pushes it as a tool message; MoonshotProvider.chat then POSTs the whole array to https://api.moonshot.ai/v1/chat/completions. Named health data about identified minors — sensitive personal data under Tanzania's Personal Data Protection Act 2022 — is transferred to a third-country processor the school has no contract with and no notice of. Migration 0027 went to the trouble of dropping clinic_visits' member-read RLS policy because "health data is the most sensitive PII we hold", yet the same rows leave the country through the assistant.

**Evidence.**

```
response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.MOONSHOT_API_KEY ?? ''}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,   // ← contains raw clinic symptoms, DOBs, guardian phones
```

**Fix.** Keep the assistant's architecture; strip the fields that are not load-bearing for any documented use case.

1. `apps/api/src/ai/ai-tools.service.ts:1239-1252` (`getClinicVisits`) — stop emitting identified free-text health data. In the `.map()`, replace `student: "First Last (STU-…)"` with `student: student?.student_number` only, drop `treatment` entirely, and reduce `symptoms` to a non-free-text signal (e.g. a fixed `category` column if one is added, otherwise omit it and return per-day/per-class visit counts plus the student numbers). Update the description at lines 1218-1219 to match ("visit counts and student numbers; symptoms and treatment are not available to the assistant"), mirroring the `getPayrollSummary` precedent at line 1265. Staff who need the clinical detail already have the permission-gated `/clinic` screen.

2. `apps/api/src/ai/ai-tools.service.ts:717` (`getStudentProfile`) — delete the `dateOfBirth` field from the returned object (and `date_of_birth` from the `.select()` at line 691). Nothing in the tool catalogue or the system prompt needs it.

3. `apps/api/src/ai/ai-tools.service.ts:723-734` and `:319` — drop `phone` from the `guardians[]` map in `getStudentProfile` and `guardianPhone` from `getDebtors`' `topOverdue` rows. `proposeSendFeeReminders` (ai-actions.service.ts:1523) resolves the primary guardian server-side, so the model never needs a number. Leave `searchGuardians`' phone in place — that tool's stated purpose is phone lookup, so removing it breaks the tool.

4. Add the per-tenant kill switch that the entitlement document already carries but nothing reads: in `apps/api/src/ai/ai.controller.ts` `chat()`, before the quota gate at line 121, `if (req.tenant.entitlements.features.ai === false) throw new ForbiddenException({ code: 'AI_DISABLED' })`. That gives a school a real opt-out via `tenant_features` without a migration.

5. `docs/ADMIN_GUIDE.md` Part IV (line 335 onward) — add a short "what leaves the school" paragraph naming Moonshot as the model provider, listing the field classes that are sent (student names, class, fee balances, attendance), and stating explicitly that clinical detail, payroll detail and dates of birth are not. Without this the operator cannot obtain informed consent under PDPA 2022.

---

### 14. getClinicVisits reports the notify REQUEST flag as "guardian was notified", so the assistant states parents were told when no SMS was ever queued

- **Location:** `apps/api/src/ai/ai-tools.service.ts:1250`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** ai-security

**What is wrong.** clinic_visits.notify_guardian records that notification was ASKED FOR; app.record_clinic_visit only queues an outbox row when the student has a primary guardian with a phone, and explicitly returns notified=false otherwise. The tool maps the request flag straight to a field described as "whether the guardian was notified by SMS".

**How it fails.** A nurse records visits for six children with notify=true. Two of them have no primary guardian with a phone, so migration 0023's `join public.student_guardians sg on sg.student_id = s.id and sg.is_primary join public.guardians g on g.id = sg.guardian_id and g.phone is not null` inserts nothing for them and the RPC returns notified=false. Later the head teacher asks the assistant "Which parents were told their child came to the clinic today?". getClinicVisits returns guardianNotified:true for all six, and the model — which is instructed to answer only from tool results — tells the head teacher every parent was informed. Two families were never contacted about their sick child, and nobody follows up. Delivery failures in notification_outbox are invisible here too.

**Evidence.**

```
treatment: (v.treatment as string | null) ?? null,
          guardianNotified: v.notify_guardian as boolean,
// migration 0023: "Returns whether an SMS was actually queued (a notify request
// for a student without a reachable guardian records the visit but returns notified=false)."
```

**Fix.** Minimal (stops the false claim, no extra queries) — in /Users/admin/Atlas-System/apps/api/src/ai/ai-tools.service.ts, `getClinicVisits`:
- line 1250: `guardianNotified: v.notify_guardian as boolean` → `notifyRequested: v.notify_guardian as boolean`
- lines 1218-1219 description: replace "and whether the guardian was notified by SMS" with "and whether guardian notification was REQUESTED (a request does not guarantee an SMS: none is queued if the student has no primary guardian with a phone)."

Better (matches the pattern already in this file) — also return real delivery state. Keep `id` in the select (it is already fetched), then after the visits query do one outbox lookup keyed by the visit ids and map it:

  const ids = (visits ?? []).map((v) => v.id as string);
  const { data: outbox } = await supabase.admin
    .from('notification_outbox')
    .select('status, payload')
    .eq('tenant_id', ctx.tenantId)
    .eq('template', 'clinic.visit')
    .in('payload->>visitId', ids);

(the RPC already stores `'visitId', v_visit_id` in the payload; `payload->>` selectors are already used at line 1404). Build a `Map<visitId, status>` and return `smsStatus: v.notify_guardian ? (map.get(id) ?? 'not_queued') : 'not_requested'` alongside `notifyRequested`, and say exactly that in the description.

Same root cause, worth fixing in the same change: /Users/admin/Atlas-System/apps/web/src/app/clinic/clinic-view.tsx:167 renders the `clinic.notified` badge ("Guardian notified" / "Mlezi amejulishwa", packages/i18n/src/index.ts:628 and :1385) off the same request flag — either relabel the key to "Notification requested" / "Ombi la taarifa" in both EN and SW, or surface the real outbox status from a widened GET /clinic/visits.

---

### 15. Every money date boundary is computed in UTC while Tanzania is UTC+3, dating payments and report windows to the previous day between midnight and 03:00 EAT

- **Location:** `apps/api/src/finance/finance.controller.ts:244`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** finance-correctness

**What is wrong.** payments.paid_on / invoices.issued_on / journal_entries.entry_date all default to Postgres `current_date` (UTC on Supabase), and the API and web compute 'today' as `new Date().toISOString().slice(0,10)` — also UTC — so during the 00:00–03:00 EAT window every date-stamped financial fact and every overdue/as-of comparison is off by one day.

**How it fails.** A boarding school's bursar posts the evening's boarding-fee cash at 01:20 EAT on 2026-10-01 (= 22:20 UTC on 2026-09-30). app.record_payment stores paid_on = 2026-09-30 and the journal entry_date = 2026-09-30, so the receipt lands in September's Fee Collection report even though the receipt book, the M-Pesa statement and the parent's SMS all say 1 October — September's collections are overstated and October's understated, and the two reports can never be tied to the cash book. In the same window /finance/debtors with no asOf parameter defaults to 2026-09-30, and the invoice screen's instalment states are computed against 2026-09-30, so an instalment due 2026-10-01 renders as 'upcoming' to a bursar looking at it on the 1st.

**Evidence.**

```
apps/api/src/finance/finance.controller.ts:244 —
```ts
    const today = new Date().toISOString().slice(0, 10);
```
apps/api/src/finance/finance.controller.ts:318 —
```ts
    const asOf = parsed.data.asOf ?? new Date().toISOString().slice(0, 10);
```
supabase/migrations/00000000000007_finance.sql:84 — `paid_on date not null default current_date,`
supabase/migrations/00000000000007_finance.sql:114 — `entry_date date not null default current_date,`
apps/web/src/app/finance/[id]/page.tsx:66 — `const today = new Date().toISOString().slice(0, 10);`
apps/api/src/ai/ai-tools.service.ts:306 — `const asOf = new Date().toISOString().slice(0, 10);`
```

**Fix.** Two halves; the DB half needs more than the finder's proposed default change, because the RPCs bypass the column defaults.

DB (new migration `00000000000029_local_dates.sql`, additive):
1. Add `create or replace function app.today_local() returns date language sql stable as $$ select (now() at time zone 'Africa/Dar_es_Salaam')::date $$;` and `revoke execute ... from public, anon, authenticated`.
2. `alter table public.payments alter column paid_on set default app.today_local();` — same for `public.invoices.issued_on` and `public.journal_entries.entry_date` (migration 0007 lines 46, 84, 114).
3. Critically, `create or replace` the two functions that hardcode the value, since the column defaults never fire for them: `app.record_payment` (0007 line 380) `coalesce(p_paid_on, current_date)` -> `coalesce(p_paid_on, app.today_local())`, and `app.reverse_payment` (0007 line 445) `current_date` -> `app.today_local()`. Same treatment for `app.return_loan` (0021 line 138) and the import `asOfDate` fallback (0011 line 254) if you want the whole class closed.

API/web (shared helper, e.g. `todayInDar()` in a small `apps/api/src/common/dates.ts` and the mirror the web/mobile already share, implemented as `new Date(Date.now() + 3*3600*1000).toISOString().slice(0,10)` — Tanzania is fixed UTC+3 with no DST, the same assumption `clinic.controller.ts:68` already documents):
- `apps/api/src/finance/finance.controller.ts:244` and `:318`
- `apps/api/src/ai/ai-tools.service.ts:307` (and `:1116`)
- `apps/api/src/ai/ai.controller.ts:176` — otherwise the prompt keeps asserting a UTC date is the school-timezone date
- `apps/api/src/library/library.controller.ts:237`
- `apps/web/src/app/finance/[id]/page.tsx:66`, `apps/web/src/app/finance/debtors/debtors-view.tsx:51`, `apps/web/src/app/reports/reports-view.tsx:51` (and make `firstOfMonth()` there derive from the same helper so the two ends of the default range use one clock).

Regression test, mirroring the existing "BUG clinic dates" row in `docs/ATLAS_TESTING_GUIDE.md` §5: with the clock at 22:20 UTC on 2026-09-30, `record_payment` must stamp `paid_on = 2026-10-01` and the journal `entry_date = 2026-10-01`, and `report_fee_collection(2026-10-01, 2026-10-01)` must include the receipt.

---

### 16. Fee payments have no idempotency key — a retried submit records a second payment, receipt and journal entry

- **Location:** `apps/api/src/finance/finance.controller.ts:363`
- **Category:** idempotency · **Verdict:** CONFIRMED (high) · **Found by:** concurrency-idempotency

**What is wrong.** POST /finance/invoices/:id/payments accepts no client-supplied idempotency key and app.record_payment has no de-duplication; the only protection is a disabled button in the web view. Any retry of a request that reached the server records a duplicate payment with a fresh receipt number and a fresh balanced journal entry.

**How it fails.** A cashier records a TZS 150,000 part-payment against INV-00042 (total 400,000) over a 3G connection. The response is lost to a timeout, the browser/mobile app shows an error, the cashier taps Save again. `app.record_payment` locks the invoice row (`for update`) and recomputes `v_paid`, but 150,000 <= the remaining 250,000 balance, so PAYMENT_EXCEEDS_BALANCE never fires: a second payment row RCT-00087 is inserted, a second journal entry debits Cash 150,000 / credits A/R 150,000, and the parent is credited 300,000 for one 150,000 payment. Because payments are immutable, the only correction is a reversal, which requires finance.refunds.approve — a permission the cashier role does not have (0007:520-521).

**Evidence.**

```
finance.controller.ts:377-386 —
```
const { data, error } = await this.supabase.admin.rpc('record_payment', {
  p_tenant_id: req.tenant.tenantId, p_actor: req.user.id, p_invoice_id: id,
  p_amount: parsed.data.amount, p_method: parsed.data.method,
  p_reference: parsed.data.reference ?? null, p_paid_on: parsed.data.paidOn ?? null,
});
```
supabase/migrations/00000000000007_finance.sql:367-381 — the only guard is the balance check; nothing keys off `reference` or a request id:
```
select coalesce(sum(amount), 0) into v_paid from public.payments where invoice_id = p_invoice_id;
v_balance := v_invoice.total - v_paid;
if p_amount > v_balance then raise exception 'PAYMENT_EXCEEDS_BALANCE'; end if;
v_receipt := 'RCT-' || lpad(app.next_counter(p_tenant_id, 'receipt_number')::text, 5, '0');
insert into public.payments (...)
```
`payments` has `unique (tenant_id, receipt_number)` but no uniqueness on (invoice_id, amount, reference, paid_on) — 0007:88. The AI path (ai-actions.service.ts:829-847) calls the same RPC with the same gap.
```

**Fix.** Add an optional idempotency key end-to-end; ~40 lines, additive-only. (1) New migration supabase/migrations/00000000000029_payment_idempotency.sql: `alter table public.payments add column if not exists idempotency_key text;` + `create unique index payments_idem_idx on public.payments (tenant_id, idempotency_key) where idempotency_key is not null;` then a NEW 8-arg overload `create or replace function app.record_payment(p_tenant_id uuid, p_actor uuid, p_invoice_id uuid, p_amount numeric, p_method text, p_reference text, p_paid_on date, p_idempotency_key text)` — copy the 0007 body and, immediately after the `for update` on the invoice, add: `if p_idempotency_key is not null then select id, receipt_number into v_payment_id, v_receipt from public.payments where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key; if v_payment_id is not null then return jsonb_build_object('paymentId', v_payment_id, 'receiptNumber', v_receipt, 'balance', <recomputed balance>); end if; end if;` and carry p_idempotency_key into the insert. Because the invoice row is already locked `for update`, the lookup + insert are serialised per invoice, and the partial unique index is the backstop. Ship the matching service-role-only wrapper per the iron rules: `create or replace function public.record_payment(<8 args>) ... security definer ... $$ select app.record_payment(...) $$;` with `revoke execute ... from public, anon, authenticated;` and `grant execute ... to service_role;`. Leave the existing 7-arg pair untouched so nothing breaks. (2) apps/api/src/finance/finance.controller.ts:363 — add `@Headers('idempotency-key') idem: string | undefined`, validate with `z.string().trim().min(8).max(100).optional()` (reject otherwise with code 'PAYMENT_INVALID'), and pass `p_idempotency_key: idem ?? null` in the rpc call. (3) apps/web/src/app/finance/[id]/invoice-view.tsx and apps/mobile/src/app/finance/[id].tsx — generate `crypto.randomUUID()` into state when the dialog/sheet opens, send it as the `Idempotency-Key` header, and regenerate it only after a successful post or when the amount/method changes, so a retry of the same attempt reuses the key. (4) Extend apps/api/scripts/smoke-finance.mjs to POST the same part-payment twice with one key and assert an identical receiptNumber and a single payments row. No change needed in ai-actions.service.ts — the proposal claim at :2305-2320 already dedupes that path.

---

### 17. Opening-balance re-import double-bills students: the "already imported" guard is silently truncated to 1000 rows

- **Location:** `apps/api/src/imports/imports.controller.ts:786`
- **Category:** data-integrity · **Verdict:** CONFIRMED (high) · **Found by:** data-integrity-perf

**What is wrong.** validateOpeningBalances builds its `alreadyImported` set from `import_staging_rows` with `.limit(20000)`, but PostgREST caps every response at 1000 rows (`max_rows = 1000` in supabase/config.toml), so students beyond the first 1000 previously-committed rows are never flagged ALREADY_IMPORTED and get a second opening-balance invoice + journal entry.

**How it fails.** A 1500-student school migrates opening balances. Job #1 commits 1500 rows (1500 invoices, 1500 journal entries debiting A/R). The bursar re-uploads the same spreadsheet a week later (a normal "did it all go through?" action, or a partial-failure retry). The prior-rows read returns only 1000 of the 1500 committed rows, so the ~500 students whose staging rows fall outside that arbitrary 1000-row page are NOT marked duplicate, pass validation as `valid`, and are committed again. Those 500 families are invoiced twice for their historic debt, A/R in the trial balance is inflated by ~500 × their opening balance, and because invoices/journal_lines are immutable (migration 0010) the only correction is 500 manual reversals.

**Evidence.**

```
apps/api/src/imports/imports.controller.ts:778-791
```ts
      const { data: priorRows } = await this.supabase.admin
        .from('import_staging_rows')
        .select('mapped_data')
        .in(
          'import_job_id',
          priorJobs.map((j) => j.id as string),
        )
        .not('final_record_id', 'is', null)
        .limit(20000);
      for (const r of priorRows ?? []) {
        const sid = (r.mapped_data as { studentId?: string } | null)?.studentId;
        if (sid) alreadyImported.add(sid);
      }
```
The cap is confirmed by the project's own config and by the workers' comment:
supabase/config.toml:  `max_rows = 1000`
apps/workers/src/process-imports.ts:67-68  `// Paginate past PostgREST's 1000-row cap (a bare .limit(5000) silently // truncates at 1000).`
apps/api/src/imports/imports.controller.ts:109  `/** Reads all staging rows past PostgREST's 1000-row page limit. */`
```

**Fix.** Three changes, the first two in the same patch (fixing either alone is ineffective or actively harmful):

1. apps/api/src/imports/imports.controller.ts:778-791 - replace the bare `.limit(20000)` on `import_staging_rows` with the `.range(from, from + page - 1)` loop already used by `loadStagingRows` (lines 110-129), paging until a short page is returned. Add `.order('id')` so paging is stable.

2. apps/api/src/imports/imports.controller.ts:757-761 - the `students` read has the same bare `.limit(10000)` and is truncated by the same cap; paginate it identically. Do NOT ship this one without #1: making >1000-student rosters resolvable is exactly what turns this latent bug into the finder's full-scale "1500 students, 500 double-billed" scenario.

3. Durable fix - make the guard authoritative at commit time, since an in-memory Set computed at validation cannot survive the validate-then-approve gap (two jobs validated before either commits both pass today). In a new additive migration, inside the `opening_balances` branch of `app.import_commit_chunk` (migration 0011, before the `insert into public.invoices`), add:
   `if exists (select 1 from public.import_staging_rows r join public.import_jobs j on j.id = r.import_job_id where j.tenant_id = p_tenant_id and j.domain = 'opening_balances' and r.final_record_id is not null and r.mapped_data->>'studentId' = v_data->>'studentId') then raise exception 'IMPORT_ALREADY_IMPORTED'; end if;`
   The per-row exception scope already turns that into a `commit_error` on the row instead of a duplicate posting. Back it with an index on `(import_job_id) where final_record_id is not null` plus an expression index on `(mapped_data->>'studentId')`, or equivalently a partial unique index keyed on student for opening-balance invoices.

Also extend apps/api/scripts/smoke-imports.mjs beyond its current 2-row case (lines 184-192) with a fixture that crosses the 1000-row boundary, so the cap is actually exercised.

---

### 18. Duplicate-student detection on bulk import only sees 1000 existing students

- **Location:** `apps/api/src/imports/imports.controller.ts:596`
- **Category:** data-integrity · **Verdict:** CONFIRMED (high) · **Found by:** data-integrity-perf

**What is wrong.** validateStudents builds `existingKeys` (first+last name + DOB) from a `students` read capped at 1000 rows, so the DUP_EXISTING check misses every student outside that arbitrary page and duplicate student records are committed into the roster.

**How it fails.** A school with 1500 existing students imports a Form-1 intake spreadsheet that (as always happens) re-includes 40 continuing students. `existingKeys` contains only 1000 of the 1500 name+DOB keys; for the ~13 of those 40 whose records fall outside the page, DUP_EXISTING never fires, the row validates as `valid`, and `app.import_students` creates a second `students` row with a new STU- number. The school now has the same child twice — two admission numbers, two attendance registers, two invoices, and the parent gets duplicate absence SMS (mark_attendance queues one alert per absent student per primary guardian).

**Evidence.**

```
apps/api/src/imports/imports.controller.ts:592-602
```ts
    const { data: existing } = await this.supabase.admin
      .from('students')
      .select('first_name, last_name, date_of_birth')
      .eq('tenant_id', req.tenant.tenantId)
      .limit(10000);
    const existingKeys = new Set(
      (existing ?? []).map(
        (s) =>
          `${normalizeHeader(s.first_name as string)}|${normalizeHeader(s.last_name as string)}|${s.date_of_birth ?? ''}`,
```
There is also no DB-level backstop: `public.students` (supabase/migrations/00000000000004_students_guardians_invitations.sql:28) is unique only on `(tenant_id, student_number)`, which is generated per row by `app.next_counter`, so duplicates can never collide.
```

**Fix.** In apps/api/src/imports/imports.controller.ts, stop relying on .limit() for roster reads. Add a paginated helper next to loadStagingRows (line 109), e.g.:

  private async loadAllStudents<T>(tenantId: string, columns: string): Promise<T[]> {
    const out: T[] = []; const page = 1000;
    for (let from = 0; ; from += page) {
      const { data, error } = await this.supabase.admin
        .from('students').select(columns).eq('tenant_id', tenantId)
        .order('id').range(from, from + page - 1);
      if (error) throw new InternalServerErrorException({ code: 'IMPORT_ROSTER_READ_FAILED' });
      out.push(...((data ?? []) as T[]));
      if (!data || data.length < page) break;
    }
    return out;
  }

Then replace the truncated read at line 591-596 (validateStudents, 'first_name, last_name, date_of_birth') and the one at 757-765 (validateOpeningBalances, 'id, student_number' — this one is the more urgent of the two because STUDENT_NOT_FOUND is a hard error there). Also paginate or bound the class_sections read at 584-587 and the prior-rows read at 776-786 (.limit(20000) is likewise capped at 1000, which silently weakens ALREADY_IMPORTED).

Separately, and independent of the pagination fix: if duplicate-vs-existing is meant to actually stop a duplicate roster entry, it must not remain a bare 'warning' — either add DUP_EXISTING to the hard list at lines 726-735, or expose a per-row decision='skip' control (the column already exists at migration 0011:67 and app.import_commit_chunk already honours it at 0011:181) and default duplicate rows to 'skip'. No index or DB check is needed for the pagination fix; students_name_idx (tenant_id, last_name, first_name) already exists.

---

### 19. GET /staff requires members.manage, which no role_permissions row ever grants — the Staff page is broken for the roles the docs point at it

- **Location:** `apps/api/src/invitations/invitations.controller.ts:172`
- **Category:** authorization · **Verdict:** CONFIRMED (high) · **Found by:** authz-permissions

**What is wrong.** `members.manage` is defined in the permissions table but is granted to zero roles in seed.sql and in every migration, so StaffController.list 403s for every non-owner; because TenantGuard denies on a missing permission, the staff roster is invisible to school_admin and head_teacher even though the admin guide tells them to manage staff there.

**How it fails.** A head_teacher (permissions per seed.sql:84-96 include members.invite but not members.manage) opens /staff, which docs/ADMIN_GUIDE.md:35 and :226 designate as their staff-management page. StaffView.reload() fires GET /api/v1/staff and GET /api/v1/invitations in parallel; TenantGuard's `if (required && !isOwner && !permissions.has(required))` throws ForbiddenException('Missing permission: members.manage'), so the page renders a red error banner and a permanently empty member table, while the pending-invitations card below it populates normally (members.invite is granted). The head_teacher can invite staff but can never see who is already on the roster.

**Evidence.**

```
apps/api/src/invitations/invitations.controller.ts:170-182
  @Get()
  @UseGuards(AuthGuard, TenantGuard)
  @RequirePermission('members.manage')
  async list(@Req() req: TenantRequest) { ... .from('tenant_memberships') ... }

supabase/seed.sql:32 defines the key — `('members.manage', 'settings', 'Manage members and roles')` — but no role array in seed.sql:75-127 or in any `insert into public.role_permissions` across supabase/migrations/*.sql contains 'members.manage' (grep confirms the only other occurrences are the two code comments in payroll.controller.ts:79 and timetable.controller.ts:125 noting that a bursar lacks it).

TenantGuard denies rather than passes on a missing grant — apps/api/src/tenancy/tenant.guard.ts:162-164:
  if (required && !isOwner && !permissions.has(required)) {
    throw new ForbiddenException(`Missing permission: ${required}`);
  }

Consumer: apps/web/src/app/staff/staff-view.tsx:63-73 sets loadError from the 403 and leaves `members` empty.

docs/ADMIN_GUIDE.md:145 — `| Staff: invite | ✓ | ✓ | ✓ | — | ... |` (Owner/Director, School Admin, Head Teacher).
```

**Fix.** Grant the key rather than loosening the endpoint (keeps roster reads distinct from invite rights). Add supabase/migrations/00000000000029_members_manage_grant.sql with an idempotent insert mirroring the house pattern used in 0016-0025 — `insert into public.role_permissions (role_id, permission_key) select r.id, 'members.manage' from public.roles r where r.tenant_id is null and r.is_system and r.key in ('head_teacher','school_admin') on conflict do nothing;` (system roles are tenant_id-null, so one row per role covers every tenant). Mirror it by adding 'members.manage' to the head_teacher array (supabase/seed.sql:90, next to 'members.invite') and the school_admin array (seed.sql:101). Optionally add a "Staff: view roster" row to the docs/ADMIN_GUIDE.md Part II matrix (near line 145) and a CI/turbo assertion that every @RequirePermission key in apps/api/src appears in at least one seed.sql role array — that check would have caught this and would also catch the identical gap on the AI tool at apps/api/src/ai/ai-tools.service.ts:1446. If instead you want roster reads open to anyone who can invite, the one-line alternative is changing apps/api/src/invitations/invitations.controller.ts:172 (and ai-tools.service.ts:1446) to 'members.invite', but then members.manage remains a dead key.

---

### 20. Library catalogue over-reports available copies once a school has more than 1000 active loans

- **Location:** `apps/api/src/library/library.controller.ts:107`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** data-integrity-perf

**What is wrong.** GET /library counts outstanding loans per book by fetching every active loan with `.limit(10000)`, which PostgREST truncates to 1000, so `activeLoans` is undercounted and `available = copies_total - activeLoans` is overstated.

**How it fails.** A 1500-student school issues textbooks at the start of term — 3 books per pupil is ~4,500 active loans. The loans read returns 1,000 arbitrary rows, so the per-book `loaned` map is missing ~3,500 loans. The catalogue shows, for a title with 200 copies all on loan, `activeLoans: 45, available: 155`. The librarian tells a queue of students the book is in stock; every attempted loan then fails with LIBRARY_NO_COPIES from `app.loan_book`, which is the only place the real count is enforced. The displayed inventory of the whole library is wrong for the entire term.

**Evidence.**

```
apps/api/src/library/library.controller.ts:102-131
```ts
      this.supabase.admin
        .from('library_loans')
        .select('book_id')
        .eq('tenant_id', req.tenant.tenantId)
        .is('returned_on', null)
        .limit(10000),
...
    const loaned = new Map<string, number>();
    for (const l of loans.data ?? []) {
      const bookId = l.book_id as string;
      loaned.set(bookId, (loaned.get(bookId) ?? 0) + 1);
    }
...
        activeLoans: loaned.get(b.id) ?? 0,
        available: b.copies_total - (loaned.get(b.id) ?? 0),
```
supabase/config.toml `max_rows = 1000` caps the response at 1000 regardless of the requested 10000; the same file's book read at line 101 already uses the safe `.limit(1000)`.
```

**Fix.** Minimal, migration-free fix in apps/api/src/library/library.controller.ts `list()` (lines 95-120): stop relying on a single oversized `.limit()` and page the loans read, copying the existing house pattern in apps/workers/src/process-imports.ts:67-90.

Replace the second element of the Promise.all with a paginated helper and build the map from its result:

```ts
private async activeLoanCounts(tenantId: string): Promise<Map<string, number>> {
  const loaned = new Map<string, number>();
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await this.supabase.admin
      .from('library_loans')
      .select('book_id')
      .eq('tenant_id', tenantId)
      .is('returned_on', null)
      .order('id')                 // stable order — required for .range() paging
      .range(from, from + page - 1);
    if (error) throw new InternalServerErrorException({
      code: 'LIBRARY_FETCH_FAILED', message: error.message,
    });
    for (const l of data ?? []) {
      const id = l.book_id as string;
      loaned.set(id, (loaned.get(id) ?? 0) + 1);
    }
    if (!data || data.length < page) break;
  }
  return loaned;
}
```
Then `const [books, loaned] = await Promise.all([<existing books query>, this.activeLoanCounts(req.tenant.tenantId)]);`, drop the `loans.error` branch, and leave lines 121-133 unchanged.

Do NOT take the finder's RPC route as the first move: migrations 0016-0028 are written but not yet applied to the live DB, so adding a 0029 `app.library_active_loan_counts` (plus the mandatory service-role-only `public.*` wrapper with explicit revoke/grant, per the iron rules) extends the already-blocked DDL gate for a fix that needs no schema change. Keep the group-by RPC as a follow-up optimisation once the gate clears; library_loans_book_active_idx (00000000000021_library.sql:37) supports it.

Optional hardening in the same file, same root cause: GET /library's book read (line 101) and GET /library/overdue (line 249) also cap at 1000 rows — either paginate them the same way or return an explicit `truncated: true` flag so the UI can say so instead of silently showing a partial list.

---

### 21. Onboarding is two non-atomic phases: a failure after onboard_school archives the tenant and permanently burns the school's slug

- **Location:** `apps/api/src/onboarding/onboarding.controller.ts:101`
- **Category:** atomicity · **Verdict:** CONFIRMED (high) · **Found by:** concurrency-idempotency

**What is wrong.** The tenant/campus/year/membership are created inside the onboard_school RPC, but the trial subscription is a separate uncommitted write. If that second write (or the plans lookup) fails, the compensating action archives the tenant — and because tenants are never hard-deleted, the slug stays taken, so the same school can never sign up under the same name again. If the process dies between the two calls there is no compensation at all and the tenant is left with no subscription.

**How it fails.** A school owner signs up 'Chief Sarwatt School' (slug chief-sarwatt-school). `onboard_school` commits the tenant, campus, academic year and the owner's membership. The `plans` read or the `subscriptions` insert then fails (transient pooler error / connection reset). The handler archives the tenant and returns ONBOARDING_SUBSCRIPTION_FAILED. The owner retries the wizard with the same school name — slugify produces the same slug, the pre-check at line 41-51 finds the archived tenant and returns 409 ONBOARDING_SLUG_TAKEN forever. Variant: the API pod is restarted (deploy) between the RPC and the subscription insert; no archive runs, so the tenant exists with zero subscriptions; app.tenant_entitlements returns `subscriptionStatus: 'expired'` (0013:102) and TenantGuard rejects every non-GET with SUBSCRIPTION_EXPIRED (tenant.guard.ts:117-123) — the owner is locked out of a school they can see but cannot configure, with no self-service recovery.

**Evidence.**

```
onboarding.controller.ts:83-110 —
```
const { data: trialPlan, error: planError } = await this.supabase.admin
  .from('plans').select('id').eq('key', 'trial').single();
let subError: { message: string } | null = null;
if (trialPlan) {
  ({ error: subError } = await this.supabase.admin.from('subscriptions').insert({...}));
}
if (planError || !trialPlan || subError) {
  await this.supabase.admin.from('tenants').update({ status: 'archived' }).eq('id', result.tenantId);
  throw new InternalServerErrorException({ code: 'ONBOARDING_SUBSCRIPTION_FAILED', ... });
}
```
The archive update's own error is never checked. Slug uniqueness is enforced on the surviving row (onboarding.controller.ts:41-51 + the tenants unique slug constraint), and CLAUDE.md states tenants are never hard-deleted.
```

**Fix.** Make provisioning atomic. In a new additive migration (supabase/migrations/00000000000029_*.sql) `create or replace function app.onboard_school(uuid, jsonb)` — same body as 0002:137-236 — and just before the audit_logs insert add:

  insert into public.subscriptions (tenant_id, plan_id, status, trial_ends_at)
  select v_tenant_id, p.id, 'trialing', now() + interval '30 days'
  from public.plans p where p.key = 'trial';
  if not found then raise exception 'ONBOARDING_MISSING_TRIAL_PLAN'; end if;

so tenant + subscription commit in one transaction (the whole plpgsql function is already one). Then delete apps/api/src/onboarding/onboarding.controller.ts:78-110 (the plans lookup, the subscriptions insert, and the archive compensation) — the ONBOARDING_SUBSCRIPTION_FAILED branch disappears because a failed subscription insert now rolls the tenant back, freeing the slug automatically. Keep the existing `if (error)` mapping at 59-70 and add ONBOARDING_MISSING_TRIAL_PLAN to it as a 500.

Secondary (defensive, cheap): in apps/api/src/platform/platform.controller.ts:361 change the reactivate precondition from `tenant.status !== 'suspended'` to `!['suspended','archived'].includes(tenant.status)` so operators have an API-level escape from a wrongly-archived tenant instead of needing psql.

---

### 22. "Extend trial" silently downgrades an active PAID subscription to `trialing` and later locks the school out

- **Location:** `apps/api/src/platform/platform.controller.ts:492`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** gap:tenant-facing subscription/entitlement surface (schools are blind to their own trial and limits)

**What is wrong.** POST /platform/tenants/:id/trial-extend unconditionally sets status='trialing' on the newest subscription row without checking its current status, converting a paying, in-period subscription into a trial that expires — and the UI offers the button for every non-archived tenant.

**How it fails.** A school buys Msingi annual on 1 Feb 2026: changePlan inserts status='active', current_period_end = 2027-02-01. In March a support agent, wanting to give the school a free grace month, clicks "Extend trial" (30 days) on the tenant row in /platform. The handler selects the newest subscription (the paid 'active' row), computes base = max(now, trial_ends_at ?? 0) = now, and updates it to {trial_ends_at: 2026-04-XX, status: 'trialing'}, leaving current_period_end = 2027-02-01 untouched. On 2026-04-XX the guard's trialExpired branch fires (status is now 'trialing') and every non-GET request from a school that has paid through Feb 2027 is rejected with SUBSCRIPTION_EXPIRED — the paid current_period_end is never consulted because the subscriptionLapsed check only runs for status === 'active'.

**Evidence.**

```
apps/api/src/platform/platform.controller.ts:471-493 — `.select('id, trial_ends_at, status')` reads `status` and then never uses it; the update is unconditional: `.update({ trial_ends_at: newEnd, status: 'trialing' }).eq('id', sub.id)`. apps/web/src/app/platform/platform-view.tsx:663-682 renders the button for every tenant with `{t.status !== "archived" && (... <Button ... onClick={() => setAction({ kind: "trial", tenant: t })}>Extend trial</Button>)}` — no gating on subscription status. apps/api/src/tenancy/tenant.guard.ts:127-131 only evaluates currentPeriodEnd when `entitlements.subscriptionStatus === 'active'`, so the paid period is invisible once the row says 'trialing'.
```

**Fix.** apps/api/src/platform/platform.controller.ts, in `extendTrial` right after the `if (!sub) throw ... NO_SUBSCRIPTION` line (~482): refuse to downgrade a paid row —

```ts
if (sub.status === 'active' || sub.status === 'past_due') {
  // Never convert a paid subscription into a trial: the guard stops
  // consulting current_period_end once the row says 'trialing'.
  throw new BadRequestException({ code: 'NOT_A_TRIAL' });
}
```

(keeps the existing "revive a lapsed/cancelled trial" behaviour, keeps smoke-platform green since it sets status='trialing' first). Add `NOT_A_TRIAL` to the EN+SW error map in `apps/web/src/lib/api-error.ts` + `packages/i18n/src/index.ts`.

apps/web/src/app/platform/platform-view.tsx:676-682: only render the "Extend trial" button when the tenant's current subscription is a trial, e.g. wrap it in `{(sub(t)?.status === "trialing" || sub(t)?.status === "cancelled") && ( ... )}` so the paid case is not offered at all. Staff wanting to give a paying school extra time use "Record payment" (which extends `current_period_end` and keeps `status='active'`).

---

### 23. `/students/import` advertises 2000 rows but Express's default 100 kB body limit rejects anything past ~380 — bulk student import is broken for real schools

- **Location:** `apps/api/src/students/students.schema.ts:35`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** input-validation

**What is wrong.** `importRequestSchema` allows up to 2000 rows and the web Import dialog POSTs every parsed row in one JSON body, but `main.ts` never raises the body-parser limit, so body-parser 2.3.0's 100 kB default returns a bare 413 before the controller (or zod) ever runs.

**How it fails.** A secondary school imports its 500-student roster through Students → Import. `handleFile` parses the spreadsheet and `run()` posts `{rows: [...500], dryRun: true}` as a single JSON body. I measured a template-shaped row at 273 bytes, so 500 rows = **134 KB** and 2000 rows (the schema's own documented maximum) = **535 KB** — both over the 102400-byte default. Express answers 413 with `{"statusCode":413,"message":"request entity too large"}` and no `code` field, so `apiErrorMessage` falls through every branch and the dialog shows `"<generic> (HTTP 413)"`. The school cannot import its roster and has no idea why; the threshold (~380 rows) is invisible and undocumented.

**Evidence.**

```
apps/api/src/students/students.schema.ts:34-37
```ts
export const importRequestSchema = z.object({
  rows: z.array(importRowSchema).min(1).max(2000),
  dryRun: z.boolean().default(false),
});
```
apps/api/src/main.ts — `NestFactory.create` is never given body-parser options, so `@nestjs/platform-express` uses `express.json({})`:
```ts
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.use(helmet({ contentSecurityPolicy: false }));
```
node_modules/.pnpm/body-parser@2.3.0/.../lib/utils.js:62 → `? 102400 // 100kb default`
apps/web/src/app/students/students-view.tsx:632-636 (whole file in one request, no chunking):
```ts
			const response = await apiFetch("/api/v1/students/import", {
				method: "POST",
				tenantId,
				body: JSON.stringify({ rows, dryRun }),
			});
```
Measured payload sizes: 200 rows → 54 KB, 380 rows → 102 KB, 500 rows → 134 KB, 2000 rows → 535 KB.
```

**Fix.** Three-part minimal fix. (1) apps/api/src/main.ts — after `const app = await NestFactory.create<NestExpressApplication>(AppModule);` add `app.useBodyParser('json', { limit: '2mb' });` (Nest 11 signature is `useBodyParser(parser, options?)` — two args, not three). 2 MB comfortably covers the schema's own 2000-row maximum (~535 kB) with headroom for longer Swahili names, and keeps every other JSON route well below any DoS concern. (2) apps/web/src/app/students/students-view.tsx — in `ImportDialog.run()` (line ~630), chunk instead of sending one body: slice `rows` into batches of 200, POST each sequentially, and merge the responses (sum `valid`/`invalid`/`imported`, concatenate `errors` with a row-offset applied so reported row numbers stay absolute). This keeps the client under the limit even if the server config regresses. (3) apps/api/src/common/http-500-scrub.filter.ts — before the 5xx branch, special-case the body-parser error so it stops masquerading as an INTERNAL 500: `if (exception instanceof Error && (exception as any).type === 'entity.too.large') { res.status(413).json({ code: 'REQUEST_TOO_LARGE' }); return; }`. Then add `REQUEST_TOO_LARGE: "err.requestTooLarge"` to ERROR_KEYS in apps/web/src/lib/api-error.ts with mirrored EN+SW keys in packages/i18n/src/index.ts, so the dialog shows a real "file too large, split it up" message instead of a generic server error.

---

### 24. An upstream Supabase Auth outage is reported to users as 401 and never reaches Sentry

- **Location:** `apps/api/src/supabase/supabase.service.ts:32`
- **Category:** operability · **Verdict:** CONFIRMED (high) · **Found by:** config-ops-secrets

**What is wrong.** `getUserFromToken` collapses every failure — expired token, malformed token, network error, GoTrue 5xx, rate limit — into `null`, and AuthGuard turns that into a 401. Every single authenticated API request makes this network round trip (no caching, no local JWT verification). Because `LoggingInterceptor` only calls `captureError` for `status >= 500`, a mass-401 outage produces zero Sentry events and no alert.

**How it fails.** Supabase's auth endpoint has a 3-minute blip or rate-limits the project during morning attendance. Every in-flight API call — mark attendance, record payment, Ask ATLAS — gets `error` back from `auth.getUser()`, returns `null`, and the guard throws `UnauthorizedException`. Teachers see "unauthorized" on every save; the web client's session is still valid so the user is not even re-prompted usefully. Meanwhile Sentry records nothing (401 < 500), `/health/database` still reports ok (it queries PostgREST, not GoTrue), and the ops dashboard shows a healthy system while the entire platform is unusable. There is no metric or alert that would surface a 401 spike.

**Evidence.**

```
apps/api/src/supabase/supabase.service.ts:32-36 —
```
  async getUserFromToken(accessToken: string): Promise<User | null> {
    const { data, error } = await this.client.auth.getUser(accessToken);
    if (error) return null;
    return data.user;
  }
```
apps/api/src/auth/auth.guard.ts:26-29 —
```
    const user = await this.supabase.getUserFromToken(header.slice(7));
    if (!user) {
      throw new UnauthorizedException('Invalid or expired token');
    }
```
apps/api/src/observability/logging.interceptor.ts:70-74 —
```
        if (status >= 500) {
          captureError(err, { request_id: requestId, route: ... });
        }
```
apps/api/src/health/health.controller.ts:52-56 probes `roles` via PostgREST only — no auth-service probe exists.
```

**Fix.** Four small changes. (1) apps/api/src/supabase/supabase.service.ts — stop collapsing every failure: keep `return null` only for genuine token rejections, and signal upstream failure separately, e.g. `const { data, error } = await this.client.auth.getUser(accessToken); if (error) { const s = (error as { status?: number }).status; if (error.name === 'AuthRetryableFetchError' || s === undefined || s === 429 || s >= 500) throw new AuthUpstreamUnavailableError(error.message); return null; } return data.user;` (define `AuthUpstreamUnavailableError extends Error` in the same file). (2) apps/api/src/auth/auth.guard.ts — wrap the call and translate: `catch (e) { if (e instanceof AuthUpstreamUnavailableError) throw new ServiceUnavailableException({ code: 'AUTH_UPSTREAM_UNAVAILABLE' }); throw e; }`, leaving the existing 401 for `user === null`. (3) CRITICAL, and missing from the finder's proposal: guard-phase exceptions never reach LoggingInterceptor, so a 503 thrown in a guard would still produce no Sentry event. Move the alerting hook into apps/api/src/common/http-500-scrub.filter.ts — after the existing `scrubLogger.error(...)` call, add `captureError(exception, { route: req.originalUrl.split('?')[0], request_id: (res.getHeader('x-request-id') as string) ?? null })`. That covers guard-phase 5xx and does not double-report handler 5xx only if you also drop the captureError block at logging.interceptor.ts:70-75 (otherwise handler errors would be captured twice — pick one owner; the filter is the correct one because it is the only layer that sees guard errors). (4) apps/api/src/health/health.controller.ts — add a `@Get('auth') @UseGuards(HealthTokenGuard)` probe that fetches `${SUPABASE_URL}/auth/v1/health` with the apikey header and throws `ServiceUnavailableException({ status: 'down', component: 'auth' })` on non-2xx, then add it to the alert list in docs/audit/ATLAS_MONITORING.md. Optional hardening (not required to close the finding): a 30-60s in-process cache keyed by a hash of the access token, used ONLY as a fallback when the upstream is unavailable, so a short blip does not fail in-flight requests — note the tradeoff that a cached token stays valid briefly after sign-out/ban, which is why fallback-only is safer than an always-on cache. Also add `AUTH_UPSTREAM_UNAVAILABLE` to ERROR_KEYS in apps/web/src/lib/api-error.ts and apps/mobile/src/lib/api-error.ts with mirrored EN+SW keys in packages/i18n/src/index.ts, otherwise the client renders the raw code via the `err.generic (CODE)` fallback.

---

### 25. smsMonthly plan cap is resolved and displayed but enforced nowhere — unbounded billable SMS on any plan

- **Location:** `apps/api/src/tenancy/tenant.guard.ts:29`
- **Category:** cost-exposure · **Verdict:** CONFIRMED (high) · **Found by:** workers-outbox

**What is wrong.** Every other plan limit (students, staff, campuses) is enforced at its write path, but `limits.smsMonthly` / `usage.smsThisMonth` exist only as TypeScript field declarations — no controller, RPC, or worker ever compares them, so a school on a 200-SMS plan can queue and send unlimited billable SMS.

**How it fails.** A Starter-plan school (`{"students": 300, ... "smsMonthly": 200}`, migration 0013 line 17) has 280 distinct guardian phone numbers. A school_admin (or a compromised account) calls `POST /communication/announcements` with `audienceType: 'all_guardians'` and a 480-char body. `app.queue_announcement` inserts 280 outbox rows; `drain-outbox` sends all 280 with no cap check. The global throttler allows 300 requests/min/IP (app.module.ts:55), so the same call can be repeated ~300×/min → ~84,000 outbox rows/minute, each up to 4 GSM segments at Beem. The platform is billed for every one; ATLAS records `usage.smsThisMonth` climbing past `limits.smsMonthly` and does nothing. Daily `attendance.absent` alerts add to this automatically with no cap either.

**Evidence.**

```
apps/api/src/tenancy/tenant.guard.ts:26-37 declares the shape:
```ts
  limits: {
    students: number | null;
    staff: number | null;
    campuses: number | null;
    smsMonthly: number | null;
  };
  ...
  usage: {
    students: number;
    staff: number;
    campuses: number;
    smsThisMonth: number;
  };
```
`grep -rn "smsMonthly\|smsThisMonth" apps/api/src apps/web/src apps/workers/src apps/mobile/src` returns ONLY these two declaration lines — zero read sites. Contrast the enforced sibling at apps/api/src/students/students.controller.ts:73: `if (limits.students !== null && usage.students + adding > limits.students) { ... code: 'PLAN_LIMIT_STUDENTS'`. The outbox drainer (apps/workers/src/drain-outbox.ts:89-96) selects pending rows filtered only by tenant status and `next_attempt_at` — no entitlement lookup at all.
```

**Fix.** Enforce at queue time in the DB (authoritative) and defend at drain time. (a) New additive migration 0029: add `app.assert_sms_quota(p_tenant_id uuid, p_adding int)` that computes `v_cap := nullif(app.tenant_entitlements(p_tenant_id)->'limits'->>'smsMonthly','')::int` and `v_used := (select count(*) from public.notification_outbox where tenant_id = p_tenant_id and status in ('pending','sent') and created_at >= date_trunc('month', now()))` — pending MUST be included, since tenant_entitlements' smsThisMonth counts only 'sent' and would let a pre-drain burst slip through — then `if v_cap is not null and v_used + p_adding > v_cap then raise exception 'PLAN_LIMIT_SMS'; end if;`. Call it right before the outbox INSERT in `app.queue_announcement` (00000000000008_communication.sql:84), `app.mark_attendance` (00000000000010_audit_hardening.sql:201), `app.queue_fee_reminders` (00000000000009_parents.sql:191) and `app.record_clinic_visit` (00000000000023_clinic.sql:77), sizing p_adding from the same recipient subquery (for attendance/clinic, prefer truncate-and-report over failing the attendance write itself). (b) apps/api/src/communication/communication.controller.ts: add 'PLAN_LIMIT_SMS' to KNOWN_ERRORS so the RPC error surfaces as a 403/400 `{ code: 'PLAN_LIMIT_SMS' }` instead of ANNOUNCEMENT_FAILED, and add a per-route `@Throttle({ default: { limit: 10, ttl: 60_000 } })` to blunt the 300/min amplification. (c) apps/workers/src/drain-outbox.ts drainOnce (lines 88-97): after fetching the batch, group rows by tenant_id, call the quota helper once per tenant, and park over-quota rows (leave pending, push next_attempt_at to the start of next month) so a queued backlog can't be drained past the cap. (d) Map the code for users: PLAN_LIMIT_SMS -> "err.planLimitSms" in apps/web/src/lib/api-error.ts and apps/mobile/src/lib/api-error.ts, with mirrored EN+SW keys in packages/i18n/src/index.ts; optionally show remaining quota in the communication view from entitlements.

---

### 26. AI action confirm/reject has no error handling and no button lockout — a network drop on a money action leaves the user with no feedback

- **Location:** `apps/mobile/src/app/(tabs)/assistant.tsx:149`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** mobile-i18n

**What is wrong.** `decideAction` awaits `apiFetch` with no try/catch (unlike `send()` on the same screen), and the Confirm/Reject PillButtons are rendered without `loading` or `disabled`, so a rejected fetch produces an unhandled promise rejection, no error message, and a still-tappable Confirm button on a card that records real money.

**How it fails.** A bursar asks Ask ATLAS to "record 450,000 for INV-00012", gets the propose card, and taps Thibitisha on a flaky connection. `apiFetch` rejects with "Network request failed"; because `decideAction` is invoked as `void decideAction(...)` with no catch, the rejection is unhandled — in a release build nothing is logged and nothing is rendered. The card stays in the `!action.outcome` state with the Confirm button still enabled and no error text, so the bursar cannot tell whether TZS 450,000 was recorded and taps Confirm again. Compare `send()` (lines 136-137) which does catch and shows `common.apiUnreachable`.

**Evidence.**

```
src/app/(tabs)/assistant.tsx:143-158 — `async function decideAction(...) { if (!tenantId) return; const res = await apiFetch(\`/api/v1/ai/actions/${actionId}/${decision}\`, { method: "POST", tenantId }); const body = (await res.json().catch(() => null)) as ...` — no try/catch around the awaited `apiFetch`.
src/app/(tabs)/assistant.tsx:300-307 — `<PillButton haptic onPress={() => void decideAction(i, action.actionId, "confirm")} style={styles.actionButton} title={t("common.confirm")} />` — no `loading`/`disabled` prop, and `PillButton` only blocks presses when one of those is set (src/components/pill-button.tsx:39-45).
```

**Fix.** In apps/mobile/src/app/(tabs)/assistant.tsx: (1) add `const [deciding, setDeciding] = useState<string | null>(null);` next to the existing `pending` state (~line 82). (2) Change `decideAction` (line 143) to guard and wrap: `if (!tenantId || deciding) return; setDeciding(actionId); setError(null); try { …existing body lines 149-186… } catch { setError(t("common.apiUnreachable")); } finally { setDeciding(null); }` — the `common.apiUnreachable` key already exists in EN+SW (packages/i18n/src/index.ts:43, 800) and the error strip already renders at line 347. (3) Pass lockout props to both PillButtons at lines 300-315: `loading={deciding === action.actionId}` and `disabled={deciding !== null}` — PillButton already blocks presses and renders an ActivityIndicator for either prop (pill-button.tsx:40,45,70). Optionally, on catch, set the outcome to a retryable state rather than leaving the card untouched, since a lost response on an executed action currently yields a misleading "failed" on retry. Apply the same three changes to apps/web/src/app/assistant/assistant-view.tsx (decideAction at :105, buttons at :216-225), which has the identical gap.

---

### 27. Finance tab and dashboard download the tenant's entire payments table over cellular on every mount and pull-to-refresh

- **Location:** `apps/mobile/src/app/(tabs)/finance.tsx:72`
- **Category:** performance · **Verdict:** CONFIRMED (high) · **Found by:** mobile-i18n

**What is wrong.** `fetchAllRows` loops `.range()` over `public.payments` filtered only by `tenant_id`, with no date or invoice bound, purely to compute paid-to-date for the 200 most recent invoices. The same unbounded loop runs on the dashboard for the current month.

**How it fails.** A 1,200-student school two years into using ATLAS has roughly 30,000 payment rows. A bursar opens the Finance tab on a 3G/EDGE connection: `fetchAllRows` issues 30 strictly sequential PostgREST requests of 1,000 rows each (the loop only stops when a page returns fewer than 1000). On a link with 800 ms round-trips and frequent stalls the tab shows skeletons for minutes, frequently never resolves, and any single failed page silently yields `data ?? []` — producing a short page that ends the loop early and renders every invoice as unpaid (full balance owed, `loss`-red) with no error shown. Every pull-to-refresh repeats the whole download.

**Evidence.**

```
src/app/(tabs)/finance.tsx:72-78 — `fetchAllRows<{ invoice_id: string; amount: number }>((from, to) => supabase.from("payments").select("invoice_id, amount").eq("tenant_id", tenantId).range(from, to))` — no other filter, while the invoice query beside it is `.limit(200)`.
src/app/(tabs)/finance.tsx:32-44 — `const { data } = await build(from, from + pageSize - 1); const page = data ?? []; ... if (page.length < pageSize) break;` — a failed page is indistinguishable from the last page.
src/app/(tabs)/dashboard.tsx:95-102 — the same unbounded loop over `payments` for the month.
```

**Fix.** Primary fix — `/Users/admin/Atlas-System/apps/mobile/src/app/(tabs)/finance.tsx`:

1. Delete the separate payments read (lines 72-78) and the local `fetchAllRows` (lines 31-44). Bound the payments to the 200 invoices actually rendered by embedding them on the invoice query (the same embed shape `apps/api/src/finance/finance.controller.ts:225` already uses), turning ~30 sequential full-table pages into one bounded request:

```ts
const { data: invoices, error: invError } = await supabase
  .from("invoices")
  .select("id, invoice_number, total, status, students(first_name, last_name, student_number), payments(amount)")
  .eq("tenant_id", tenantId)
  .order("created_at", { ascending: false })
  .limit(200);
if (invError) throw invError;
```
Then set `paid: (inv.payments ?? []).reduce((s, p) => s + Number(p.amount), 0)` in the map at line 110, and add `payments: { amount: number }[] | null` to the local `InvoiceRow` type (lines 90-100). The `.limit(200)` applies to top-level rows only, so the embed does not reintroduce an unbounded read. If you prefer not to change the query shape, the minimum acceptable bound is a second call after the invoices resolve: `.in("invoice_id", invoices.map(i => i.id))` (gives up the `Promise.all` parallelism but is still one request).

2. Stop treating a failed page as end-of-list, in every surviving copy of the helper — `apps/mobile/src/app/(tabs)/dashboard.tsx:41-53`, `apps/web/src/app/page.tsx:46-58`, `apps/web/src/app/finance/page.tsx:33-43` (all four are byte-identical). Change `const { data } = await build(...)` to `const { data, error } = await build(...); if (error) throw error;`. postgrest-js does not reject on network failure, so without this the caller cannot distinguish a truncated download from a complete one and renders wrong money. In `finance.tsx` and `dashboard.tsx` the surrounding `try/catch` already sets the error state, so the throw is enough to surface it.

3. Add a deterministic sort key to any `.range()` loop that remains — `.order("id")` (or `created_at`) before `.range(from, to)` in `dashboard.tsx:95-102` and both web copies. OFFSET pagination with no ORDER BY has no stable row order in Postgres, so multi-page sums can double-count or drop payments.

Optional follow-up, matching the repo's iron rule: expose a `GET /finance/invoices` endpoint (or a `public.*` wrapper over the existing `app.report_debtors` / aged-receivables SQL) returning invoice + paid per row, and have mobile call it via `apiFetch` instead of aggregating money client-side at all.

---

### 28. Supabase session (long-lived refresh token) is persisted in plaintext AsyncStorage although expo-secure-store is installed and configured

- **Location:** `apps/mobile/src/lib/supabase.ts:19`
- **Category:** security · **Verdict:** CONFIRMED (high) · **Found by:** mobile-i18n

**What is wrong.** The Supabase auth client stores the session — including the long-lived refresh token — in AsyncStorage, which on Android is an unencrypted SQLite file in the app sandbox and on iOS an unencrypted plist. `expo-secure-store` is already a dependency and is declared as an app.json plugin, but is never used.

**How it fails.** A school owner's Android phone is rooted, stolen and re-flashed, or backed up. An attacker reads `/data/data/com.atlasschool.mobile/databases/RKStorage` (or the iOS app container plist) and extracts the JSON blob under the `sb-<project>-auth-token` key, which contains `refresh_token` in clear text. Because `autoRefreshToken: true`, that refresh token mints fresh access tokens indefinitely without the password — the attacker then calls the ATLAS API as the school owner (a SUPER_ROLE that bypasses permission checks per tenant.guard.ts) and can read every student record and post payments. The same file is readable by any other app running as root, and by `adb backup` on devices where the app allows backup.

**Evidence.**

```
src/lib/supabase.ts:1 `import AsyncStorage from "@react-native-async-storage/async-storage";`
src/lib/supabase.ts:14-24 — `export const supabase = createClient(url, anonKey, { auth: { storage: typeof window === "undefined" ? undefined : AsyncStorage, autoRefreshToken: true, persistSession: typeof window !== "undefined", detectSessionInUrl: false } });`
apps/mobile/package.json:23 `"expo-secure-store": "~57.0.1"` and app.json:39 `"expo-secure-store"` in `plugins` — installed and configured, but `grep -rn "expo-secure-store" apps/mobile/src` returns nothing.
```

**Fix.** Add a SecureStore-backed storage adapter and pass it as `auth.storage` in /Users/admin/Atlas-System/apps/mobile/src/lib/supabase.ts.

1. New file `apps/mobile/src/lib/secure-storage.ts` exporting `{ getItem, setItem, removeItem }`:
   - Import `* as SecureStore from "expo-secure-store"` and `Platform` from react-native.
   - MUST branch on platform, not on `window`: `Platform.OS === "web"` → fall back to AsyncStorage (expo-secure-store throws UnavailabilityError on web, and expo-router's web target is still built here); native → SecureStore.
   - MUST chunk. SecureStore warns/fails above 2048 bytes per value and a Supabase session JSON (two JWTs + user object) routinely exceeds that. Store `${key}__n` = chunk count plus `${key}__0..n-1` slices of ~1800 chars; `getItem` reads the count then concatenates; `removeItem` deletes the count key and every chunk. (Alternative, matching Supabase's documented `LargeSecureStore`: keep an AES key in SecureStore and the ciphertext in AsyncStorage — only worth it if you want to avoid chunking, and it adds an `aes-js` dependency.)
   - Set `keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK` on iOS writes so `autoRefreshToken` still works when the app refreshes in the background.

2. In `supabase.ts`, replace line 19 `storage: typeof window === "undefined" ? undefined : AsyncStorage` with `storage: typeof window === "undefined" ? undefined : secureStorage` and drop the now-unused AsyncStorage import there. Leave `persistSession`, `autoRefreshToken`, `detectSessionInUrl` and the AppState start/stopAutoRefresh block unchanged.

3. Leave `apps/mobile/src/lib/i18n.tsx` (the `atlas-lang` preference) on AsyncStorage — non-sensitive, and SecureStore is a poor fit for it.

4. One-time migration is unnecessary since the app is pre-release; any existing dev session simply won't be found and the user re-logs in. If you want zero friction, have `getItem` fall back to a one-shot AsyncStorage read + re-write into SecureStore + AsyncStorage.removeItem.

Verify with `pnpm --filter @atlas/mobile typecheck lint` and an `expo export` (the turbo gate already covers mobile lint/typecheck), then log in on a device and confirm the session survives a cold start.

---

### 29. AI action Confirm gives zero feedback and swallows network failures — the school can't tell whether a payment was recorded

- **Location:** `apps/web/src/app/assistant/assistant-view.tsx:105`
- **Category:** error-handling · **Verdict:** CONFIRMED (high) · **Found by:** web-correctness

**What is wrong.** `decideAction` has no pending state, does not disable the Confirm/Reject buttons while in flight, and has no try/catch, so a network failure during a money-moving confirm leaves the card looking untouched with no error at all.

**How it fails.** A director asks Ask ATLAS to record a 400,000 TZS M-Pesa payment; the assistant returns a propose card. The director taps Confirm. The API is reached and `ai-actions.service.ts` atomically claims the proposal and runs the payment RPC, but the response never comes back (connection drops). `await apiFetch(...)` at line 110 rejects; there is no catch, so nothing is set — no outcome badge, no error, and the Confirm/Reject buttons are still enabled and unchanged (they are only replaced once `action.outcome` is truthy, line 212). The director assumes the tap didn't register and taps Confirm again. The second call finds `status != 'proposed'`, throws ACTION_NOT_CONFIRMABLE, and the card renders a red "Failed: Something went wrong (ACTION_NOT_CONFIRMABLE)" badge for a payment that DID post to the immutable ledger. The bursar then records it manually — a duplicate receipt against an immutable journal that can only be undone by a reversal.

**Evidence.**

```
apps/web/src/app/assistant/assistant-view.tsx:105-124 — no pending flag, no try/catch:
```
	async function decideAction(messageIndex, actionId, decision) {
		const res = await apiFetch(`/api/v1/ai/actions/${actionId}/${decision}`, {
			method: "POST",
			tenantId,
		});
		const body = (await res.json().catch(() => null)) as {...} | null;
```
Buttons never disabled — assistant-view.tsx:212-227:
```
										{!action.outcome ? (
											<div className="mt-2.5 flex gap-2">
												<Button size="sm" onClick={() => void decideAction(i, action.actionId, "confirm")}>
```
Server side confirms the single-shot claim that turns click #2 into a hard failure — apps/api/src/ai/ai-actions.service.ts:2315-2327 (`.update({status:'executing'}).eq('status','proposed')` → `throw new Error('ACTION_NOT_CONFIRMABLE')` when zero rows match). Note `send()` at assistant-view.tsx:73-102 has the same missing catch.
```

**Fix.** In `/Users/admin/Atlas-System/apps/web/src/app/assistant/assistant-view.tsx`, make `decideAction` follow the house pattern already used in `apps/web/src/app/finance/[id]/invoice-view.tsx:289-314`:

1. Add in-flight state next to the other hooks (~line 59): `const [deciding, setDeciding] = useState<string | null>(null);`
2. Wrap the body of `decideAction` (lines 105-137). Guard re-entry, set the flag, and add catch/finally:
   - at the top: `if (deciding) return; setDeciding(actionId);`
   - wrap the `apiFetch` + `res.json()` + outcome computation in `try { ... }`
   - `catch { outcome = { status: "unknown", error: t("common.apiUnreachable") }; }` — reuse the existing key (`packages/i18n/src/index.ts:43` EN / `:800` SW); do NOT reuse `status:"failed"`, so the badge is not a red "Failed" for something that may have posted.
   - `finally { setDeciding(null); }`, and move the `setMessages(...)` update so it runs for both paths.
3. Disable both buttons while in flight (lines 214-226): add `disabled={deciding !== null}` to the Confirm and Reject `<Button>`s.
4. Render the new `unknown` status in the outcome block (after line 251) as a non-destructive warning badge, e.g. `variant="outline"` with a new EN+SW key such as `assistant.outcomeUnknown` = "Couldn't confirm the result — check Finance before retrying." (add to both dictionaries in `packages/i18n/src/index.ts`, keys mirrored).
5. Same two-line hardening for `send()` (lines 73-102): add `catch { setError(t("common.apiUnreachable")); }` before the existing `finally`.
6. Apply the identical change to `apps/mobile/src/app/(tabs)/assistant.tsx:146-171` (same missing pending flag / catch, same `common.apiUnreachable` key is available via the shared `packages/i18n`).

---

### 30. Communication page SMS counters are computed over an arbitrary 1000-row slice and go permanently wrong

- **Location:** `apps/web/src/app/communication/page.tsx:39`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** data-integrity-perf

**What is wrong.** The page reads the entire notification_outbox for the tenant with no limit, no order and no aggregation, then tallies pending/sent/failed in JS — PostgREST truncates the response at 1000 rows, so once a school's outbox exceeds 1000 rows the displayed SMS queue status is a lie.

**How it fails.** A 1500-student school runs for one month: absence alerts (≈5% absent × 1500 × 20 school days ≈ 1,500 outbox rows) plus one all-school announcement (≈1,200 rows) already puts the table past 1,000 rows for that tenant, and it only ever grows — nothing in apps/api or apps/workers deletes outbox rows. From then on the read returns an arbitrary, unordered 1,000 rows, which will be dominated by old `sent` rows. The head teacher sends an urgent all-school SMS, the outbox has 1,200 pending rows because the SMS provider is down, and the Communication page shows `pending: 0, sent: 1000, failed: 0`. Nobody learns the messages never went out.

**Evidence.**

```
apps/web/src/app/communication/page.tsx:39 and 47-52
```tsx
		supabase.from("notification_outbox").select("status").eq("tenant_id", tenantId),
...
	const stats: OutboxStats = { pending: 0, sent: 0, failed: 0 };
	for (const row of outbox ?? []) {
		if (row.status === "pending") stats.pending += 1;
		else if (row.status === "sent") stats.sent += 1;
		else if (row.status === "failed") stats.failed += 1;
	}
```
supabase/config.toml `max_rows = 1000` caps the response. The AI tool catalogue avoids exactly this mistake elsewhere (apps/api/src/ai/ai-tools.service.ts:65-66: "never fetch student rows and tally in JS (the Supabase 1000-row cap would silently truncate large schools)").
```

**Fix.** Two changes.

1. `/Users/admin/Atlas-System/apps/web/src/app/communication/page.tsx` — stop fetching rows. Drop the `notification_outbox` entry from the `Promise.all` at line 39 and the JS tally at lines 47-52, and replace with three head counts (same pattern as `apps/api/src/health/health.controller.ts:130-140`):

```ts
const [pending, sent, failed] = await Promise.all(
  (["pending", "sent", "failed"] as const).map((s) =>
    supabase
      .from("notification_outbox")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("status", s),
  ),
);
const stats: OutboxStats = {
  pending: pending.count ?? 0,
  sent: sent.count ?? 0,
  failed: failed.count ?? 0,
};
```

`count: 'exact'` is computed server-side and is not subject to `max_rows`, so it stays correct past 1000 rows. (RLS `"members read outbox"` from migration 0008 already permits this, so no policy change is needed.)

2. New additive migration (next free number, `00000000000029_*.sql`) adding the index the counts need — there is currently no index on `tenant_id` at all, so today's query is a seq scan on every page render:

```sql
create index if not exists notification_outbox_tenant_status_idx
  on public.notification_outbox (tenant_id, status);
```

Optional follow-up, not required for correctness: the same JS-tally pattern should be checked in any other web page that reads an unbounded per-tenant table without `count`/`range`.

---

### 31. Tenant resolution ignores status and there is no switcher, so one archived school permanently locks a user out of their live school

- **Location:** `apps/web/src/app/finance/page.tsx:23`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** gap:tenant suspension / offboarding / data deletion (RLS layer never checks tenant status; no purge or export exists)

**What is wrong.** All 28 web tenant-resolution sites plus `AppShell` and the mobile auth provider pick the OLDEST tenant/membership with `.order("created_at", { ascending: true }).limit(1)` and no `status` filter, and no tenant switcher exists. If a user belongs to an archived or suspended tenant that predates their current one, every page renders the dead school and every mutation 403s with TENANT_ARCHIVED / TENANT_SUSPENDED, with no way to reach the live school.

**How it fails.** A school runs onboarding twice — a trial tenant created in March that support later archives, and the real tenant created in May. The owner's account holds active memberships in both. They open /attendance: `apps/web/src/app/attendance/page.tsx:29` resolves the March (archived) tenant because it is oldest, renders its empty roster, and passes that tenantId to the view. Ticking the register calls `apiFetch(..., { tenantId })` (apps/web/src/lib/api.ts:22 sets `x-tenant-id`), TenantGuard reads `entitlements.tenantStatus === 'archived'` (tenant.guard.ts:108-110) and throws 403 TENANT_ARCHIVED. Same on /finance, /assessments, /students. The teacher cannot take attendance, save marks or record a payment in the school that is actually paying, and there is no UI to switch schools — `grep -rln "switch" apps/web/src/components` returns only `app-header.tsx` (the language switcher). Identical on mobile: `apps/mobile/src/lib/auth.tsx:48-54` takes the oldest active membership regardless of `tenants.status`. Recovery requires a platform admin to reactivate the dead tenant or a DBA to delete the old membership row.

**Evidence.**

```
apps/web/src/app/finance/page.tsx:22-27
```ts
	const { data: tenants } = await supabase
		.from("tenants")
		.select("id, name")
		.order("created_at", { ascending: true })
		.limit(1);
```
Identical pattern at students/page.tsx:17-20, parents/page.tsx:17-20, admissions, hostel, clinic, payroll, accounting, timetable, reports, staff, imports, communication, library, inventory, transport, academics, assistant, settings, assessments (+[id]), finance/[id], finance/debtors, students/[id]/report-card, onboarding, page.tsx:21-24 and components/app-shell.tsx:21-24 — 28 sites, none filtering `status`.
apps/web/src/app/page.tsx:22 even selects `"id, name, status"` and then never branches on it.
apps/mobile/src/lib/auth.tsx:48-54 `.select("tenant_id, status, created_at, tenants(id, name, slug, status)").eq("user_id", user.id).eq("status", "active").order("created_at", { ascending: true }).limit(1)` — `.eq("status",…)` is the *membership* status; `tenants.status` is stored on `TenantInfo` (auth.tsx:69) and never read (`grep -rn "tenant\.status" apps/mobile/src` → no hits).
```

**Fix.** Minimal fix is the status filter, not the whole switcher. 1) Add apps/web/src/lib/tenant.ts with a shared `resolveActiveTenant(supabase, columns)` that runs `.from("tenants").select(columns).neq("status","archived").order("created_at",{ascending:true}).limit(1)` (excluding only 'archived' keeps a suspended paying school visible so its owner still sees a banner and read-only data instead of vanishing), and swap all 28 call sites plus components/app-shell.tsx:20-25 onto it — start with the cited apps/web/src/app/finance/page.tsx:22-26. 2) apps/web/src/app/onboarding/page.tsx:19-26 must use the same filtered query, so a user whose only tenant was archived (including via the onboarding.controller.ts:99-107 rollback) can re-onboard instead of being bounced to "/" forever. 3) apps/mobile/src/lib/auth.tsx resolveTenant(): add `.neq("tenants.status","archived")` or drop rows whose row.tenants.status === 'archived' before returning, since tenants.status is already selected and stored on TenantInfo but never read. 4) When the only membership left is archived/suspended, render an explicit state using the existing keys err.tenantArchived / err.tenantSuspended (apps/web/src/lib/api-error.ts:18-19) rather than silently rendering a dead school. The interactive switcher (AUD-012 / TESTING_GUIDE section 6.2) remains a separate, already-tracked piece of work and is not required to close this lockout.

---

### 32. Statutory-rates dialog reads/writes a shape the API never returns or accepts — crashes on open, rates can never be edited or verified

- **Location:** `apps/web/src/app/payroll/payroll-view.tsx:982`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** payroll-necta-domain

**What is wrong.** GET /payroll/settings returns the raw jsonb from the DB (snake_case: paye_bands / nssf_employee_rate / heslb_rate / employer{...}) but the web StatutoryRatesDialog is typed and coded against a camelCase shape (payeBands / nssfEmployee / nssfEmployer / heslb / wcf / sdl), so it dereferences `rates.payeBands` on `undefined` and, even if guarded, PUTs a body that fails the API zod schema.

**How it fails.** A bursar at a live school runs payroll once (which seeds payroll_settings with app.payroll_default_rates()), then clicks "Statutory rates" to check the PAYE bands against TRA. GET /api/v1/payroll/settings returns `{rates:{paye_bands:[{up_to:270000,rate:0},…],nssf_employee_rate:0.1,heslb_rate:0.15,employer:{…}},verifiedAt:null}`. `rates` is truthy so the component renders the band table and evaluates `rates.payeBands.map(...)` → `TypeError: Cannot read properties of undefined (reading 'map')`, which escapes to the Next.js error boundary and blanks the payroll page. If that crash is patched, `save()` PUTs `{rates:{payeBands:[…],nssfEmployee:0.1,…},verified:true}`; payrollRatesSchema requires `paye_bands`, `nssf_employee_rate`, `heslb_rate` and `employer`, so the API answers 400 PAYROLL_SETTINGS_INVALID. Net effect: the school can never correct a PAYE band after a Finance Act change and can never satisfy the `verified_at` gate the migration says must be met "before first live payroll" — every payslip is produced from unverified, uneditable defaults.

**Evidence.**

```
apps/web/src/app/payroll/payroll-view.tsx:84-91 — `interface StatutoryRates { payeBands: PayeBand[]; nssfEmployee: number; nssfEmployer: number; heslb: number; wcf: number; sdl: number; }` with `interface PayeBand { from: number; rate: number; }` (line 79-82).
apps/web/src/app/payroll/payroll-view.tsx:982 — `{rates.payeBands.map((band, i) => (`
apps/web/src/app/payroll/payroll-view.tsx:924 — `body: JSON.stringify({ rates, verified: true }),`
apps/api/src/payroll/payroll.controller.ts:409-413 — `return { rates: row?.rates ?? null, verifiedAt: row?.verified_at ?? null, verifiedBy: row?.verified_by ?? null };` (no camelCase mapping at all)
supabase/migrations/00000000000025_payroll.sql:133-148 — `jsonb_build_object('paye_bands', jsonb_build_array(jsonb_build_object('up_to', 270000, 'rate', 0), …), 'nssf_employee_rate', 0.10, 'heslb_rate', 0.15, 'employer', jsonb_build_object('nssf_rate',0.10,'wcf_rate',0.005,'sdl_rate',0.035))`
apps/api/src/payroll/payroll.schema.ts:23-35 — `payeBandSchema = z.object({ up_to: …, rate: … })`, `payrollRatesSchema = z.object({ paye_bands, nssf_employee_rate, heslb_rate, employer })`
```

**Fix.** Minimal fix, one file — make the web speak the DB/API contract instead of inventing a camelCase one (avoids touching payroll.schema.ts, app.update_payroll_settings, and app.compute_paye, which all read up_to/paye_bands).

In apps/web/src/app/payroll/payroll-view.tsx:
1. Retype to the wire shape (lines 79-91): `interface PayeBand { up_to: number | null; rate: number }` and `interface StatutoryRates { paye_bands: PayeBand[]; nssf_employee_rate: number; heslb_rate: number; employer: { nssf_rate: number; wcf_rate: number; sdl_rate: number } }`.
2. Update every dereference: line 909/912 `prev.paye_bands.map(...)` -> `{ ...prev, paye_bands }`; line 982 `rates.paye_bands.map(...)`; line 986/993 `patchBand(i, "up_to"|"rate", ...)` with `value={band.up_to ?? ""}` (the top band's null must stay null — treat empty input as null, not 0, or the top bracket silently caps taxable income); lines 1011-1032 `patchRate` for `nssf_employee_rate` / `heslb_rate` and a separate `patchEmployer` for `employer.nssf_rate` / `wcf_rate` / `sdl_rate` (nssfEmployer/wcf/sdl are nested, not top-level).
3. Fix the inverted label: replace the `payroll.settings.payeFrom` header with a new `payroll.settings.payeUpTo` key ("Up to" / "Hadi") in packages/i18n/src/index.ts, EN + SW mirrored — the stored value is the band ceiling.
4. Restore the "UI shows defaults" behaviour the controller comment promises: when `body.rates` is null, seed local state with the same defaults as app.payroll_default_rates() so a bursar can verify rates before the first run (otherwise line 1040 still hides the save button and rates can never be created).

Then add a settings assertion to apps/api/scripts/smoke-payroll.mjs: GET /payroll/settings after a run, PUT the returned rates back with `verified: true`, assert 200 and that verified_at is non-null — a round-trip test that would have caught this and will catch the next contract drift.

Optional hardening (not required for the fix): tighten payrollRatesSchema's `employer: z.record(z.string(), z.number())` to an explicit object with nssf_rate/wcf_rate/sdl_rate so a wrong-shaped employer object is rejected by name rather than passing through.

---

### 33. Rate inputs are labelled "%" but the stored values are fractions, and no upper bound is enforced anywhere

- **Location:** `apps/web/src/app/payroll/payroll-view.tsx:1010`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** payroll-necta-domain

**What is wrong.** The settings dialog renders NSSF/HESLB/WCF/SDL and each PAYE band rate under labels ending in "(%)" while the values are fractions (0.10, 0.15, 0.08) that run_payroll multiplies directly by gross. Neither payrollRatesSchema nor update_payroll_settings caps a rate at 1, so a percent-shaped entry produces a 10x-100x deduction.

**How it fails.** Once the shape bug above is fixed, a bursar opens "Statutory rates", sees `0.1` in a field labelled "NSSF employee (%)", assumes it is a typo and types `10`. zod accepts it (`z.number().nonnegative()`, no max) and the RPC accepts it. The next run computes nssf = 10 * gross: for basic 600,000 + allowances 50,000, nssf = 6,500,000, PAYE base = 650,000 - 6,500,000 = -5,850,000 → compute_paye returns 0 via greatest(), net = 650,000 - 0 - 6,500,000 = -5,850,000. The draft renders a payslip showing a negative net with no warning. When she clicks "Post to ledger", post_payroll builds a debit of 1,850,000 against credits of 6,500,000+ (the negative net line is skipped by `if v_net > 0`), app.post_journal raises LEDGER_UNBALANCED_ENTRY, and because that code is not in postRun's known-codes list the bursar gets an opaque HTTP 500 `PAYROLL_RPC_FAILED` with no way to diagnose it.

**Evidence.**

```
apps/web/src/app/payroll/payroll-view.tsx:1009-1013 — `<RateField label={t("payroll.settings.nssf")} onChange={(v) => patchRate("nssfEmployee", v)} value={rates.nssfEmployee} />`
packages/i18n/src/index.ts:690 — `"payroll.settings.nssf": "NSSF employee (%)",` (also 689 `"payroll.settings.payeRate": "Rate (%)"`, 692-694 heslb/wcf/sdl "(%)")
apps/api/src/payroll/payroll.schema.ts:31-33 — `nssf_employee_rate: z.number().nonnegative(), heslb_rate: z.number().nonnegative(), employer: z.record(z.string(), z.number()),` (no max)
supabase/migrations/00000000000025_payroll.sql:302,311 — `v_nssf := round(v_gross * v_nssf_rate, 2);` … `v_net := v_gross - v_paye - v_nssf - v_heslb;` (no floor at 0)
apps/api/src/payroll/payroll.controller.ts:327-332 — known codes list omits `LEDGER_UNBALANCED_ENTRY`, so the imbalance surfaces as a 500.
```

**Fix.** Four minimal changes; the first two are the load-bearing ones.

1. Bound the rates in zod — `apps/api/src/payroll/payroll.schema.ts:24-35`:
   - `payeBandSchema`: `rate: z.number().min(0).max(1)`
   - `nssf_employee_rate: z.number().min(0).max(1)`, `heslb_rate: z.number().min(0).max(1)`
   - `employer: z.record(z.string(), z.number().min(0).max(1))` (currently accepts negatives too)
   - Fix the now-false comment above it ("the RPC validates the shape ... on bad values").

2. Bound them in the RPC too (API is not the only caller of the wrapper) — since 0016-0028 are unapplied, amend `supabase/migrations/00000000000025_payroll.sql` in place; if they have been applied by then, add `00000000000029_payroll_rate_bounds.sql` with `create or replace`:
   - In `app.update_payroll_settings` (line 532), after the existing paye_bands check, reject any rate outside [0,1]:
     `if exists (select 1 from jsonb_array_elements(p_rates->'paye_bands') b where (b->>'rate')::numeric < 0 or (b->>'rate')::numeric > 1) or (p_rates->>'nssf_employee_rate')::numeric not between 0 and 1 or (p_rates->>'heslb_rate')::numeric not between 0 and 1 or exists (select 1 from jsonb_each_text(coalesce(p_rates->'employer','{}'::jsonb)) e where e.value::numeric not between 0 and 1) then raise exception 'PAYROLL_SETTINGS_INVALID'; end if;`
   - In `app.run_payroll`, right after line 311 (`v_net := ...`): `if v_net < 0 then raise exception 'PAYROLL_NEGATIVE_NET'; end if;` so a bad rate fails at draft time instead of producing a negative payslip.

3. Stop the opaque 500 — `apps/api/src/payroll/payroll.controller.ts`:
   - line 327 (postRun): add `'LEDGER_UNBALANCED_ENTRY'` and `'LEDGER_UNKNOWN_ACCOUNT'` to the known-codes array.
   - line 222 (createRun): add `'PAYROLL_NEGATIVE_NET'`.
   - Add EN+SW keys for both new codes in `packages/i18n/src/index.ts` (keep the two key sets mirrored).

4. Kill the unit trap — fix together with the snake_case↔camelCase mapping in `apps/web/src/app/payroll/payroll-view.tsx` (map `paye_bands/up_to → payeBands/from`, `nssf_employee_rate → nssfEmployee`, `heslb_rate → heslb`, `employer.{nssf_rate,wcf_rate,sdl_rate} → nssfEmployer/wcf/sdl`, and invert on save). Then either display `value*100` and divide by 100 on save (keeping the "(%)" labels, and set `max="100"` on the Input), or keep fractions and change `packages/i18n/src/index.ts:689-694` + the SW mirror at `:1446-1451` to e.g. "NSSF employee (fraction of gross, 0.10 = 10%)" with `max="1"` on `RateField`/band inputs. Do not fix the shape mapping without doing this — that is exactly the state in which the 10x-100x entry becomes reachable.

Finally, extend `apps/api/scripts/smoke-payroll.mjs` to PUT `/payroll/settings` (a valid round-trip plus a rejected out-of-range rate) — the endpoint has no smoke coverage today.

---

### 34. A dropped connection leaves eight module pages showing a loading skeleton forever — no error, no retry

- **Location:** `apps/web/src/app/payroll/payroll-view.tsx:128`
- **Category:** error-handling · **Verdict:** CONFIRMED (high) · **Found by:** web-correctness

**What is wrong.** Every module view's initial `reload()` awaits apiFetch with no try/catch; a network-level rejection never sets `loadError` and never flips `loaded`, so the page renders <ListSkeleton> permanently while the rejection is swallowed into an unhandled promise.

**How it fails.** A bursar on a Vodacom mobile connection in Mwanza opens /payroll. The connection blips and `fetch` rejects with TypeError: Failed to fetch (not an HTTP status — the `!response.ok` branch is never reached). `void reload()` in the effect rejects unhandled; `setLoaded(true)` never runs. The user stares at an animated grey skeleton indefinitely. There is no error message, no retry button, and pull-to-refresh is their only recourse — the same happens on /library, /hostel, /inventory, /transport, /clinic, /timetable and /staff.

**Evidence.**

```
apps/web/src/app/payroll/payroll-view.tsx:128-150 (no try/catch anywhere in reload):
```
	const reload = useCallback(async () => {
		const [salariesRes, runsRes] = await Promise.all([
			apiFetch("/api/v1/payroll/salaries", { tenantId }),
			apiFetch("/api/v1/payroll/runs", { tenantId }),
		]);
		if (!salariesRes.ok || !runsRes.ok) { ... setLoaded(true); return; }
		...
		setLoaded(true);
	}, [tenantId, t]);

	useEffect(() => { void reload(); }, [reload]);
```
and the render gate at payroll-view.tsx:254 `{!loaded && !loadError ? <ListSkeleton .../> : ...}`.
Identical pattern: library-view.tsx:102-124, hostel-view.tsx:95-112, inventory-view.tsx:69-85, transport-view.tsx:75-91, clinic-view.tsx:70-90, timetable-view.tsx:119-140, staff-view.tsx:63-84. Contrast accounting-view.tsx:55-73, which DOES wrap in try/catch/finally and offers a Retry button — so the correct pattern already exists in this codebase.
```

**Fix.** Mirror the existing correct pattern from apps/web/src/app/accounting/accounting-view.tsx:55-73 in each of the eight reload callbacks. Concretely, in apps/web/src/app/payroll/payroll-view.tsx:128-144, apps/web/src/app/library/library-view.tsx:102-124, apps/web/src/app/hostel/hostel-view.tsx:95-111, apps/web/src/app/inventory/inventory-view.tsx:69-86, apps/web/src/app/transport/transport-view.tsx:75-90, apps/web/src/app/clinic/clinic-view.tsx:70-89, apps/web/src/app/timetable/timetable-view.tsx:119-138 and apps/web/src/app/staff/staff-view.tsx:63-83: wrap the entire existing body in `try { ...existing... } catch { setLoadError(t("common.apiUnreachable")); } finally { setLoaded(true); }` and delete the now-redundant `setLoaded(true)` calls inside the try (the finally covers every exit, including the `!response.ok` early return). Both i18n keys already exist EN+SW so no packages/i18n change is needed. Then add a retry affordance to the error branch — in the views whose gate is `{!loaded && !loadError ? <ListSkeleton/> : ...}` add an `: loadError ? (<div className="flex flex-col items-center gap-3 py-6"><p className="text-center text-sm text-destructive">{loadError}</p><Button onClick={() => void reload()} size="sm" variant="outline">{t("common.retry")}</Button></div>)` arm copied from accounting-view.tsx:97-102; in payroll-view.tsx the standalone `{loadError && <p ...>{loadError}</p>}` at line 246 should gain the same Retry button. In timetable-view.tsx also guard the early `if (!teacherMode && !sectionId) return;` at line 120 so it does not leave `loaded` false on a legitimate no-selection state. Optionally, factor this into a shared `useApiResource` hook in apps/web/src/lib/ so future module views cannot repeat the omission — but do NOT move the catch into apiFetch itself, since swallowing the rejection there would hide network failures from every caller.

---

### 35. Parent portal: a failed report-card fetch permanently disables the "View report" button

- **Location:** `apps/web/src/app/portal/portal-view.tsx:108`
- **Category:** error-handling · **Verdict:** CONFIRMED (high) · **Found by:** web-correctness

**What is wrong.** `loadReport` calls `setLoading(false)` after the await with no try/catch, so any network rejection leaves `loading === true` forever, permanently disabling the only button on the card with no error shown.

**How it fails.** A parent in Dodoma opens /portal on 3G, picks Term 2 for their child and taps "View report". The request rejects at the network layer. `setLoading(false)` at line 115 is never reached, so the button stays `disabled` and stuck reading "Loading…" (t("common.loading")) forever; `error` is never set. The parent cannot see the report card and has no way back except a full page reload — and this repeats on every attempt if the link is flaky. The initial `PortalView` effect at lines 61-77 has the same defect: `children` stays null and the whole page shows "Loading…" with nothing else.

**Evidence.**

```
apps/web/src/app/portal/portal-view.tsx:108-122
```
	async function loadReport() {
		if (!termId) return;
		setLoading(true);
		setError(null);
		const response = await apiFetch(
			`/api/v1/portal/children/${child.studentId}/report-card?termId=${termId}`,
		);
		setLoading(false);
		...
	}
```
button at line 169-176: `disabled={loading || !termId}` … `{loading ? t("common.loading") : t("portal.viewReport")}`.
Initial load, lines 61-77: `void (async () => { const response = await apiFetch("/api/v1/portal/children"); ... })()` — no catch, and `if (!children) return <p>{t("common.loading")}</p>` at line 89.
```

**Fix.** In apps/web/src/app/portal/portal-view.tsx, adopt the codebase's existing pattern (see apps/web/src/app/finance/finance-view.tsx:229-240).

1) loadReport (lines 108-122) — wrap the fetch and move the loading reset into finally:

  async function loadReport() {
    if (!termId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch(
        `/api/v1/portal/children/${child.studentId}/report-card?termId=${termId}`,
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(apiErrorMessage(t, body, response.status));
        return;
      }
      setReport(await response.json());
    } catch {
      setError(t("common.apiUnreachable"));
    } finally {
      setLoading(false);
    }
  }

2) The PortalView effect (lines 61-77) — wrap the body in try/catch and add `catch { setError(t("common.apiUnreachable")); }` so the page shows a retryable message instead of a permanent "Loading…". Keep the PORTAL_NOT_LINKED sentinel branch as-is.

3) Same fix in the only other apiFetch view missing a try block: apps/web/src/app/students/[id]/report-card/report-card-view.tsx lines 80-90 (setLoading(false) at line 87 is likewise on the straight-line path).

No new i18n keys are needed — common.apiUnreachable already exists in EN and SW at packages/i18n/src/index.ts:43 and :800.

---

### 36. 30-day trial ends in a hard write-lock with zero tenant-facing warning, counter, or self-serve path

- **Location:** `apps/web/src/components/app-shell.tsx:36`
- **Category:** product-gap · **Verdict:** CONFIRMED (high) · **Found by:** gap:tenant-facing subscription/entitlement surface (schools are blind to their own trial and limits)

**What is wrong.** Every new tenant gets a 30-day trial that silently flips the whole product read-only on day 31, and there is no endpoint, banner, counter or usage meter anywhere in the school-facing web or mobile app that tells the school its trial is ending.

**How it fails.** A school onboards on 1 March (onboarding.controller.ts:96 sets trial_ends_at = now + 30d). Nothing in the product ever mentions this date. On 31 March at 07:50 a teacher opens /attendance, marks the register and presses Save: apiFetch POSTs /api/v1/attendance, TenantGuard evaluates trialExpired and throws 403 {code:'SUBSCRIPTION_EXPIRED'}. The same second, marks entry (POST /assessments/:id/scores), fee payments (POST /finance/...), staff invites and POST /ai/chat all fail. The GET pages still render, so the school sees a working app in which every Save button fails. The only tenant-facing surface that exposes plan/trial data at all is the AI tool getSubscriptionUsage (ai-tools.service.ts:486-500), and it is only reachable through POST /ai/chat — which the same guard blocks — so on day 31 the owner cannot even ask ATLAS why saving stopped.

**Evidence.**

```
apps/web/src/components/app-shell.tsx:27-41 renders the whole school-facing shell and mounts only `{tenantId && <AssistantLauncher lang={lang} tenantId={tenantId} />}` — no subscription/trial element. Grepping apps/web/src and apps/mobile/src for `trialEndsAt|trial_ends_at|entitlements|currentPeriodEnd|current_period_end` matches ONLY apps/web/src/app/platform/platform-view.tsx (the super-admin console). Neither apps/web/src/app/settings/settings-view.tsx nor apps/mobile/src/app/settings.tsx contains the strings plan/billing/trial/subscription. Server side, `grep -rn "entitlements" apps/api/src` shows the entitlement document is read only by tenant.guard.ts, platform.controller.ts (behind PlatformGuard), and cap checks — no tenant-facing GET returns it. The cliff itself: apps/api/src/tenancy/tenant.guard.ts:113-123 `const trialExpired = entitlements.subscriptionStatus === 'trialing' && entitlements.trialEndsAt !== null && new Date(entitlements.trialEndsAt).getTime() < Date.now(); if (request.method !== 'GET' && (trialExpired || ...)) { throw new ForbiddenException({ code: 'SUBSCRIPTION_EXPIRED' }); }`
```

**Fix.** Three concrete changes; the finder's proposed fix is directionally right.

1. New tenant-facing read endpoint. Create `apps/api/src/tenancy/tenancy.controller.ts`:
   `@Controller('tenant') @UseGuards(AuthGuard, TenantGuard)` with `@Get('entitlements') get(@Req() req: TenantRequest) { return req.tenant.entitlements; }` — deliberately NO `@RequirePermission` (any active member may see their school's own plan status), and deliberately a GET so tenant.guard.ts:118/132 lets it through after the lock. Register the controller in `apps/api/src/app.module.ts`. The entitlement document is the tenant's own plan/limits/usage — no cross-tenant data.

2. Banner in the shells. In `apps/web/src/components/app-shell.tsx`, add a client child (e.g. `SubscriptionBanner`) next to `AssistantLauncher` at line 36 that calls `apiFetch('/tenant/entitlements')` and renders a persistent strip when (a) `subscriptionStatus === 'trialing'` and `trialEndsAt` is within 14 days — showing days remaining — or (b) already expired / `past_due` / `active` with `currentPeriodEnd` in the past. Mirror it in `apps/mobile/src/app/_layout.tsx`. New EN+SW keys in `packages/i18n/src/index.ts` (both key sets mirrored, per the iron rule) — e.g. `sub.trialEndsIn`, `sub.trialEnded`, `sub.lapsed`, plus the contact/renewal instruction.

3. Close the unmapped-code gap. Add `SUBSCRIPTION_LAPSED: "err.subscriptionLapsed"` to `ERROR_KEYS` in BOTH `apps/web/src/lib/api-error.ts` (line ~16, beside SUBSCRIPTION_EXPIRED) and `apps/mobile/src/lib/api-error.ts`, with EN+SW `err.subscriptionLapsed` strings in `packages/i18n/src/index.ts`. This is a two-line fix and removes the only genuinely unexplained lockout.

Optional follow-up already on the backlog: the T-14/T-7 renewal-reminder outbox job, so the warning does not depend solely on a staff phone call.

---

### 37. `SUBSCRIPTION_LAPSED` is missing from both error maps — a missed renewal renders as "Something went wrong (SUBSCRIPTION_LAPSED)"

- **Location:** `apps/web/src/lib/api-error.ts:16`
- **Category:** user-visible-error · **Verdict:** CONFIRMED (high) · **Found by:** gap:tenant-facing subscription/entitlement surface (schools are blind to their own trial and limits)

**What is wrong.** TenantGuard throws `SUBSCRIPTION_LAPSED` for past_due or period-ended paid subscriptions, but neither the web nor the mobile ERROR_KEYS map contains it, so the code falls through to the generic branch and the raw code is shown to end users.

**How it fails.** A school on Msingi monthly has current_period_end = 30 April. Platform staff have not yet recorded May's bank transfer. On 1 May the bursar opens an invoice and presses "Record payment": POST /finance/payments returns 403 {code:'SUBSCRIPTION_LAPSED'} (tenant.guard.ts:132-134; Http500ScrubFilter passes 4xx through untouched so `body.code` is present). invoice-view.tsx calls apiErrorMessage, which finds no entry in ERROR_KEYS and no `_NOT_FOUND`/`_INVALID`/`_FAILED` suffix, so it returns `${t("err.generic")} (SUBSCRIPTION_LAPSED)` = "Something went wrong (SUBSCRIPTION_LAPSED)" (Kiswahili: "Kuna hitilafu imetokea (SUBSCRIPTION_LAPSED)"). The bursar reads that as a broken app, not as an unpaid bill, and files a bug instead of paying. Identical on mobile.

**Evidence.**

```
apps/web/src/lib/api-error.ts:12-38 lists `SUBSCRIPTION_EXPIRED: "err.subscriptionExpired"`, `NO_SUBSCRIPTION`, `TENANT_SUSPENDED`, `TENANT_ARCHIVED` — no `SUBSCRIPTION_LAPSED`. Same omission at apps/mobile/src/lib/api-error.ts:12-15. Fallthrough at apps/web/src/lib/api-error.ts:46-53: `const exact = ERROR_KEYS[code]; if (exact) return t(exact); ... return `${t("err.generic")} (${code})`;`. The thrower: apps/api/src/tenancy/tenant.guard.ts:132-134 `if (request.method !== 'GET' && subscriptionLapsed) { throw new ForbiddenException({ code: 'SUBSCRIPTION_LAPSED' }); }`. Grepping packages/i18n/src/index.ts for `subscriptionLapsed` returns nothing — the EN/SW string does not exist either.
```

**Fix.** Three-file change, all additive. 1) packages/i18n/src/index.ts — add to the `en` dictionary next to "err.subscriptionExpired" (line 706): `"err.subscriptionLapsed": "Your subscription payment is overdue. You can still view records, but saving is paused until payment is recorded. Contact ATLAS."` and the mirrored Kiswahili entry next to line 1463 in `sw`, e.g. `"err.subscriptionLapsed": "Malipo ya usajili wako yamechelewa. Bado unaweza kuona taarifa, lakini kuhifadhi kumesitishwa hadi malipo yathibitishwe. Wasiliana na ATLAS."` — `sw` is typed `Record<DictKey, string>` (line 767) so typecheck enforces the pair. 2) apps/web/src/lib/api-error.ts — in the ERROR_KEYS block (after line 16) add `SUBSCRIPTION_LAPSED: "err.subscriptionLapsed",`. 3) apps/mobile/src/lib/api-error.ts — add the identical entry in its ERROR_KEYS block (the file header says to keep the two in sync). No API change is needed; the code is already stable and correct.

---

### 38. Outbox retries exhaust in ~30 minutes and then fail permanently, with no requeue path anywhere

- **Location:** `apps/workers/src/drain-outbox.ts:130`
- **Category:** reliability · **Verdict:** CONFIRMED (high) · **Found by:** workers-outbox

**What is wrong.** `MAX_ATTEMPTS = 5` with backoff `min(2**attempts, 60) minutes` gives delays of 2, 4, 8, 16 minutes — the 60-minute cap never engages — so total retry coverage is ~30 minutes. After that a row is `status='failed'` forever: no code path, endpoint, or UI anywhere in the repo moves a `failed` outbox row back to `pending`.

**How it fails.** Beem Africa has a 45-minute outage at 08:00 on a school morning (routine for TZ gateways). Registers are being submitted across the school, so ~120 `attendance.absent` rows queue up. The drainer claims each one, `driver.send` rejects with `Beem 503`, and the row cycles pending→failed over four backoffs. By 08:32 every one of the 120 rows is `status='failed'`. Beem recovers at 08:45. Nothing resends: the drainer's query filters `.eq("status", "pending")`, `GET /health/outbox` only counts failures, and the communication page (apps/web/src/app/communication/page.tsx:39) reads statuses without offering a retry. 120 parents are never told their child was absent, and the school has no way to find out which ones or resend without direct DB access.

**Evidence.**

```
apps/workers/src/drain-outbox.ts:31-32 and 128-147:
```ts
const BATCH = 50;
const MAX_ATTEMPTS = 5;
...
      } catch (err) {
        const attempts = row.attempts + 1;
        const exhausted = attempts >= MAX_ATTEMPTS;
        await supabase
          .from("notification_outbox")
          .update({
            status: exhausted ? "failed" : "pending",
            sent_at: null,
            ...(exhausted ? {} : {
                  next_attempt_at: new Date(
                    Date.now() + Math.min(2 ** attempts, 60) * 60_000,
                  ).toISOString(),
                }),
          })
          .eq("id", row.id);
```
`2 ** attempts` for attempts 1..4 is 2, 4, 8, 16 — always below the 60 cap the comment on line 132 advertises ("capped at 60 min"). `grep -rn "notification_outbox" apps/api/src` shows only reads (health.controller.ts:132-146, ai-tools.service.ts:1400) — no requeue writer. CLAUDE.md's own backlog lists 'failed-SMS drill-down list' as not yet built.
```

**Fix.** Two minimal changes.

1. apps/workers/src/drain-outbox.ts — widen the retry envelope and make the comment true. Line 32: `const MAX_ATTEMPTS = 8;`. Line 141-143: change `Math.min(2 ** attempts, 60)` to `Math.min(5 * 2 ** attempts, 240)` (delays 10/20/40/80/160/240/240 min ≈ 13 h coverage), and update the line-131/132 comment to say "capped at 240 min". Add jitter (`* (0.8 + Math.random() * 0.4)`) so a 120-row backlog does not stampede the gateway on the same tick — this also closes AUD-021's jitter half.

2. apps/api/src/communication/communication.controller.ts — add `POST /communication/outbox/retry-failed` with `@UseGuards(AuthGuard, TenantGuard)` + `@RequirePermission('communication.send')`, following the finance.controller.ts house pattern (zod safeParse, `{ code: 'STABLE_CODE' }` 400s). Body: optional `{ since?: ISO date }`. Implementation via `supabase.admin` MUST filter `.eq('tenant_id', tenantId)` from TenantGuard context (service-role bypasses RLS — iron rule), plus `.eq('status','failed')` and a bounded `.gte('created_at', …)` (default last 7 days) so an operator cannot resurrect a year of stale SMS and bill the school for it. The update must be `{ status: 'pending', attempts: 0, sent_at: null, next_attempt_at: new Date().toISOString() }` — **resetting `attempts` to 0 is load-bearing**: leaving it at 5 means the row re-fails permanently on its very first new failure (attempts+1 >= MAX_ATTEMPTS). Write an `audit_logs` row for the requeue.

Then surface it: make the failed count at apps/web/src/app/communication/communication-view.tsx:72-74 a button that calls the endpoint, and extend the read at apps/web/src/app/communication/page.tsx:39 from `select("status")` to include `template, recipient, created_at` filtered to failed rows so the school can see WHICH messages never went out. New strings need mirrored EN+SW keys in packages/i18n/src/index.ts.

Sequencing note: the endpoint writes `next_attempt_at`, which only exists after migration 0026 — ship it after the 0016-0028 gate is applied, or the update 400s on an unknown column.

---

### 39. SMS silently disabled in production: console driver is the default, rows are marked 'sent' before delivery, and guardian phone numbers + message bodies are logged

- **Location:** `apps/workers/src/sms-drivers.ts:71`
- **Category:** configuration · **Verdict:** CONFIRMED (high) · **Found by:** config-ops-secrets

**What is wrong.** `resolveDriver()` returns the console (log-only) driver whenever `SMS_DRIVER` is unset/not `beem`, and also silently falls back to it when `SMS_DRIVER=beem` but the Beem keys are blank — while `.env.example`, the file operators are told to copy, ships `SMS_DRIVER=console`. Because drain-outbox flips the row to `status='sent', sent_at=now()` *before* calling the driver and the console driver always resolves, every queued SMS is recorded as delivered. The console driver additionally logs the recipient MSISDN and the full rendered body at `info`.

**How it fails.** A school goes live with `.env` copied from `.env.example` (or with `SMS_DRIVER=beem` and `BEEM_API_KEY` left empty — the template ships it empty). A teacher marks 40 students absent; `app.record_attendance` queues 40 outbox rows. The drainer flips all 40 to `sent`, the console driver logs them, and no SMS leaves the building. `/health/outbox` reports `pending: 0, failed: 0` (the documented alert condition is `failed > 0` or stale pending — neither fires), and the Communication page renders "Outbox: 0 pending · 40 sent". Nobody — school, parents, or ops — learns that zero parents were notified, and the server log now holds 40 guardian phone numbers plus student names, and for `fees.reminder` rows their outstanding TZS balances.

**Evidence.**

```
apps/workers/src/sms-drivers.ts:71-83 —
```
export function resolveDriver(): SmsDriver {
  const requested = process.env.SMS_DRIVER ?? "console";
  if (requested === "beem") {
    ...
    if (!apiKey || !secretKey) {
      logger.warn("SMS_DRIVER=beem but BEEM_API_KEY/BEEM_SECRET_KEY missing — using console driver");
      return consoleDriver;
    }
```
apps/workers/src/sms-drivers.ts:31-40 —
```
const consoleDriver: SmsDriver = {
  name: "console",
  send(message) {
    logger.info(
      { recipient: message.recipient, body: message.body },
      "SMS (console driver — not actually sent)",
    );
```
apps/workers/src/drain-outbox.ts:111-121 — `.update({ status: "sent", ... }).eq("status", "pending")` runs before `await driver.send(...)` at line 125.
.env.example:31 — `SMS_DRIVER=console`
apps/web/src/app/communication/communication-view.tsx:73 — `{outbox.sent} {t("comm.sentStatus").toLowerCase()}`, fed by apps/web/src/app/communication/page.tsx:39-52 which counts `status === "sent"`.
apps/api/src/observability/logger.ts:6 states the policy the console driver violates: "Never log secrets, tokens, passwords or request bodies".
```

**Fix.** In `apps/workers/src/sms-drivers.ts`, make `resolveDriver()` fail fast instead of falling back, mirroring `resolveWebOrigin()` in `apps/api/src/config.ts:7-18`:

1. Line 76-79 (the actual defect): replace the `logger.warn` + `return consoleDriver` with `throw new Error("SMS_DRIVER=beem requires BEEM_API_KEY and BEEM_SECRET_KEY")`. Falling back to a log-only driver when the operator explicitly asked for a real gateway is never the desired behaviour in any environment.
2. Line 82: before returning `consoleDriver`, add `if (process.env.NODE_ENV === "production") throw new Error("SMS_DRIVER must be 'beem' in production — the console driver only logs.")`. Verified safe for the gate: nothing in package.json/turbo.json/the smokes sets `NODE_ENV=production`, and smoke-communication.mjs:122 / smoke-parents.mjs:182 spawn the drainer with an explicit `SMS_DRIVER: 'console'`, so both keep passing.
3. Optional hardening (lines 34-37): move the console driver's log to `logger.debug` or drop `body`, keeping `recipient` only, so a stray `LOG_LEVEL=info` dev box does not persist guardian MSISDNs plus fee balances.

The suggested `notification_outbox.driver` column is a nice-to-have but migrations are additive-only and 0016-0028 are still unapplied — do not add 0029 for this; items 1 and 2 remove the failure mode entirely, since with them there is no way to reach `status='sent'` without a real gateway call.

---

### 40. Beem SMS delivery has no request timeout — a hung gateway stalls the whole outbox drain

- **Location:** `apps/workers/src/sms-drivers.ts:46`
- **Category:** operability · **Verdict:** CONFIRMED (high) · **Found by:** config-ops-secrets

**What is wrong.** The Beem gateway call is a bare `fetch` with no `AbortSignal.timeout` / AbortController, unlike the Moonshot provider which is correctly capped at 60s. It therefore relies on undici's 300-second default header/body timeouts. Combined with the drainer's sequential per-row loop and its `running` overlap guard, one unresponsive request blocks all queued SMS for the whole platform.

**How it fails.** Beem Africa's endpoint accepts the TCP connection but stops responding (a common failure mode on a congested TZ mobile-network gateway). The drain loop is at row 3 of a 50-row batch of absence notifications; `await driver.send(...)` hangs for up to 300 s. The `running` flag makes every subsequent 15-second poll a no-op, so nothing else drains. With a handful of such rows the batch takes 25 minutes, the row is already flipped to `sent` (so `/health/outbox` reports `pending` shrinking normally and `failed: 0` — the documented alert never fires), and parents receive same-day absence SMS after school has ended. Every other tenant's queued messages wait behind it.

**Evidence.**

```
apps/workers/src/sms-drivers.ts:46-52 —
```
      const response = await fetch("https://apisms.beem.africa/v1/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Basic ...` },
```
No `signal:` in the options object (lines 46-63). Contrast apps/api/src/ai/ai-provider.ts:61-62 —
```
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
```
apps/workers/src/drain-outbox.ts:186-193 — the `running` guard makes every poll during the hang a no-op:
```
  setInterval(() => {
    if (running) return;
```
`grep -rn "AbortSignal\|AbortController\|timeout" apps/workers/src` → no matches.
```

**Fix.** Primary (one line, `/Users/admin/Atlas-System/apps/workers/src/sms-drivers.ts:46`): add a timeout signal to the Beem fetch options so a hung gateway rejects into the existing catch → backoff path in `drain-outbox.ts:128`.

```ts
const response = await fetch("https://apisms.beem.africa/v1/send", {
  method: "POST",
  signal: AbortSignal.timeout(15_000),   // <-- add
  headers: { ... },
  body: JSON.stringify({ ... }),
});
```

`AbortSignal.timeout` is available on Node 22 and the workers tsconfig targets ES2022, so no config change is needed. If the @types/node in use doesn't declare the static, mirror the existing house pattern from `apps/api/src/ai/ai-provider.ts:61-62` instead (`new AbortController()` + `setTimeout(() => controller.abort(), 15_000)` in a `try/finally` with `clearTimeout`) — that keeps the two outbound-HTTP call sites consistent.

Note the interaction with retries when picking the value: a timeout throw increments `attempts`, and `MAX_ATTEMPTS = 5` (`drain-outbox.ts:32`) means five consecutive timeouts mark the row `failed` permanently. 15s is comfortably above a healthy Beem response and the 2/4/8/16-minute backoff spreads the retries, so this is acceptable — but do not set it below ~10s.

Secondary, optional and lower priority: the head-of-line blocking is inherent to the sequential loop at `drain-outbox.ts:104`. Bounded concurrency (e.g. chunks of 5-10 rows via `Promise.allSettled`) would stop one slow recipient serialising the rest. Keep the claim-before-send update inside each concurrent unit so the at-most-once guarantee from AUD-008 is preserved, and re-run `smoke-communication.mjs` / `smoke-parents.mjs`, which assert exact delivery counts. The timeout alone removes the unbounded-stall failure mode; treat concurrency as a separate change.

---

### 41. Runbook and testing guide promise a shadow test and a rollback the file set cannot deliver; both stop at 0026 while CLAUDE.md applies through 0028

- **Location:** `docs/ATLAS_TESTING_GUIDE.md:161`
- **Category:** process-drift · **Verdict:** CONFIRMED (high) · **Found by:** gap:migration application safety / disaster recovery (the human is about to apply 13 migrations by hand)

**What is wrong.** The testing guide's shadow-test (§2.1), apply command (§2.2) and go/no-go checklist (§7) all cover 0016-0026 only, but CLAUDE.md:72 tells the human to apply {16..28}. 0027 and 0028 postdate the guide and the only recorded shadow test, so the two files that DROP live RLS policies and add a live constraint trigger have never been shadow-tested. The restore runbook's own repeat-trigger is also unmet, and the pilot runbook's rollback claim is false for this batch.

**How it fails.** An operator following docs/ATLAS_TESTING_GUIDE.md — which states at line 11 'Nothing here should be skipped for a paying school' — runs §2.1 then §2.2 and applies only 0016-0026, ticks the §7 go/no-go boxes, and ships. 0027 and 0028 are never applied: `app.account_for_method` stays anon-executable, `clinic_visits` and `ai_tool_calls` keep their over-broad member-read policies, AI token quotas stay unlimited, and every mobile push registration 500s on the missing `device_tokens` table. An operator following CLAUDE.md instead applies {16..28} — but 0027 (mtime 2026-07-16) and 0028 (2026-07-17) were written AFTER the guide's 'Last updated: 2026-07-12' and after the single recorded shadow run, so §2.1's mandate 'do this before every live apply' is violated for exactly the two files that mutate live security objects. Meanwhile ATLAS_RESTORE_RUNBOOK.md line 4-5 requires a repeat restore test 'after any migration touching finance tables' and the last one was 2026-07-08 — before 0025 (drops the ledger's source_type check, posts payroll to the ledger), 0026 (invoices immutability trigger) and 0027 (journal_lines constraint trigger) existed. And ATLAS_PILOT_RUNBOOK.md:76 offers 'Code-level: redeploy previous tag; migrations are additive-only' as the rollback plan, which is not true of this batch: 0025:118 and 0026:219 drop CHECK constraints and 0027:220/221/236 drop RLS policies, none of which a code redeploy restores and none of which has a down script. The operator believes they can roll back; they cannot.

**Evidence.**

```
docs/ATLAS_TESTING_GUIDE.md:161 (apply — stops at 26)
`for f in supabase/migrations/000000000000{16..26}_*.sql; do`
docs/ATLAS_TESTING_GUIDE.md:137 (shadow test — stops at 26)
`for f in supabase/migrations/000000000000{15,16,17,18,19,20,21,22,23,24,25,26}_*.sql; do`
docs/ATLAS_TESTING_GUIDE.md:374-375 (go/no-go — stops at 26)
`- [ ] Shadow test of \`0015\`-\`0026\` clean (§2.1).`
CLAUDE.md:72 — `for f in supabase/migrations/000000000000{16..28}_*.sql; do`

File mtimes postdate the guide's 2026-07-12 header: 0027 = Jul 16 23:45, 0028 = Jul 17 02:29.

docs/audit/ATLAS_RESTORE_RUNBOOK.md:4-5
`_Restore test performed: **2026-07-08** (passed) ... Repeat quarterly and after any migration touching finance tables._`

docs/audit/ATLAS_PILOT_RUNBOOK.md:76
`- Code-level: redeploy previous tag; migrations are additive-only.`
```

**Fix.** 1. /Users/admin/Atlas-System/docs/ATLAS_TESTING_GUIDE.md — three edits plus the header:
   - line 137 (§2.1 shadow loop): change the brace list to `{15,16,17,18,19,20,21,22,23,24,25,26,27,28}`.
   - line 161 (§2.2 apply loop): change `000000000000{16..26}_*.sql` to `000000000000{16..28}_*.sql`.
   - lines 374-375 (§7 go/no-go): change to "Shadow test of `0015`-`0028` clean" and "Migrations `0016`-`0028` applied to live".
   - line 3 header: bump `_Last updated:_` and add a one-line note that 0027 (security polish) and 0028 (device_tokens) were added after the 2026-07-12 pass.
   - Also update §0 TL;DR items 1-2 (lines ~18-21), which repeat the 0016-0026 range, and the §2 preamble at lines ~130-132.
2. Re-run the §2.1 full-restore shadow with 0027 and 0028 included before the live apply. The specific thing to prove: `0027:87-89` installs `journal_lines_entry_balanced` as a DEFERRABLE INITIALLY DEFERRED constraint trigger, so verify (a) the chain applies clean against a live restore, and (b) a subsequent `pg_restore` of existing journal_lines data still commits — an unbalanced historical entry would abort the restore at COMMIT, which would silently break the documented DR path.
3. /Users/admin/Atlas-System/docs/audit/ATLAS_PILOT_RUNBOOK.md:76 — replace "Code-level: redeploy previous tag; migrations are additive-only." with the accurate version: "Code-level: redeploy previous tag. Migrations are additive-only except for constraint widenings (0025, 0026 — the replacement is a superset, so old code is unaffected) and the RLS-policy drops in 0026/0027, which are deliberate tightenings with no down script. There is no DB rollback for those beyond a full restore at the current RPO."
4. /Users/admin/Atlas-System/docs/audit/ATLAS_RESTORE_RUNBOOK.md — re-run the documented restore test and update line 4's date. 0025, 0026 and 0027 all touch finance tables (journal_entries constraint, invoices immutability trigger, journal_lines deferred trigger), so the runbook's own repeat condition is currently unmet. Add the new triggers to the "Validation gates" table (the row that currently reads "4 triggers" needs recounting after 0026/0027).
5. Optional but cheap: record the exact `create policy` statements for the three policies 0027 drops in a comment block at the top of 0027, so a restore-to-prior-state is a copy-paste rather than a git archaeology exercise.

---

### 42. Suspending or archiving a school revokes nothing: the RLS predicate never checks tenants.status, so every direct browser/mobile read keeps working

- **Location:** `supabase/migrations/00000000000001_control_plane.sql:276`
- **Category:** access-control · **Verdict:** CONFIRMED (high) · **Found by:** gap:tenant suspension / offboarding / data deletion (RLS layer never checks tenant status; no purge or export exists)

**What is wrong.** `app.is_tenant_member` — the `using` clause of all 46 member-read RLS policies covering ~40 tables — checks only `tenant_memberships.status='active'` and never joins `public.tenants.status`. Suspend (platform.controller.ts:295) and archive (:333) only flip `tenants.status`; they never deactivate memberships, revoke Supabase sessions, or touch anything else. Every web server component and mobile screen reads through this predicate with the anon key, so a suspended or archived school's students, guardian phone numbers, invoices, payments and journal lines stay fully readable to every ex-member, indefinitely.

**How it fails.** Chuo cha Mwenge stops paying. The platform admin calls POST /platform/tenants/{id}/suspend, then later /archive with force:true; the UI reports "archived" and the tenant disappears from the active list. The school's bursar (membership row untouched, `status='active'`, Supabase refresh token still valid) opens https://app/finance the next morning. `apps/web/src/app/finance/page.tsx:23-79` runs `.from("tenants")…limit(1)` (returns the archived tenant — the policy at 0001:313 is `app.is_tenant_member(id)`), then reads `invoices`, `payments`, `fee_items` and `students` under the anon key. All four succeed: the full fee ledger and every pupil renders. `/students` (students/page.tsx:29-44) returns each child plus `guardians(full_name, phone, email)`; `/parents` (parents/page.tsx:27-37) returns every guardian phone. On mobile, `apps/mobile/src/lib/auth.tsx:48-70` loads `tenants(status)` into `TenantInfo.status` and then never reads it — dashboard/students/finance tabs render the archived school unchanged. The only thing suspension actually stops is writes (TenantGuard 403s). Net effect: offboarding a school does not cut off access to its data, and an archived school's PII remains live in every former staff member's browser and phone forever.

**Evidence.**

```
supabase/migrations/00000000000001_control_plane.sql:276-290
```sql
create or replace function app.is_tenant_member(target_tenant uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.tenant_memberships tm
    where tm.tenant_id = target_tenant
      and tm.user_id = auth.uid()
      and tm.status = 'active'   -- membership status only; tenants.status never joined
  );
$$;
```
apps/api/src/platform/platform.controller.ts:333 (archive) —
```ts
    const { error: archiveErr } = await this.supabase.admin
      .from('tenants')
      .update({ status: 'archived' })
      .eq('id', id);
```
(no membership update, no session revocation anywhere in the file; the same is true of suspend at :295).
apps/web/src/app/finance/page.tsx:22-79 reads invoices/payments/students under the anon key with no status check; `grep -rn "suspended\|archived" apps/web/src` returns hits only in `app/platform/platform-view.tsx` (the admin console).
```

**Fix.** Additive migration supabase/migrations/00000000000029_tenant_status_rls.sql: (a) add a NEW helper `app.is_active_tenant_member(target_tenant uuid)` = the existing membership check plus `join public.tenants t on t.id = tm.tenant_id and t.status in ('configuration','data_review','training','live')` (same allow-list as apps/workers/src/drain-outbox.ts:93); (b) `create or replace` the ~54 data-table select policies to call the new helper, but deliberately LEAVE `public.tenants` ("members read own tenants", 0001:313), `public.tenant_memberships`, `public.profiles` and `public.roles`/`role_permissions` on the plain `app.is_tenant_member` — otherwise the tenant row vanishes and apps/web/src/app/*/page.tsx (`if (!tenants) redirect("/onboarding")`) turns a lockout into a new-tenant signup path. Do NOT redefine `app.is_tenant_member` in place. (c) In apps/web: add the status to the shared tenant resolver (`.select("id, name, status")` in each page.tsx, or better a single `lib/tenant.ts` helper) and redirect to a new `/suspended` screen when status is 'suspended'/'archived' instead of rendering AppShell; in apps/mobile/src/lib/auth.tsx the `TenantInfo.status` already loaded must gate the tab layout the same way. Membership deactivation and admin-API refresh-token revocation in platform.controller.ts are optional hardening, not required — and if added, reactivate() must restore the memberships it suspended.

---

### 43. notification_outbox has no tenant_id index and no retention — per-tenant queries and the fee-reminder dedupe scan the whole table

- **Location:** `supabase/migrations/00000000000005_attendance.sql:56`
- **Category:** performance · **Verdict:** CONFIRMED (high) · **Found by:** data-integrity-perf

**What is wrong.** notification_outbox is indexed only by a partial (status, created_at) where status='pending'. Every per-tenant read (communication page, platform unit costs, health failed-count) and the fee-reminder anti-join on `payload->>'invoiceId'` therefore scan the whole cross-tenant table, which nothing ever purges.

**How it fails.** Three concrete hits. (1) A bursar clicks "Send fee reminders": app.queue_fee_reminders runs `not exists (select 1 from notification_outbox o where o.tenant_id = p_tenant_id and o.template = 'fees.reminder' and o.status = 'pending' and (o.payload->>'invoiceId')::uuid = u.id)` — a jsonb expression predicate with no supporting index, evaluated against the pending set of ALL tenants, for each of ~4,500 unpaid invoices. (2) app.platform_unit_costs runs `count(*) from notification_outbox where tenant_id = t.id and created_at >= p_from` once per tenant — 100 full scans per dashboard load. (3) /health/outbox does `count: 'exact'` on `status = 'failed'`, which the partial pending-only index cannot serve, so the monitoring probe seq-scans the table on every poll. At ~15k absence SMS + reminders per school per year and 100 schools, the table passes 1.5M rows in year one and keeps growing forever.

**Evidence.**

```
supabase/migrations/00000000000005_attendance.sql:44-57 — tenant_id column, only a partial pending index:
```sql
create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  ...
create index notification_outbox_pending_idx
  on public.notification_outbox (status, created_at) where status = 'pending';
```
(0026:234 adds only `notification_outbox_due_idx on (next_attempt_at) where status='pending'` — still no tenant_id.)
supabase/migrations/00000000000009_parents.sql:207-213 — the unindexed jsonb anti-join:
```sql
    and not exists (
      select 1 from public.notification_outbox o
      where o.tenant_id = p_tenant_id
        and o.template = 'fees.reminder'
        and o.status = 'pending'
        and (o.payload->>'invoiceId')::uuid = u.id
    );
```
apps/api/src/health/health.controller.ts:136-138 — `count: 'exact'` on a status the partial index excludes:
```ts
      .from('notification_outbox')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'failed');
```
```

**Fix.** Add a new additive migration supabase/migrations/00000000000029_outbox_indexes.sql (0029 is free) with, at minimum, the tenant index that unblocks the per-request path:

  create index if not exists notification_outbox_tenant_sent_idx
    on public.notification_outbox (tenant_id, status, sent_at desc);
  create index if not exists notification_outbox_tenant_created_idx
    on public.notification_outbox (tenant_id, created_at desc);
  create index if not exists notification_outbox_fee_reminder_idx
    on public.notification_outbox (tenant_id, ((payload->>'invoiceId')))
    where template = 'fees.reminder' and status = 'pending';
  create index if not exists notification_outbox_failed_idx
    on public.notification_outbox (created_at) where status = 'failed';

The first index is the one that matters most — it serves the smsThisMonth count inside app.tenant_entitlements (0013:114-116), which TenantGuard runs on every authenticated request (apps/api/src/tenancy/tenant.guard.ts:93-96); the second serves app.platform_unit_costs (0024:191-195) and the communication page. Plain create index is fine at current size; if run against a loaded table use create index concurrently, which psql executes fine per-statement as long as the file has no explicit BEGIN/COMMIT.

Cheap complementary fix on the same hot path: memoise the tenant_entitlements result in TenantGuard behind a short TTL (30-60s) keyed by tenantId, so a full entitlements RPC does not run on every request at all.

Retention: add a purge pass to apps/workers/src/drain-outbox.ts (it already has a poll loop and a --once mode used by smokes) that deletes rows with status='sent' and sent_at < now() - interval '90 days', batched (e.g. 5000 rows per pass). Guard it behind an env-tunable window and note the trade-off: app.tenant_entitlements only counts sent rows in the current calendar month and platform_unit_costs takes an explicit date range, so a 90-day window changes no existing figure.

---

### 44. A-Level (ACSEE) division is never computed and the reported points total includes non-principal General Studies

- **Location:** `supabase/migrations/00000000000006_assessments.sql:344`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** payroll-necta-domain

**What is wrong.** app.report_card only derives a division when education_level = 'o_level'. For a_level sections it returns division = null while still returning `points` as the sum of the best SEVEN subject point values — which for an A-Level student (3 principals + General Studies) is the sum of all four, whereas ACSEE division is computed from the three principal subjects only.

**How it fails.** Amina is in Form 5 A on the PCM combination (the exact scenario smoke-necta.mjs sets up). Her published term results are PHY 82 → A (1 pt), CHE 72 → B (2), ADM 61 → C (3), GS 55 → D (4). Correct ACSEE result: 1+2+3 = 6 principal points → Division I. app.report_card takes the best 7 of her 4 graded subjects, so v_points = 1+2+3+4 = 10, and the `if v_level = 'o_level'` guard leaves v_division NULL. The web report card (apps/web/src/app/students/[id]/report-card/report-card-view.tsx:182) prints Division "—", and the generated PDF/CSV from the report worker prints `Division — (10 points)`. Every Form 5/6 report card in a school that bought ATLAS for its A-Level stream is missing the single number parents and NECTA care about, and shows an inflated point total.

**Evidence.**

```
supabase/migrations/00000000000006_assessments.sql:337-352 —
`         -- best (lowest) 7 point values for the O-Level division`
`         (select sum(points)::int from (`
`            select points from graded order by points asc limit 7`
`          ) best)`
`    into v_subjects, v_average, v_subject_count, v_points`
`  from graded;`
`  if v_level = 'o_level' and v_subject_count >= 7 then`
`    v_division := case when v_points <= 17 then 'I' … else '0' end;`
`  end if;`
apps/workers/src/report-formats.ts consumer — apps/workers/src/process-reports.ts:177: `["Division", `${String(d.division ?? "—")} (${String(d.points ?? "—")} points)`]`
supabase/migrations/00000000000018_necta.sql:26-33 marks the principal/subsidiary split that report_card never consults: `is_principal boolean not null default true`
```

**Fix.** Do NOT edit `00000000000006_assessments.sql` — migrations are additive-only and 0006 is already applied to the live DB. Add a new migration `supabase/migrations/00000000000029_acsee_division.sql` that does `create or replace function app.report_card(p_tenant_id uuid, p_student_id uuid, p_term_id uuid)` with the full body copied from 0006 plus an a_level branch (it must sort after 0018, which creates `student_combinations` / `subject_combination_subjects`). `create or replace` preserves the existing grants, so the 0006 revoke/grant block and the `public.report_card` wrapper need no changes.

In the copied body, after the existing `into v_subjects, v_average, v_subject_count, v_points … from graded;` select:

1. Keep the O-Level branch exactly as is.
2. Add an `elsif v_level = 'a_level' then` branch that recomputes the points total from principals only. Materialise `graded` (or re-derive the per-subject averages into a temp CTE/array — `graded` is not visible outside its own statement, so the simplest minimal change is to compute the principal sum in a separate query):

   select sum(points)::int, count(*)::int into v_principal_points, v_principal_count
   from (
     select g.points
     from (<same subject_avgs + grade_for lateral as above>) g
     join public.student_combinations sc
       on sc.student_id = p_student_id
      and sc.academic_year_id = v_term.academic_year_id
      and sc.tenant_id = p_tenant_id
     join public.subject_combination_subjects cs
       on cs.combination_id = sc.combination_id
      and cs.subject_id = g.subject_id
      and cs.is_principal
     order by g.points asc
     limit 3
   ) p;

   then, only when `v_principal_count = 3`, set `v_points := v_principal_points` (so the printed total matches the division) and band it:
   v_division := case when v_points <= 9 then 'I' when v_points <= 12 then 'II' when v_points <= 17 then 'III' when v_points <= 19 then 'IV' else '0' end;

3. Fallback: if the student has no `student_combinations` row for the year, or fewer than 3 principals graded, leave `v_division` NULL and leave `v_points` as the existing best-7 value — do not guess a division from GS-inclusive points.

Declare the two new locals (`v_principal_points int; v_principal_count int;`) in the `declare` block. To avoid duplicating the CTE, the cleaner variant is to spool `graded` into a `jsonb`/array once and drive both sums off it, but the two-query version above is the smaller diff.

Then extend `apps/api/scripts/smoke-necta.mjs` (which already builds Form 5 A / PCM / Amina) to publish a term's marks for PHY/CHE/ADM/GS and assert `report-card` returns `division === 'I'` and `points === 6`, so the regression is covered. No API, web or worker changes are needed — they already render whatever the RPC returns.

---

### 45. Every tenant member can read all invoices, payments and the general ledger straight from the browser (finance RLS ignores finance.* permissions)

- **Location:** `supabase/migrations/00000000000007_finance.sql:151`
- **Category:** broken-access-control · **Verdict:** CONFIRMED (high) · **Found by:** authz-permissions+rls-sql-security

**What is wrong.** The finance tables carry blanket "members read" RLS policies keyed only on tenant membership, so roles with zero finance permissions (teacher, class_teacher, head_teacher, academic_master, school_admin) can read every invoice, payment, journal entry and ledger line directly through PostgREST with the public anon key, bypassing the finance.invoices.view / finance.reports.view checks the API enforces.

**How it fails.** A teacher at Chief Sarwatt School signs into the web app (role `teacher`, whose only permissions per supabase/seed.sql:75-78 are students.view, attendance.view, attendance.mark, marks.enter, timetable.view, hostel.view, transport.view, library.view, clinic.view). Calling GET /api/v1/finance/trial-balance correctly returns 403 'Missing permission: finance.reports.view'. But from the browser console the same teacher runs `fetch('https://<project>.supabase.co/rest/v1/payments?select=*&limit=1000', {headers:{apikey: ANON_KEY, Authorization: 'Bearer ' + jwt}})` and receives every payment row for the school — amount, method, reference, receipt number, student_id — and the same for `invoices`, `invoice_lines`, `journal_entries` and `journal_lines`. The school's entire fee-collection and ledger position is readable by any staff member with a login.

**Evidence.**

```
supabase/migrations/00000000000007_finance.sql:145-158
  create policy "members read fee items" on public.fee_items
    for select using (app.is_tenant_member(tenant_id));
  create policy "members read invoices" on public.invoices
    for select using (app.is_tenant_member(tenant_id));
  create policy "members read invoice lines" on public.invoice_lines
    for select using (app.is_tenant_member(tenant_id));
  create policy "members read payments" on public.payments
    for select using (app.is_tenant_member(tenant_id));
  create policy "members read journal entries" on public.journal_entries
    for select using (app.is_tenant_member(tenant_id));
  create policy "members read journal lines" on public.journal_lines
    for select using (app.is_tenant_member(tenant_id));

app.is_tenant_member (00000000000001_control_plane.sql:276-288) checks only that an active tenant_memberships row exists — it never consults role_permissions. No migration revokes SELECT from `authenticated` on these tables, so Supabase's default grant applies and RLS is the only gate.

That this is an oversight rather than a decision is shown by migration 0025, which deliberately ships NO member-read policy for the payroll salary tables, and by 0027:236 which drops `"members read clinic visits"` for the same reason — finance was simply never given the same treatment.
```

**Fix.** Add an additive migration `supabase/migrations/00000000000029_finance_rls.sql` that replaces the blanket policies with permission-aware ones (do NOT just drop them — see the caller note below).

1. Create the missing SQL permission helper, mirroring TenantGuard (apps/api/src/tenancy/tenant.guard.ts:137-162, incl. the SUPER_ROLES bypass):

create or replace function app.member_has_permission(target_tenant uuid, p_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tenant_memberships tm
    join public.membership_roles mr on mr.membership_id = tm.id
    join public.roles r on r.id = mr.role_id
    left join public.role_permissions rp
      on rp.role_id = r.id and rp.permission_key = p_key
    where tm.tenant_id = target_tenant
      and tm.user_id = auth.uid()
      and tm.status = 'active'
      and (r.key in ('school_owner','director') or rp.permission_key is not null)
  );
$$;
revoke execute on function app.member_has_permission(uuid, text) from public, anon, authenticated;  -- optional; RLS expressions still evaluate it as owner-defined SECURITY DEFINER only if EXECUTE remains, so if you revoke, grant it back to authenticated explicitly.

2. Swap the policies in supabase/migrations (new file, drop-then-create):
   drop policy "members read invoices" on public.invoices; create policy "finance staff read invoices" on public.invoices for select using (app.member_has_permission(tenant_id, 'finance.invoices.view'));
   same for invoice_lines, payments and fee_items (finance.invoices.view), and for journal_entries, journal_lines, ledger_accounts (finance.reports.view). Add matching comments on the tables, as 0027 did for clinic_visits.

3. Caller impact — these tables are read through RLS by real UI, so a plain drop would break legitimate bursars/owners too. Narrowing (not dropping) keeps them working since they hold the permission. The affected read sites are: apps/web/src/app/finance/page.tsx:47-67, apps/web/src/app/finance/[id]/page.tsx:31, apps/web/src/app/accounting/page.tsx:31-39, apps/web/src/app/page.tsx:85-98, apps/mobile/src/app/(tabs)/finance.tsx:65-74, apps/mobile/src/app/(tabs)/dashboard.tsx:97-104, apps/mobile/src/app/students/[id].tsx:87-94, apps/mobile/src/app/finance/[id].tsx:84.

4. Also add a server-side permission check (or a graceful "no access" state) to apps/web/src/app/finance/page.tsx and apps/web/src/app/accounting/page.tsx so a permission-less user gets a clean 403/redirect instead of an empty page, and gate the Finance/Accounting entries in apps/web/src/components/app-shared.ts nav builder.

5. Same audit is warranted for invoice_instalments (0017) which follows the same blanket members-read pattern.

---

### 46. record_payment accepts any paid_on date (far past or future) with no validation, and dates the journal entry differently — receipts can vanish from the fee-collection report while still clearing the invoice

- **Location:** `supabase/migrations/00000000000007_finance.sql:380`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** finance-correctness

**What is wrong.** `paidOn` is a free-form client-supplied date (zod only checks YYYY-MM-DD), is written straight to payments.paid_on, and is never bounded against the invoice issue date or today; meanwhile the journal entry is stamped `entry_date default current_date`, so the cash-basis fee-collection report (which filters on paid_on) and the ledger (which is dated today) permanently disagree.

**How it fails.** A cashier (permission finance.payments.receive, held by the `cashier` system role) receives 200,000 TZS cash from a parent on 2026-08-14 and POSTs `{"amount":200000,"method":"cash","paidOn":"2030-01-01"}` to /finance/invoices/:id/payments. The RPC accepts it: the invoice flips to paid/partially_paid, account 1000 Cash is debited today, and the parent gets a valid receipt. When the bursar runs the Fee Collection report for 2026-08-01..2026-08-31 (app.report_fee_collection filters `p.paid_on between p_from and p_to`), the 200,000 does not appear in any month the school will ever run, so the daily cash-up shows 200,000 less collected than the drawer/ledger holds. The audit row written at 00000000000007_finance.sql:395-398 records receipt, amount, method and invoice but NOT paid_on, so nothing in the audit trail shows the date was manipulated. The mirror case (back-dating to a closed month) moves real cash out of the period the head teacher reviews.

**Evidence.**

```
apps/api/src/finance/finance.schema.ts:38-43 —
```ts
export const recordPaymentSchema = z.object({
  amount: z.number().positive().multipleOf(0.01).max(1_000_000_000),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().max(100).optional(),
  paidOn: isoDate.optional(),
});
```
supabase/migrations/00000000000007_finance.sql:363-381 — the only amount validation, no date validation:
```sql
  if p_amount is null or p_amount <= 0 then
    raise exception 'PAYMENT_BAD_AMOUNT';
  end if;
  ...
  values (p_tenant_id, p_invoice_id, v_invoice.student_id, v_receipt, p_amount,
          p_method, p_reference, coalesce(p_paid_on, current_date), p_actor)
```
The journal entry uses a different date entirely — 00000000000007_finance.sql:114 `entry_date date not null default current_date`, and app.post_journal never passes p_paid_on.
```

**Fix.** Minimal fix, in a NEW additive migration (`supabase/migrations/00000000000029_payment_date_bounds.sql`) — migrations are additive-only, so use `create or replace function app.record_payment(...)` with the identical signature, copying the 0007 body and adding, right after the `PAYMENT_BAD_AMOUNT` check:

```sql
  if p_paid_on is not null and
     (p_paid_on > current_date or p_paid_on < current_date - 400) then
    raise exception 'PAYMENT_BAD_DATE';
  end if;
```

A rolling window (no future dates; at most ~13 months back, covering a full academic year of late entry) rather than the finder's `v_invoice.issued_on` floor, which would wrongly reject a payment received before a late-entered invoice since `issued_on` defaults to `current_date`.

In the same replaced body, add the date to the audit payload so manipulation is traceable:
```sql
jsonb_build_object('receipt', v_receipt, 'amount', p_amount, 'method', p_method,
                   'invoice', v_invoice.invoice_number,
                   'paidOn', coalesce(p_paid_on, current_date))
```

Then in `/Users/admin/Atlas-System/apps/api/src/finance/finance.controller.ts:387-391`, add `'PAYMENT_BAD_DATE'` to the `rpcError` allowlist so it surfaces as a stable 400 instead of a 500, and add EN+SW keys for it in `packages/i18n/src/index.ts` alongside the other finance error codes.

Optionally (larger, not required): tighten `paidOn` in `finance.schema.ts` as defence in depth, and — if you later add any date-ranged ledger report — give `app.post_journal` an additional optional `p_entry_date date default current_date` parameter and pass `coalesce(p_paid_on, current_date)` from `record_payment`. Note that overloading `post_journal` needs its own `revoke`/`grant` for the new signature, and `app.reverse_payment` (0007:444) should then stamp the reversal with the same date logic rather than an unconditional `current_date`.

---

### 47. journal_lines has no tenant_id index — the trial balance sequentially scans every tenant's ledger

- **Location:** `supabase/migrations/00000000000007_finance.sql:133`
- **Category:** performance · **Verdict:** CONFIRMED (high) · **Found by:** data-integrity-perf

**What is wrong.** public.journal_lines is indexed only on entry_id and account_id, but app.report_trial_balance's reconciliation pre-check filters on `jl.tenant_id` with no join, forcing a full sequential scan of every tenant's journal lines on every /finance/trial-balance request.

**How it fails.** One school opens Fees → Trial Balance. `app.report_trial_balance` first runs `select sum(jl.debit), sum(jl.credit) from public.journal_lines jl where jl.tenant_id = p_tenant_id` — with no index on tenant_id and no join to prune, Postgres seq-scans the whole table. Each invoice and each payment posts 2 lines, so a 1500-student school generates roughly 4,500 invoices × 2 + 9,000 payments × 2 ≈ 27,000 lines per year; across 100 tenants on the shared Postgres that is ~2.7M rows scanned per trial-balance load, growing every year and every new school. The same shape appears in app.report_debtors (00000000000017_instalments.sql:146-149) and app.report_outstanding_balances (00000000000012_reporting.sql:145-148). A bursar's report page gets slower as *other* schools post payments.

**Evidence.**

```
supabase/migrations/00000000000007_finance.sql:124-134 — journal_lines carries tenant_id but gets no index on it:
```sql
create table public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  entry_id uuid not null references public.journal_entries(id),
  account_id uuid not null references public.ledger_accounts(id),
  ...
create index journal_lines_entry_idx on public.journal_lines (entry_id);
create index journal_lines_account_idx on public.journal_lines (account_id);
```
supabase/migrations/00000000000012_reporting.sql:211-214 — the unjoined tenant filter:
```sql
  select coalesce(sum(jl.debit), 0), coalesce(sum(jl.credit), 0)
    into v_debits, v_credits
  from public.journal_lines jl
  where jl.tenant_id = p_tenant_id;
```
A grep of all 28 migrations for `journal_lines` confirms no tenant_id index is ever added (0010, 0025, 0026, 0027 only add triggers/constraints).
```

**Fix.** Add a new additive migration `supabase/migrations/00000000000029_journal_lines_tenant_index.sql` containing:

  create index if not exists journal_lines_tenant_idx
    on public.journal_lines (tenant_id, account_id) include (debit, credit);
  comment on index public.journal_lines_tenant_idx is
    'Covers app.report_trial_balance''s tenant-wide debit/credit pre-check (index-only scan) and the (tenant_id, account_id) A/R lookups in app.report_outstanding_balances / app.report_debtors.';

The leading tenant_id column removes the forced seq scan in app.report_trial_balance (supabase/migrations/00000000000012_reporting.sql:212-214); the trailing account_id plus INCLUDE (debit, credit) makes the per-account aggregates in the same RPC, in app.report_outstanding_balances (0012:145-148) and in app.report_debtors (0017:146-149) index-only — journal_lines is append-only (immutability trigger from 0010), so its visibility map stays clean and index-only scans hold. Use plain `create index` in the migration (no file wraps statements in a transaction, so `concurrently` would also work if this is ever applied to a loaded database). No RPC body changes are needed. Do not add an `invoice_lines(tenant_id)` index as the finder suggests — no report filters invoice_lines by tenant_id directly (all access is via invoice_lines_invoice_idx), so that one would be dead weight on a write path.

---

### 48. notification_outbox is member-readable, leaking clinic treatment text and guardian phones that 0027 just locked down

- **Location:** `supabase/migrations/00000000000008_communication.sql:46`
- **Category:** rls-permission-bypass · **Verdict:** CONFIRMED (high) · **Found by:** rls-sql-security

**What is wrong.** The `members read outbox` policy exposes notification_outbox.payload to every tenant member. That payload carries clinic visit treatment text (0023) and per-invoice outstanding balances (0009), so migration 0027's SEC-CLINIC lockdown of clinic_visits is defeated by the SMS queue built from the same data.

**How it fails.** The school nurse records a visit for student 'STU-00042' with treatment text "ARV refill — HIV clinic follow-up" and notify=true. app.record_clinic_visit (00000000000023_clinic.sql:77-93) writes ONE notification_outbox row whose payload contains `'treatment', nullif(trim(p_treatment),'')`, `'studentName'`, `'studentNumber'` and whose `recipient` is the mother's phone. Migration 0027 drops the members-read policy on clinic_visits specifically so "Health data is the most sensitive PII we hold" is API-only. But the school's cashier — seed.sql:126-127 grants the `cashier` role only students.view, finance.invoices.view, finance.payments.receive, so no clinic.view — signs in and runs `supabase.from('notification_outbox').select('recipient, template, payload')` with their own JWT (the identical call shape apps/web/src/app/communication/page.tsx:39 already makes) and reads that treatment string plus the guardian's phone number for every notified visit in the school. The same query returns every `fees.reminder` payload, which carries `'balance'` per invoice (00000000000009_parents.sql:199) — data the API gates behind finance.debtors.view.

**Evidence.**

```
supabase/migrations/00000000000008_communication.sql:44-47
  -- Members may see their school's outbox queue status (the phone numbers in
  -- it are already member-readable via the guardians table).
  create policy "members read outbox" on public.notification_outbox
    for select using (app.is_tenant_member(tenant_id));

The rationale in that comment only covers phone numbers; it predates 0023, which started putting health data in the same rows:
supabase/migrations/00000000000023_clinic.sql:77-87
    insert into public.notification_outbox (tenant_id, recipient, template, payload)
    select p_tenant_id, g.phone, 'clinic.visit',
           jsonb_build_object(
             ... 'treatment', nullif(trim(p_treatment), ''),

and 0027 explicitly closed the other door only:
supabase/migrations/00000000000027_security_polish.sql:236
  drop policy if exists "members read clinic visits" on public.clinic_visits;
```

**Fix.** Do NOT edit 0008 (it is already applied live). 0027 is still unapplied and untracked, so append a "SEC-OUTBOX" section to supabase/migrations/00000000000027_security_polish.sql (or add a new 00000000000029_outbox_columns.sql — it must order AFTER 0026, which adds next_attempt_at). Minimal fix that keeps the existing web page working, using column-level privileges instead of dropping the policy (RLS is row-level and cannot hide a column):

  revoke select on public.notification_outbox from anon, authenticated;
  grant select (id, tenant_id, channel, recipient_masked_placeholder_omitted) ...

concretely:

  revoke select on public.notification_outbox from anon, authenticated;
  grant select (id, tenant_id, channel, template, status, attempts,
                created_at, sent_at, next_attempt_at)
    on public.notification_outbox to authenticated;
  comment on table public.notification_outbox is
    'SMS/email queue. Since 0027 (SEC-OUTBOX): members may read only queue-status columns; recipient and payload (clinic treatment text, invoice balances) are service-role only.';

This leaves the `"members read outbox"` policy in place so apps/web/src/app/communication/page.tsx:39 (`select("status").eq("tenant_id", ...)`) keeps working unchanged — both columns it touches are in the grant list — while `select=payload` / `select=recipient` now returns 42501. Service role is unaffected (separate grant, bypasses RLS), so apps/workers/src/drain-outbox.ts, apps/api/src/health/health.controller.ts:132-146 and apps/api/src/ai/ai-tools.service.ts:1400 continue to work.

If you prefer the 0027 house pattern (deny-all, API-only, as done for clinic_visits/ai_tool_calls), instead `drop policy if exists "members read outbox" on public.notification_outbox;` and add a `@RequirePermission('communication.send')` endpoint returning only the three aggregate counts, then change communication/page.tsx:39 to apiFetch — but that is a larger change for the same security outcome. Add a regression assertion to apps/api/scripts/smoke-communication.mjs: with a low-privilege member's JWT, `select=payload` on notification_outbox must fail.

---

### 49. POST /finance/reminders re-sends an SMS to every unpaid invoice as soon as the previous batch drains

- **Location:** `supabase/migrations/00000000000009_parents.sql:207`
- **Category:** idempotency · **Verdict:** CONFIRMED (high) · **Found by:** concurrency-idempotency

**What is wrong.** app.queue_fee_reminders de-duplicates only against outbox rows still in status='pending'. The drainer flips rows to 'sent' within POLL_MS (default 15s), after which a second click re-queues a reminder for every unpaid invoice. The same NOT EXISTS check is also a read-then-insert race between two concurrent callers.

**How it fails.** A bursar clicks 'Send reminders' for 480 unpaid invoices. drain-outbox marks them 'sent' on its next 15-second pass. The bursar isn't sure the first click registered (the toast scrolled away) and clicks again 30 seconds later: the NOT EXISTS sub-query finds no PENDING reminder for any invoice, so 480 more outbox rows are queued and 480 more SMS are billed to the school, and every guardian gets the same fee-arrears message twice. Concurrent variant: the bursar and the head teacher both click within the same second — both statements evaluate NOT EXISTS against a snapshot with no pending rows and both insert, double-billing even inside the dedupe window. Nothing rate-limits the endpoint beyond the global 300/min throttle.

**Evidence.**

```
supabase/migrations/00000000000009_parents.sql:206-213 —
```
where u.balance > 0
  and not exists (
    select 1 from public.notification_outbox o
    where o.tenant_id = p_tenant_id
      and o.template = 'fees.reminder'
      and o.status = 'pending'
      and (o.payload->>'invoiceId')::uuid = u.id
  );
```
The file's own contract (0009:169-172) claims "An invoice with a reminder still pending in the outbox is skipped, so repeated clicks never spam parents" — true only for the ~15s the row stays pending (apps/workers/src/drain-outbox.ts:33 `POLL_MS ?? 15_000`, :111-121 flips pending→sent). finance.controller.ts:145-163 exposes it with no cooldown, and ai-actions.service.ts:1544-1552 (`sendFeeReminders`) calls the same RPC.
```

**Fix.** Two-part minimal fix.

(a) New additive migration `supabase/migrations/00000000000029_fee_reminder_idempotency.sql` that `create or replace function app.queue_fee_reminders(p_tenant_id uuid, p_actor uuid)` with the body unchanged except:
- serialise callers with the in-house pattern already used at 0027:159 / 0010:147, as the first statement of the function body: `perform pg_advisory_xact_lock(hashtext('feereminders:' || p_tenant_id::text));`
- widen the dedupe from queue state to a time window — replace the `not exists` block (0009:207-213) with a status-agnostic, age-bounded check:
  `and not exists (select 1 from public.notification_outbox o where o.tenant_id = p_tenant_id and o.template = 'fees.reminder' and o.status <> 'failed' and o.created_at > now() - (coalesce(p_cooldown_hours, 24) || ' hours')::interval and (o.payload->>'invoiceId')::uuid = u.id)`
  Keep the existing 2-arg signature (the controller and `ai-actions.service.ts:1546` call it positionally); if a caller-tunable window is wanted, add a third `p_cooldown_hours int default 24` parameter plus a matching `public.*` wrapper and re-apply the `revoke from public, anon, authenticated` / `grant execute … to service_role` lines (0009:230-232) for the NEW signature — the old wrapper stays valid.
- fix the stale contract comment at 0009:169-171 in the new file's header: reminders are skipped for N hours after the last one was queued, not merely while pending.
- also return the skip count so the UI can say so: `return jsonb_build_object('queued', v_count, 'cooldownHours', 24);`

(b) Update the two `SendRemindersButton` components (`apps/web/src/app/finance/finance-view.tsx:161` and `apps/web/src/app/finance/debtors/debtors-view.tsx:216`) to confirm before firing — an AlertDialog showing the unpaid-invoice count and "SMS cost money and cannot be recalled", mirroring the warning `ai-actions.service.ts:1543` already shows in the propose→confirm card. New strings need EN+SW keys in `packages/i18n/src/index.ts`.

Then update the ordering in `apps/api/scripts/smoke-parents.mjs:174-190` so the drain runs BETWEEN the two `/finance/reminders` calls and the second call is still asserted `queued === 0` — that is the assertion that would have caught this.

---

### 50. report_jobs.totals is member-readable, exposing financial report totals to members without finance permissions

- **Location:** `supabase/migrations/00000000000012_reporting.sql:40`
- **Category:** rls-permission-bypass · **Verdict:** CONFIRMED (high) · **Found by:** rls-sql-security

**What is wrong.** report_jobs stores each completed report's reconciled financial totals (total collected, trial-balance debits/credits, A/R outstanding) and its params, and grants read to every tenant member, bypassing the finance.reports.view gate the same data has on the API create and download paths.

**How it fails.** The bursar generates a fee-collection report for Term 1. apps/workers/src/process-reports.ts:232-238 writes `totals: payload.totals` back onto the report_jobs row — for fee_collection that is `{total, byMethod}`, for trial_balance `{debits, credits}`, for outstanding_balances `{outstanding, ledgerAR}` (process-reports.ts:80-103,120-122). A class_teacher — seed.sql:79-83, no finance.* and no reports.generate — runs `supabase.from('report_jobs').select('report_key, params, totals')` with their own JWT and reads the school's total term collection and full trial-balance totals. POST /api/v1/reports would have refused them (reports.controller.ts:103-105 checks def.permission = finance.reports.view) and so would GET /reports/:id/download (reports.controller.ts:215-222). params additionally leaks the studentId of every student_statement anyone has ever run.

**Evidence.**

```
supabase/migrations/00000000000012_reporting.sql:39-41
  alter table public.report_jobs enable row level security;
  create policy "members read report jobs" on public.report_jobs
    for select using (app.is_tenant_member(tenant_id));

totals is written by the worker with the reconciled money figures:
apps/workers/src/process-reports.ts:232-238
    .from("report_jobs")
    .update({ status: "completed", file_path: path, totals: payload.totals ?? null, ... })

Secondary gap on the same data in the API: apps/api/src/reports/reports.controller.ts:183-186 returns `totals` guarded only by `@RequirePermission('reports.generate')`, unlike create (line 103) and download (line 216) which additionally require def.permission — so a head_teacher (reports.generate, no finance.reports.view) also reads financial totals through GET /reports/:id.
```

**Fix.** Two changes, both minimal.

1. New additive migration `supabase/migrations/00000000000029_report_jobs_lockdown.sql` (migrations are additive-only; 0012 is already live so it must not be edited) — follow the 0027 SEC-AI/SEC-CLINIC pattern exactly:

    drop policy if exists "members read report jobs" on public.report_jobs;
    comment on table public.report_jobs is
      'Report jobs. RLS deny-all since 0029: totals jsonb carries ledger-reconciled money (collection totals, trial-balance debits/credits, A/R, per-student closing balance) and params carries studentIds — reads via the API (reports.generate + the report''s own permission) only.';

RLS stays enabled with no policies = deny-all for members, service-role only. Safe: no code outside the service-role API/worker reads `report_jobs` (verified by grep over apps/web/src, apps/mobile/src, packages). Hand the human the apply command — DDL writes are blocked for agents — and note this rides along with the pending 0016-0028 batch.

2. `apps/api/src/reports/reports.controller.ts` — in `detail()` (`@Get(':id')`, line 181), after the job is fetched and before returning, add the same check `download()` already does at 216-222:

    const def = CATALOGUE[job.report_key as ReportKey];
    if (def && !req.tenant.isOwner && !req.tenant.permissions.has(def.permission)) {
      throw new ForbiddenException(`Missing permission: ${def.permission}`);
    }

Optionally also filter `list()` (line 164) so rows whose `def.permission` the caller lacks are omitted or returned without `params` — it currently exposes student_statement studentIds to any `reports.generate` holder. Add an assertion to `apps/api/scripts/smoke-reports.mjs` that a `reports.generate`-only user gets 403 from `GET /reports/:id` for a fee_collection job.

---

### 51. ai_messages has no tenant_id index — the platform dashboard seq-scans the whole table twice per tenant

- **Location:** `supabase/migrations/00000000000024_platform_metrics.sql:126`
- **Category:** performance · **Verdict:** CONFIRMED (high) · **Found by:** data-integrity-perf

**What is wrong.** public.ai_messages is indexed only on (conversation_id, created_at), but app.platform_health() runs two correlated subqueries per tenant filtering `am.tenant_id`, so the super-admin dashboard performs 2 × N full sequential scans of an unbounded, never-purged table.

**How it fails.** With 100 non-archived tenants, one load of the platform health dashboard executes `select count(*) from ai_messages where tenant_id = t.id and created_at >= now() - interval '7 days'` and `select max(created_at) from ai_messages where tenant_id = t.id` once per tenant — 200 full table scans in a single statement. ai_messages grows by ~3 rows per AI turn (user + tool + assistant, written at ai.controller.ts:190, 266 and 295) with no purge anywhere in the repo (grep for purge/retention across apps/api and apps/workers returns nothing), despite migration 0014 promising one. At 200 assistant turns/day/school × 100 schools × 3 rows, the table gains ~60k rows/day / ~22M rows/year; the dashboard query becomes minutes-long and eventually times out, and the documented 90-day purge would itself have no index to run on.

**Evidence.**

```
supabase/migrations/00000000000014_ai_assistant.sql:26-36 — tenant_id column, but only a conversation index:
```sql
create table public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  conversation_id uuid not null references public.ai_conversations(id),
  ...
create index ai_messages_conversation_idx
  on public.ai_messages (conversation_id, created_at);
```
supabase/migrations/00000000000024_platform_metrics.sql:126-134 — two per-tenant scans:
```sql
      (select count(*)::int from public.ai_messages am
        where am.tenant_id = t.id
          and am.created_at >= now() - interval '7 days') as ai_messages_7d,
      greatest(
        ...
        (select max(am.created_at) from public.ai_messages am where am.tenant_id = t.id)
      ) as last_activity_at
```
And 0014's own retention note (line 9-11) — `schedule a purge of ai_messages older than 90 days (workers cron) before GA` — is unimplemented.
```

**Fix.** Primary fix — add the missing index in a new additive migration (0014 is already applied to the live DB, so it cannot be edited): create `/Users/admin/Atlas-System/supabase/migrations/00000000000029_ai_messages_tenant_index.sql` containing

  create index if not exists ai_messages_tenant_created_idx
    on public.ai_messages (tenant_id, created_at desc);

Plain (non-CONCURRENT) CREATE INDEX is correct here — the live table is tiny today and no migration file opens an explicit transaction, so it applies cleanly under the `psql -v ON_ERROR_STOP=1` loop; fold it into the pending 0016-0028 apply batch. Verified effect: 3554 ms -> 11.6 ms on a 300k-row / 60-tenant reproduction, with the `max(created_at)` subquery collapsing to an index-only `Limit 1`.

Optional structural fix (0024 is not yet applied, so it can be corrected in place): in `app.platform_health()` at `/Users/admin/Atlas-System/supabase/migrations/00000000000024_platform_metrics.sql:99-140`, replace the eight correlated per-tenant subqueries with grouped CTEs (`select tenant_id, count(*) filter (where created_at >= now() - interval '7 days'), max(created_at) from public.ai_messages group by tenant_id`, likewise for attendance_sessions / assessment_scores / payments) LEFT JOINed to `tenants` on tenant_id. That removes the per-tenant rescan for all four source tables at once and makes the dashboard cost linear regardless of tenant count.

Separately (already on the CLAUDE.md backlog, not required for this fix): implement the 90-day `ai_messages` purge promised at 0014:9-11 as a `--once`-capable worker alongside `apps/workers/src/drain-outbox.ts`; the same `(tenant_id, created_at desc)` index is what makes that delete efficient.

---

### 52. post_payroll staleness guard ignores has_heslb changes — a HESLB toggle between draft and post silently posts 0 withholding

- **Location:** `supabase/migrations/00000000000025_payroll.sql:391`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** payroll-necta-domain

**What is wrong.** The PAYROLL_RUN_STALE check compares only basic_salary and allowances against the snapshot in payroll_items. Changing a staff member's has_heslb flag (which set_staff_salary does by deactivating the old row and inserting a new one) does not trip it, so a draft computed with the old flag posts to the ledger with the wrong HESLB amount.

**How it fails.** Teacher Beatrice has basic 1,200,000 and has_heslb = false. The bursar runs payroll for 2027-02; payroll_items records heslb = 0, net = 928,000. HESLB then confirms Beatrice has an outstanding loan, so the bursar calls POST /payroll/salaries with `{userId, basic:1200000, allowances:0, hasHeslb:true}` — same amounts, flag flipped. She then posts the February draft. The stale check's predicate compares `pi.basic <> s.basic_salary` (1,200,000 = 1,200,000) and `pi.allowances <> s.allowances` (0 = 0), finds no mismatch, and posting proceeds. 180,000 TZS of HESLB repayment (15% of basic) that the employer is legally obliged to withhold and remit is never withheld; 2100 Payroll Liabilities is understated by 180,000 and 1000 Cash is credited 180,000 too much. The run is now immutable — the only remedy is a manual reversal. The mirror case (flag turned off after the draft) over-deducts 180,000 from the teacher's pay.

**Evidence.**

```
supabase/migrations/00000000000025_payroll.sql:388-393 —
`    left join public.payroll_items pi`
`      on pi.run_id = p_run_id and pi.user_id = s.user_id`
`    where s.tenant_id = p_tenant_id and s.active`
`      and (pi.user_id is null`
`           or pi.basic <> s.basic_salary`
`           or pi.allowances <> s.allowances)`
supabase/migrations/00000000000025_payroll.sql:210-218 (set_staff_salary deactivates + reinserts on any change, including has_heslb only):
`  update public.staff_salaries set active = false where tenant_id = p_tenant_id and user_id = p_user_id and active;`
`  insert into public.staff_salaries (tenant_id, user_id, basic_salary, allowances, has_heslb, created_by) values (...)`
supabase/migrations/00000000000025_payroll.sql:308-310 (heslb derives from the flag):
`    v_heslb := case when v_sal.has_heslb then round(v_sal.basic_salary * v_heslb_rate, 2) else 0 end;`
```

**Fix.** In `/Users/admin/Atlas-System/supabase/migrations/00000000000025_payroll.sql`, extend the staleness predicate in `app.post_payroll` (lines 391-393) so it also compares the HESLB component, recomputed from the current flag and the tenant's current rate. Replace:

```
      and (pi.user_id is null
           or pi.basic <> s.basic_salary
           or pi.allowances <> s.allowances)
```

with:

```
      and (pi.user_id is null
           or pi.basic <> s.basic_salary
           or pi.allowances <> s.allowances
           or pi.heslb <> (case when s.has_heslb
                                then round(s.basic_salary * coalesce(
                                       (select (ps.rates->>'heslb_rate')::numeric
                                          from public.payroll_settings ps
                                         where ps.tenant_id = p_tenant_id), 0), 2)
                                else 0 end))
```

This needs no schema change (0025 is not yet applied, so it can be edited in place; if it has already been applied, ship the identical body as a `create or replace function app.post_payroll(...)` in a new migration 0029 — the public wrapper is unchanged). It closes the flag-flip case and, as a bonus, also trips when a tenant edits `heslb_rate` between draft and post.

Cleaner long-term alternative (needs a column, so an additive 0029): add `has_heslb boolean not null default false` to `public.payroll_items`, write `v_sal.has_heslb` into it in `app.run_payroll` (line 313-322), and compare `pi.has_heslb is distinct from s.has_heslb`.

Also add coverage to `/Users/admin/Atlas-System/apps/api/scripts/smoke-payroll.mjs`: create a draft, POST /payroll/salaries with identical basic/allowances but a flipped `hasHeslb`, and assert POST /payroll/runs/:id/post returns 400 `PAYROLL_RUN_STALE`.

---


## LOW (51)

### 53. smoke-payroll.mjs asserts the old, over-taxing PAYE/NSSF numbers — the release-gate smoke will fail and its expected values encode an illegal calculation

- **Location:** `apps/api/scripts/smoke-payroll.mjs:138`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** payroll-necta-domain

**What is wrong.** The smoke computes expected PAYE by applying the bands to FULL gross and expects NSSF at 10% of BASIC, while migration 0025 (post BUG-PAYE / BUG-NSSF fix) applies the bands to gross-less-NSSF and charges NSSF on gross. Every numeric assertion in step 5 and step 7 is wrong.

**How it fails.** After the human applies migrations 0016–0028 and runs the post-apply checklist (`node apps/api/scripts/smoke-payroll.mjs`), teacher1 is set to basic 600,000 + allowances 50,000 (gross 650,000). The RPC computes nssf = round(650000*0.10) = 65,000 and paye = compute_paye(650000-65000 = 585000) = 0.08*(520000-270000) + 0.20*(585000-520000) = 20,000 + 13,000 = 33,000. The smoke asserts nssf === 60,000 and paye === 46,000 and throws `teacher1.nssf: got 65000, expected 60000` at line 155. teacher2 (gross 1,200,000) likewise: RPC paye = compute_paye(1,080,000) = 152,000, smoke expects 188,000. Steps 7's `totalDeductions` constant (594,000, actual 550,000) is wrong too. The gate blocks the sprint; worse, an engineer debugging it may "fix" the SQL to match the smoke, restoring the pre-fix behaviour that taxes the NSSF contribution and thereby over-withholds PAYE from every teacher (13,000/month on a 650,000 salary, 36,000/month on 1.2M).

**Evidence.**

```
apps/api/scripts/smoke-payroll.mjs:138-144 —
`const t1 = { gross: 650000, paye: expectedPaye(650000), nssf: 60000, heslb: 0 };`
`if (t1.paye !== 46000) throw new Error(...)`
`const t2 = { gross: 1200000, paye: expectedPaye(1200000), nssf: 120000, heslb: 180000 };`
`if (t2.paye !== 188000) throw new Error(...)`
(`expectedPaye` at line 50-62 walks the bands over the raw `income` argument, which is passed the full gross.)
supabase/migrations/00000000000025_payroll.sql:302-307 —
`v_nssf := round(v_gross * v_nssf_rate, 2);`
`v_paye := round(app.compute_paye(v_gross - v_nssf, v_rates->'paye_bands'), 2);`
apps/api/scripts/smoke-payroll.mjs:160 — `const totalDeductions = t1.paye + t1.nssf + t2.paye + t2.nssf + t2.heslb; // 594,000`
```

**Fix.** Update /Users/admin/Atlas-System/apps/api/scripts/smoke-payroll.mjs to mirror the RPC (NSSF on gross, PAYE on gross-less-NSSF) — four edits:

1. Lines 137-144, replace with:
```js
// teacher1: mid-band earner — gross 650,000. NSSF is 10% of GROSS and the
// PAYE base is gross LESS NSSF (migration 0025, BUG-NSSF / BUG-PAYE).
const t1 = { gross: 650000, nssf: 65000, heslb: 0 };
t1.paye = expectedPaye(t1.gross - t1.nssf);
t1.net = t1.gross - t1.paye - t1.nssf - t1.heslb;
if (t1.paye !== 33000) throw new Error(`script self-check: PAYE(585000) = ${t1.paye}, expected 33000`);
// teacher2: top-band + HESLB — gross 1,200,000
const t2 = { gross: 1200000, nssf: 120000, heslb: 180000 };
t2.paye = expectedPaye(t2.gross - t2.nssf);
t2.net = t2.gross - t2.paye - t2.nssf - t2.heslb;
if (t2.paye !== 152000) throw new Error(`script self-check: PAYE(1080000) = ${t2.paye}, expected 152000`);
```
(keeps the hard-coded self-checks so band regressions still fail loudly)

2. Lines 160-161 comments: `totalDeductions` is 550,000 and `totalNet` is 1,300,000.

3. Line 166 (the assertion the original finding overlooked): employer NSSF is 10% of total gross, not of basic — change `if (detail.body.employer.nssf !== 180000)` to `!== 185000`.

4. Line 169 log text: "PAYE 33,000 / 152,000; net 552,000 / 748,000".

No change to supabase/migrations/00000000000025_payroll.sql — its math is the correct post-fix version. After editing, tick the item off docs/ATLAS_TESTING_GUIDE.md:206-212 (which also lists the other payroll assertions still to add: PAYROLL_RUN_STALE, discard, GET/PUT /payroll/settings).

---

### 54. AI propose→confirm preview cards are server-generated English only, so a Swahili user confirms money actions they cannot read

- **Location:** `apps/api/src/ai/ai-actions.service.ts:814`
- **Category:** i18n · **Verdict:** CONFIRMED (high) · **Found by:** mobile-i18n

**What is wrong.** `ActionPreview.title`, the `lines` labels and the `warnings` strings are hardcoded English in ai-actions.service.ts and are rendered verbatim by the mobile assistant, which defaults to Kiswahili. The one surface where comprehension matters most — the money confirmation card — bypasses i18n entirely.

**How it fails.** The mobile app defaults to `sw` (src/lib/i18n.tsx:24) so a bursar in Songea sees a fully Kiswahili UI. She asks the assistant to record a payment larger than the open balance. The confirm card renders "Record payment of TZS 450,000", row labels "Student / Invoice / Amount / Method", and the warning "⚠ Amount exceeds the open balance of TZS 100,000 — execution will be rejected." — all English inside a Kiswahili screen, next to a Kiswahili "Thibitisha" button. She cannot read the warning that the action will be rejected, taps Thibitisha, and gets a failure she does not understand.

**Evidence.**

```
apps/api/src/ai/ai-actions.service.ts:808-820 — ``warnings.push(`Amount exceeds the open balance of ${fmtTZS(invoice.balance)} — execution will be rejected.`)`` and ``return { title: `Record payment of ${fmtTZS(amount)}`, lines: [['Student', ...], ['Invoice', ...], ['Amount', fmtTZS(amount)], ['Method', ...]] }``
apps/mobile/src/app/(tabs)/assistant.tsx:282-297 — `<Text style={styles.actionTitle}>{action.preview.title}</Text>` … `{action.preview.lines.map(([label, value], k) => ... <Text ...>{label}</Text>` … `{action.preview.warnings.map((w, k) => <Text key={k} style={styles.actionWarning}>⚠ {w}</Text>)}` — all rendered raw.
apps/mobile/src/lib/i18n.tsx:24 — `const [lang, setLangState] = useState<Lang>("sw");`
```

**Fix.** Make the preview carry keys instead of prose, and translate on the clients, keeping the English strings as a fallback so already-stored `ai_proposed_actions.preview` jsonb rows still render.

1. `apps/api/src/ai/ai-actions.service.ts:24-28` — widen the type additively:
   `export interface ActionPreview { title: string; titleKey?: string; titleParams?: Record<string,string|number>; lines: Array<[string,string]|[string,string,string]>; /* 3rd slot = label key */ warnings: string[]; warningKeys?: Array<{ key: string; params?: Record<string,string|number> }>; }`
   Then in each of the 16 `preview:` builders (start with the money ones at 800, 884, 972) add the key alongside the existing English, e.g. for recordPayment: `titleKey: 'ai.preview.recordPayment', titleParams: { amount: fmtTZS(amount) }`, labels `['Student', …, 'ai.preview.label.student']`, and `warningKeys.push({ key: 'ai.preview.warn.exceedsBalance', params: { balance: fmtTZS(invoice.balance) } })`.

2. `packages/i18n/src/index.ts` — add the matching `ai.preview.*` keys to BOTH the EN block (~line 434) and the SW block (~line 1191), key sets exactly mirrored, using the existing interpolation convention.

3. `apps/mobile/src/app/(tabs)/assistant.tsx:282-297` and `apps/web/src/app/assistant/assistant-view.tsx:197-210` — render `action.preview.titleKey ? t(titleKey, titleParams) : action.preview.title`, same fallback for each line label and for `warningKeys` vs `warnings`.

Do NOT localise server-side off a request `lang` field: the preview is persisted in `ai_proposed_actions.preview` and re-read at confirm time, so a stored translation would freeze the language of the row.

---

### 55. searchStaff requires members.manage, a permission granted to no role — every non-owner is permanently denied the tool the system prompt tells the model to use first

- **Location:** `apps/api/src/ai/ai-tools.service.ts:1446`
- **Category:** access-control · **Verdict:** CONFIRMED (high) · **Found by:** authz-permissions+ai-security

**What is wrong.** 'members.manage' exists in public.permissions (seed.sql:32) but appears in no role_permissions grant in any migration or seed. Only school_owner/director pass via the SUPER_ROLES bypass, so searchStaff always returns PERMISSION_DENIED for head_teacher, school_admin, academic_master, bursar and everyone else.

**How it fails.** A head_teacher (who holds timetable.manage and members.invite) asks the assistant "Put Asha on Form 1 A Monday period 1 for Maths". System prompt rule 8 tells the model to resolve the staff member with searchStaff first; the call returns `PERMISSION_DENIED: your role cannot access searchStaff`, so the model cannot discover the exact stored full_name. It then calls proposeSetTimetableSlot with teacherName:"Asha", and resolveTimetableSlot (ai-actions.service.ts:212-221) requires an exact normalised match against profiles.full_name — "Asha Mwinyi" does not equal "Asha" — so the user gets TEACHER_NOT_FOUND with no way to find the right spelling. The same dead end blocks proposeInviteStaff's "who is already on staff?" step. Owners never see the bug, so it survives manual testing.

**Evidence.**

```
permission: 'members.manage',
    execute: async (supabase, ctx, args) => {
…
(seed.sql:32)  ('members.manage', 'settings', 'Manage members and roles'),
// grep across supabase/migrations + seed.sql: 'members.manage' never appears in any role_permissions insert
```

**Fix.** Fix the missing grant rather than the tool, since `members.manage` gates two consumers and only two (`ai-tools.service.ts:1446` searchStaff and `invitations.controller.ts:170-172` GET /api/v1/staff — verified by grep, nothing else):

1. Add an additive migration `supabase/migrations/00000000000029_members_manage_grant.sql` inserting `role_permissions` rows for `members.manage` on the system roles `head_teacher` and `school_admin`, using the existing idempotent pattern (`insert … select r.id, 'members.manage' from public.roles r where r.tenant_id is null and r.is_system and r.key in ('head_teacher','school_admin') on conflict do nothing;`). The permission key row already exists, so no `public.permissions` insert is needed.
2. Mirror it in `supabase/seed.sql`: add `'members.manage'` to the `head_teacher` array (currently line ~90, next to `'members.invite'`) and to the `school_admin` array (line ~101).
3. If academic_master should also be able to resolve teachers for timetable proposals, either add them to the same grant or, as the narrower alternative, change `apps/api/src/ai/ai-tools.service.ts:1446` to `permission: 'timetable.manage'`-equivalent gating — but note that alone leaves `GET /api/v1/staff` still owner-only.
4. Add an `apps/api/scripts/eval-ai.mjs` case that runs a staff lookup as a non-owner (head_teacher) member so the regression is caught; today no smoke or eval references `searchStaff` at all.

---

### 56. getSchoolOverview leaks the plan key and subscription usage to any holder of students.view, bypassing the OWNER gate on getSubscriptionUsage

- **Location:** `apps/api/src/ai/ai-tools.service.ts:63`
- **Category:** access-control · **Verdict:** CONFIRMED (high) · **Found by:** ai-security

**What is wrong.** getSubscriptionUsage is deliberately permission:'OWNER' (line 490) and the eval harness asserts a teacher must be denied plan information, but getSchoolOverview — permission:'students.view', which the seeded teacher role holds — returns ctx.entitlements.planKey and the full usage document.

**How it fails.** An ordinary teacher (seed.sql grants the teacher role 'students.view') opens Ask ATLAS and types "Give me an overview of the school" — one of the four suggestion chips the UI ships with. getSchoolOverview passes the permission check and returns `plan: 'msingi'` plus `usage: {students, staff, campuses, smsThisMonth}`. Asking the same teacher's other question, "What plan is the school on?", correctly returns PERMISSION_DENIED from getSubscriptionUsage — so the same commercial data is denied through one tool and handed over through another. eval-ai.mjs line 123 encodes the intended posture: `{ cat: 'unauthorised', as: 'teacher', q: 'What plan is the school on?', expect: { deniedTool: 'getSubscriptionUsage' } }`.

**Evidence.**

```
getSchoolOverview: {
    …
    permission: 'students.view',
…
          activeStaff: staff.count ?? 0,
          classSections: sections.count ?? 0,
          plan: ctx.entitlements.planKey,
          usage: ctx.entitlements.usage,
```

**Fix.** In `apps/api/src/ai/ai-tools.service.ts`, gate the two commercial fields in `getSchoolOverview`'s payload on the same test `getSubscriptionUsage` uses. Replace lines 113-114:

```ts
          plan: ctx.entitlements.planKey,
          usage: ctx.entitlements.usage,
```
with
```ts
          ...(ctx.isOwner
            ? { plan: ctx.entitlements.planKey, usage: ctx.entitlements.usage }
            : {}),
```

Also amend the tool description on lines 59-61 — drop "current plan and usage" or qualify it as "(plan and usage for school owner/director only)" — otherwise the model will keep advertising plan data it cannot deliver to a teacher and will produce confusing replies.

Optional hardening of the eval so this cannot regress silently: in `apps/api/scripts/eval-ai.mjs` line 123, change the case to a leak guard on the actual value rather than the `trial_ends` key, e.g. `expect: { deniedTool: 'getSubscriptionUsage', leakGuard: 'msingi' }` (or whatever plan the eval tenant is seeded onto), since the current `deniedTool` scoring at lines 221-227 would pass even when the plan is disclosed through `getSchoolOverview`.

---

### 57. generateReport via the assistant writes no report.requested audit entry, unlike the HTTP reports endpoint

- **Location:** `apps/api/src/ai/ai-tools.service.ts:971`
- **Category:** audit · **Verdict:** CONFIRMED (high) · **Found by:** ai-security

**What is wrong.** ReportsController.create inserts an audit_logs row for every queued report; the AI tool inserts the report_jobs row directly and skips the audit insert entirely.

**How it fails.** A bursar asks the assistant "Generate the fee statement for student STU-00042 as a PDF". The tool queues the job and the worker produces a PDF containing that family's full financial history. Later a school owner reviews audit_logs after a data-handling complaint and sees no report.requested entry — the AI path left only an ai_tool_calls row (which migration 0027 has just made service-role-only, so the owner cannot read it through the app either). Identical requests made from the Reports page ARE logged, so the audit trail silently depends on which surface the user chose.

**Evidence.**

```
const { data: job, error } = await supabase.admin
        .from('report_jobs')
        .insert({ tenant_id: ctx.tenantId, report_key: args.reportKey, … })
        .select('id')
        .single();
      if (error) throw new Error(error.message.slice(0, 200));
      return { data: { jobId: job.id as string, … } };
// vs reports.controller.ts:146-153 which inserts audit_logs { action: 'report.requested' }
```

**Fix.** In `apps/api/src/ai/ai-tools.service.ts`, inside `generateReport.execute` (after the `report_jobs` insert succeeds, ~line 981, before the `return`), mirror the controller's audit write:

```ts
await supabase.admin.from('audit_logs').insert({
  tenant_id: ctx.tenantId,
  actor_user_id: meta.userId,
  action: 'report.requested',
  entity_type: 'report_job',
  entity_id: job.id as string,
  after: { reportKey: args.reportKey, format: args.format, source: 'ai' },
});
```

`meta.userId` is already in scope (it is used for `requested_by`), so no signature change is needed. Optionally extend `apps/api/scripts/smoke-ai.mjs` (or smoke-reports) to assert a `report.requested` row appears after an AI-queued report. Do NOT bother adding the `QueueKickService.kick` call the finder proposes — the reports worker polls every 10s (`apps/workers/src/process-reports.ts:25`) and the DB is the source of truth by design; adding the kick would require injecting QueueKickService into the free-standing `AI_TOOLS` execute closures for no correctness gain. The cleaner long-term refactor is to extract the queue-a-report logic from `ReportsController.create` into a shared service that both the controller and the AI tool call, so the two paths cannot drift again.

---

### 58. getAssessmentProgress tallies assessments in JavaScript under the 1000-row read cap, silently under-reporting once a school accumulates history

- **Location:** `apps/api/src/ai/ai-tools.service.ts:377`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** ai-security

**What is wrong.** Every other counting tool in the file deliberately uses head:true exact counts with a comment warning that the Supabase 1000-row cap would silently truncate; getAssessmentProgress instead fetches assessment rows with .limit(1000) and counts them in JS.

**How it fails.** A secondary school with 20 class sections × 3 terms × ~10 assessments per term accumulates ~600 assessments per academic year, so by year two it holds ~1200 rows. The academic master asks "How is mark entry going?" — one of the eval's own questions. The query returns exactly 1000 rows and byStatus reports e.g. {draft: 180, published: 820}, while the true figures are {draft: 210, published: 990}. The assistant reports the truncated numbers with no partial-result caveat, and the head teacher believes 30 fewer draft assessments are outstanding than actually are.

**Evidence.**

```
supabase.admin
          .from('assessments')
          .select('status')
          .eq('tenant_id', ctx.tenantId)
          .limit(1000),
…
      const byStatus: Record<string, number> = {};
      for (const a of assessments.data ?? []) {
        byStatus[a.status as string] = (byStatus[a.status as string] ?? 0) + 1;
      }
```

**Fix.** In apps/api/src/ai/ai-tools.service.ts, replace the assessments fetch-and-tally in `getAssessmentProgress` (lines 373-390) with exact head counts, mirroring `getAttendanceSummary`. The `assessments.status` check constraint (migration 0006 line 54) restricts values to 'draft' and 'published', so the two counts are exhaustive:

```ts
    execute: async (supabase, ctx) => {
      // Exact head counts per status — never fetch assessment rows and tally
      // in JS (the Supabase 1000-row cap would silently truncate schools with
      // more than a year of history). status is DB-constrained to these two.
      const STATUSES = ['draft', 'published'] as const;
      const [statusCounts, scores] = await Promise.all([
        Promise.all(
          STATUSES.map((s) =>
            supabase.admin
              .from('assessments')
              .select('id', { count: 'exact', head: true })
              .eq('tenant_id', ctx.tenantId)
              .eq('status', s),
          ),
        ),
        supabase.admin
          .from('assessment_scores')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', ctx.tenantId),
      ]);
      if (scores.error) throw new Error(scores.error.message.slice(0, 200));
      const byStatus: Record<string, number> = {};
      statusCounts.forEach((res, i) => {
        if (res.error) throw new Error(res.error.message.slice(0, 200));
        byStatus[STATUSES[i]] = res.count ?? 0;
      });
      return {
        data: {
          assessmentsByStatus: byStatus,
          marksEntered: scores.count ?? 0,
        },
      };
    },
```

Optionally also return `rowCount: byStatus.draft + byStatus.published` so the total is visible to the model. The existing `assessments_tenant_idx` and `assessments_section_term_idx (class_section_id, academic_term_id, status)` indexes keep the two counts cheap. No migration, permission, or catalogue change is needed; `node apps/api/scripts/eval-ai.mjs` (the 'academic' question at eval-ai.mjs:114) exercises the path.

---

### 59. Tool results are fed to the provider with no size cap — one clinic or library query can blow the context window and burn a school's entire monthly AI quota in a single message

- **Location:** `apps/api/src/ai/ai.controller.ts:264`
- **Category:** resource-exhaustion · **Verdict:** CONFIRMED (high) · **Found by:** ai-security

**What is wrong.** The tool result is truncated to 8000 chars for the ai_messages audit copy but the FULL JSON is pushed into the provider message array, and the array is re-sent on every subsequent round of the tool loop. Several tools return up to 500-1000 rows with kilobyte-sized free-text fields.

**How it fails.** An owner asks "Show me every clinic visit since we opened". The model calls getClinicVisits with from=2024-01-01, to=2026-12-31. That tool takes .limit(500) (ai-tools.service.ts:1237) and each row carries symptoms (max 1000 chars) plus treatment (max 1000 chars, clinic.schema.ts:7-9) — up to ~1 MB of JSON, roughly 250k tokens. The tool message is appended to `messages`, which is then re-sent on each of the remaining MAX_TOOL_ROUNDS rounds. Either the provider rejects the request (context overflow) and the user gets a bare 500 AI_PROVIDER_FAILED with no explanation, or it succeeds and the single message consumes several hundred thousand tokens — more than the whole 500,000-token monthly cap migration 0027 assigns to the trial plan, from one question.

**Evidence.**

```
const content = JSON.stringify(toolResult);
          messages.push({ role: 'tool', tool_call_id: call.id, content });
          await this.supabase.admin.from('ai_messages').insert({
            …
            content: content.slice(0, 8000),   // truncated for STORAGE only
          });
```

**Fix.** Minimal fix, one file: /Users/admin/Atlas-System/apps/api/src/ai/ai.controller.ts, replacing lines 264-272.

Add a module-level `const MAX_TOOL_CONTENT_CHARS = 12_000;` next to `MAX_TOOL_ROUNDS`, then cap what goes to the model, not just what goes to the database:

```ts
const raw = JSON.stringify(toolResult);
const content =
  raw.length > MAX_TOOL_CONTENT_CHARS
    ? JSON.stringify({
        status: toolResult.status,
        source: toolResult.source,
        rowCount: toolResult.rowCount,
        truncated: true,
        note: `Result too large — only the first ${MAX_TOOL_CONTENT_CHARS} characters are shown. Tell the user the answer is PARTIAL and ask them to narrow the date range or filter.`,
        partial: raw.slice(0, MAX_TOOL_CONTENT_CHARS),
      })
    : raw;
messages.push({ role: 'tool', tool_call_id: call.id, content });
await this.supabase.admin.from('ai_messages').insert({
  ...
  content: content.slice(0, 8000),
});
```

The `truncated: true` marker matters because SYSTEM_PROMPT rule 5 already tells the model to "mention when a result may be partial" — without the flag it silently answers as if the set were complete.

Also worth doing (same commit, ai-tools.service.ts): drop `getClinicVisits` from `.limit(500)` to `.limit(100)` at line 1237 and return `truncated: rows.length === 100` in its `data` so the model says so. 500 rows of free-text clinical notes is not a chat answer anyway.

Out of scope for this finding but adjacent and cheap: move the quota check so the loop breaks once `usedThisMonth + totalPrompt + totalCompletion >= quotaLimit` (an in-loop check after line 213), which bounds a single request's overshoot to one round rather than five.

---

### 60. AI monthly token quota is checked non-atomically before the provider call, so concurrent requests can overshoot the cap by far more than the documented "one request"

- **Location:** `apps/api/src/ai/ai.controller.ts:121`
- **Category:** resource-exhaustion · **Verdict:** CONFIRMED (high) · **Found by:** ai-security+concurrency-idempotency

**What is wrong.** tokensUsedThisMonth() sums ai_usage_records, but usage for the current request is only INSERTed in the finally block after the whole tool loop finishes. Concurrent requests therefore all read the same pre-request total and all pass the gate; the code comment asserting the budget "can overshoot by at most one request's usage" does not hold.

**How it fails.** A school on the trial plan has 499,000 of its 500,000 aiMonthlyTokens used (migration 0027 seeds trial=500000). Ten staff members send a message within the same second — well inside the 60/min/IP throttle, and a school shares one NAT'd IP so the throttle does not separate them. All ten calls run tokensUsedThisMonth concurrently, all read 499,000 < 500,000, and all proceed. Each may make up to MAX_TOOL_ROUNDS+1 = 5 provider calls with max_tokens 1200 plus a growing prompt, so the tenant burns tens of thousands of tokens past a cap that was already exhausted, and nothing rejects until the next request. A tenant whose plan row predates 0027 (no aiMonthlyTokens key) fails open to unlimited spend entirely, since aiMonthlyTokenLimit returns null.

**Evidence.**

```
const quotaLimit = this.aiMonthlyTokenLimit(req.tenant);
    let usedThisMonth = 0;
    if (quotaLimit !== null) {
      usedThisMonth = await this.tokensUsedThisMonth(req.tenant.tenantId);
      if (usedThisMonth >= quotaLimit) { … }
    }
…
    // "One check per request: a request that passes can
    // still spend up to MAX_TOOL_ROUNDS+1 provider calls, so the budget can
    // overshoot by at most one request's usage."
```

**Fix.** Reserve the budget atomically in Postgres (house rule: business logic in NestJS + Postgres, never in JS; an in-process mutex would be wrong anyway since the API can run multiple instances).

1. New additive migration `supabase/migrations/00000000000029_ai_quota_reservation.sql`:
   - `app.ai_reserve_usage(p_tenant_id uuid, p_limit bigint) returns uuid` — takes `pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 0))` to serialise per tenant, does a single `select coalesce(sum(prompt_tokens + completion_tokens), 0) from public.ai_usage_records where tenant_id = p_tenant_id and created_at >= date_trunc('month', now() at time zone 'utc')`, raises when the sum >= p_limit, otherwise inserts a zero-token row and returns its id. The advisory lock plus the in-transaction insert closes the window: a concurrent caller blocks, then re-reads a total that already includes the reservation.
   - Service-role-only `public.ai_reserve_usage(...)` wrapper (PostgREST exposes only `public`) with explicit `revoke all ... from anon, authenticated` / `grant execute ... to service_role`, matching the existing wrapper pattern.

2. `apps/api/src/ai/ai.controller.ts`:
   - Replace the lines 121-135 block: when `quotaLimit !== null`, call `this.supabase.admin.rpc('ai_reserve_usage', { p_tenant_id: req.tenant.tenantId, p_limit: quotaLimit })`, keep the existing 429 `{ code: 'AI_QUOTA_EXCEEDED', limit, used }` mapping for the raise, and hold the returned reservation id.
   - In the `finally` at lines 281-293: when a reservation id exists, `update` that row with the real `prompt_tokens`/`completion_tokens` (and delete it when both are 0) instead of inserting a new row; keep the current insert path for the unlimited-plan case so accounting still accrues.
   - Delete `tokensUsedThisMonth()` (lines 74-102) — its paginated JS sum also silently under-counts past 100 pages / 100k rows and costs up to 100 round-trips; the SQL SUM() replaces it. Have the reservation function also return the pre-reservation total so the `quota.remaining` field at lines 314-323 keeps working.
   - Fix the now-false comment at lines 117-120.

3. Optional, separate decision: leave absent `aiMonthlyTokens` = unlimited as-is (it is documented intentional backward-compat and 0027 backfills every seeded plan), but consider making it fail closed once 0027 is applied everywhere.

---

### 61. `AI_QUOTA_EXCEEDED` is unmapped in both error maps — exhausting the AI allowance shows a raw code and never reaches the 429 message

- **Location:** `apps/api/src/ai/ai.controller.ts:128`
- **Category:** user-visible-error · **Verdict:** CONFIRMED (medium) · **Found by:** gap:tenant-facing subscription/entitlement surface (schools are blind to their own trial and limits)

**What is wrong.** The AI chat quota gate throws HTTP 429 with {code:'AI_QUOTA_EXCEEDED', limit, used}, but neither error map contains the code and apiErrorMessage checks `code` before `status === 429`, so the user sees "Something went wrong (AI_QUOTA_EXCEEDED)" instead of a quota message — and the returned limit/used numbers are discarded.

**How it fails.** A school on Msingi (2,000,000 tokens/month after migration 0027) hits the cap on 20 March. The head teacher types a question in "Ask ATLAS": POST /ai/chat returns 429 {code:'AI_QUOTA_EXCEEDED', limit:2000000, used:2000431}. assistant-view.tsx:87 calls apiErrorMessage(t, body, 429); since `code` is truthy the function never reaches the `status === 429` branch that would return "Too many requests. Wait a moment and try again.", and since AI_QUOTA_EXCEEDED is not in ERROR_KEYS and has no _NOT_FOUND/_INVALID/_FAILED suffix, it returns "Something went wrong (AI_QUOTA_EXCEEDED)". The school has no in-product AI usage meter (grep for ai_usage/tokens/quota in apps/web/src and apps/mobile/src matches only platform-view.tsx's super-admin "AI tokens" column), so it cannot tell whether it is broken, rate-limited, or out of allowance, nor when it resets.

**Evidence.**

```
apps/api/src/ai/ai.controller.ts:125-134 `if (usedThisMonth >= quotaLimit) { throw new HttpException({ code: 'AI_QUOTA_EXCEEDED', limit: quotaLimit, used: usedThisMonth }, HttpStatus.TOO_MANY_REQUESTS); }`. apps/web/src/lib/api-error.ts:12-38 has no AI_QUOTA_EXCEEDED entry, and lines 46-55 order the checks `if (code) { ... return `${t("err.generic")} (${code})`; } if (status === 429) return t("err.rateLimited");` — the code branch always wins. Same in apps/mobile/src/lib/api-error.ts:45-54. apps/web/src/app/assistant/assistant-view.tsx:87 `setError(apiErrorMessage(t, body, res.status));`. No `aiQuota`/`quotaExceeded` key exists in packages/i18n/src/index.ts.
```

**Fix.** Add the missing mapping in the two error maps and the shared dictionary (keys must be mirrored EN+SW per the iron rules). 1) packages/i18n/src/index.ts — add to BOTH dictionaries, next to the existing err.planLimit* entries: EN "err.aiQuotaExceeded": "This school's AI allowance for this month is used up. It resets at the start of next month — or upgrade the plan for a larger allowance."; SW "err.aiQuotaExceeded": "Kiasi cha AI cha shule kwa mwezi huu kimeisha. Kitaanza upya mwanzoni mwa mwezi ujao — au boresha mpango kupata kiasi kikubwa zaidi." 2) apps/web/src/lib/api-error.ts — in ERROR_KEYS, under the "Plan / subscription enforcement" comment block (lines 13-19), add: AI_QUOTA_EXCEEDED: "err.aiQuotaExceeded". 3) apps/mobile/src/lib/api-error.ts — add the identical entry in the same block (lines 9-15) to keep the two files in sync as its header comment requires. Do NOT reorder the code/status checks in apiErrorMessage — err.rateLimited is the wrong message for a monthly quota. Interpolating limit/used and adding an in-product usage meter are enhancements, not part of the minimal fix.

---

### 62. Combination presets write header and subjects in two unbatched statements, and the idempotent skip prevents ever repairing a half-written combination

- **Location:** `apps/api/src/assessments/academics.controller.ts:106`
- **Category:** atomicity · **Verdict:** CONFIRMED (high) · **Found by:** concurrency-idempotency

**What is wrong.** Each A-Level combination is created as an insert into subject_combinations followed by a separate insert into subject_combination_subjects, in a loop with awaits and no transaction. A failure between them leaves a combination with zero subjects; because the endpoint skips any code that already exists, re-running the preset never repairs it.

**How it fails.** An academic master clicks 'Load ACSEE presets'. PCB is created, then the subject_combination_subjects insert for PCB fails (transient pooler error) or the request is aborted mid-loop. The handler throws COMBINATION_PRESET_FAILED, but the PCB header row is already committed. On the retry, `if (have.has(preset.code)) continue;` skips PCB, so it stays subject-less forever while the presets after it in the array were never created either. Students are then assigned to PCB via assignCombination; the assistant's preview renders 'Subjects: ' empty (ai-actions.service.ts:299-310), and the NECTA candidate export and CA summary for those students carry no principal subjects — a wrong NECTA registration.

**Evidence.**

```
apps/api/src/assessments/academics.controller.ts:98-137 —
```
for (const preset of COMBINATION_PRESETS) {
  if (have.has(preset.code)) continue;
  ...
  const { data: combination, error } = await this.supabase.admin
    .from('subject_combinations').insert({ tenant_id: ..., code: preset.code, name: preset.name })
    .select('id').single();
  if (error) { throw new InternalServerErrorException({ code: 'COMBINATION_PRESET_FAILED', ... }); }
  const { error: subjectsError } = await this.supabase.admin
    .from('subject_combination_subjects').insert(resolved.map(...));
  if (subjectsError) { throw new InternalServerErrorException({ code: 'COMBINATION_PRESET_FAILED', ... }); }
  created += 1;
}
```
The doc comment at :63-67 claims the endpoint is "idempotent like /subjects/preset", but the skip is keyed on the header row alone. Two concurrent calls also both compute `have` and then collide on the unique (tenant_id, code), aborting the loop midway.
```

**Fix.** Minimal in-place fix in apps/api/src/assessments/academics.controller.ts:

1. Make the skip condition require subject rows. Change the second lookup (lines 81-84) to `select('code, subject_combination_subjects(combination_id)')` (or `select('id, code, subject_combination_subjects!inner(combination_id)')`) and build `have` only from rows whose `subject_combination_subjects.length > 0`; keep a separate `Map<code, id>` of headers that exist but are empty.
2. In the loop, when the code is in that empty-header map, skip the `subject_combinations` insert and go straight to the `subject_combination_subjects` insert against the existing id with `.upsert(..., { onConflict: 'combination_id,subject_id', ignoreDuplicates: true })` — this repairs the half-written row on the next click.
3. Add a compensating delete: if the subject-rows insert fails, `await this.supabase.admin.from('subject_combinations').delete().eq('id', combination.id)` before throwing COMBINATION_PRESET_FAILED, so the transient case leaves no orphan at all.
4. Treat a `23505` duplicate-key error on the header insert as `continue` rather than a 500, which kills the concurrent-caller race.

House-rules fix (preferred, matches the "business logic in Postgres" iron rule): add `app.seed_combination_presets(p_tenant_id uuid, p_presets jsonb)` in a new additive migration (0029) with the public service-role-only wrapper, doing header + subject inserts in one transaction per combination and `on conflict (tenant_id, code) do nothing` + `on conflict (combination_id, subject_id) do nothing`, and have the controller call it once with COMBINATION_PRESETS serialised.

---

### 63. Hand-rolled `isoDate` regex accepts impossible calendar dates — clinic date filter throws an uncaught RangeError (500) or silently returns the wrong window

- **Location:** `apps/api/src/clinic/clinic.schema.ts:3`
- **Category:** input-validation · **Verdict:** CONFIRMED (high) · **Found by:** input-validation

**What is wrong.** Six schemas validate dates with `/^\d{4}-\d{2}-\d{2}$/`, which admits `2026-02-30` and `2026-13-01`, while `finance.schema.ts` correctly uses `z.string().date()` (leap-year aware). In `clinic.controller.ts` the value is fed to `new Date(...).toISOString()`, which either throws or silently rolls the date over.

**How it fails.** `GET /api/v1/clinic/visits?from=2026-13-01` passes `visitsQuerySchema` (the regex matches), then `new Date('2026-13-01T00:00:00+03:00')` is `Invalid Date` and `.toISOString()` raises an **uncaught `RangeError: Invalid time value`** inside the controller — the request 500s as `{code:'INTERNAL'}` and fires a Sentry event, with no stable code the UI can map. Worse silently: `?from=2026-02-30` does *not* throw — I measured it resolving to `2026-03-01T21:00:00.000Z`, so the nurse asking for visits from 30 February gets a window starting a day and a half later and quietly loses records, with no warning. The same loose regex reaches Postgres `date` columns elsewhere: `POST /api/v1/attendance` with `date:'2026-02-30'` makes `.eq('session_date', ...)` fail with SQLSTATE 22008, which the handler converts to a 500 `ATTENDANCE_LOOKUP_FAILED` instead of a 400.

**Evidence.**

```
apps/api/src/clinic/clinic.schema.ts:3,14-15
```ts
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
...
export const visitsQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});
```
apps/api/src/clinic/clinic.controller.ts:70-81 (no try/catch around the conversion):
```ts
    if (parsed.data.from) {
      builder = builder.gte(
        'visited_at',
        new Date(`${parsed.data.from}T00:00:00+03:00`).toISOString(),
      );
    }
```
Measured with node 22:
```
2026-02-30 -> 2026-03-01T21:00:00.000Z      (silent rollover)
2026-13-01 -> THROWS RangeError: Invalid time value
2026-02-31 -> 2026-03-02T21:00:00.000Z      (silent rollover)
```
Same loose regex at attendance.schema.ts:3, students.schema.ts:3, library.schema.ts:3, onboarding.schema.ts:3, reports.controller.ts:22 — versus the correct `z.string().date()` at finance.schema.ts:3.
```

**Fix.** Minimal fix (the only site that actually throws): in /Users/admin/Atlas-System/apps/api/src/clinic/clinic.schema.ts line 3, change

  const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

to

  const isoDate = z.string().date('Expected YYYY-MM-DD');

This is exactly what /Users/admin/Atlas-System/apps/api/src/finance/finance.schema.ts:3 already does, needs no new dependency (zod is pinned at ^3.25.76, which has `.date()`), and turns the RangeError into the existing stable 400 `{code:'CLINIC_QUERY_INVALID'}` that clinic.controller.ts:56-59 already returns. Verified: every string `.date()` accepts converts to a valid Date, so the `new Date(...).toISOString()` at clinic.controller.ts:73,79 can no longer throw and no try/catch is needed.

Consistency follow-up (low priority, no live throw at any of these — they all fail closed at Postgres with a 500 instead of a 400): apply the same one-line swap at attendance.schema.ts:3, students.schema.ts:3, library.schema.ts:3, onboarding.schema.ts:3, platform.controller.ts:56, reports.controller.ts:22, and ai-actions.service.ts:966,1062,1746. Best done by exporting a single `isoDate` from a shared module (e.g. apps/api/src/common/schema.ts) and importing it in all ten places so the copies cannot drift again.

Do NOT treat this as a security fix or block a release on it.

---

### 64. Clinic `treatment` free-text (max 1000) is interpolated verbatim into the guardian SMS, which is capped at 480 everywhere else — multiplies SMS billing 8×

- **Location:** `apps/api/src/clinic/clinic.schema.ts:8`
- **Category:** input-validation · **Verdict:** CONFIRMED (high) · **Found by:** input-validation

**What is wrong.** `createAnnouncementSchema` caps SMS body at 480 characters precisely because outbox rows become billed SMS, but `recordVisitSchema.treatment` allows 1000 characters and `renderBody('clinic.visit')` embeds it whole with no truncation.

**How it fails.** A school nurse pastes a full 1000-character treatment note into the clinic form and ticks "notify guardian". `app.record_clinic_visit` copies the untruncated string into `notification_outbox.payload.treatment`, and `renderBody` produces `… alihudumiwa katika zahanati ya shule leo. Matibabu: <1000 chars>. Asante. - <school>` ≈ 1130 characters. Beem bills concatenated GSM-7 at 153 chars/segment, so that single notification is charged as **8 SMS**; if the note contains any non-GSM character (a pasted curly quote, an em dash, an emoji) the message drops to UCS-2 at 67 chars/segment and is charged as **17 SMS**. Across a flu week with 200 clinic visits the school is billed for ~1,600–3,400 messages instead of 200 — and CLAUDE.md records that the `smsMonthly` plan cap is metered but unenforced, so nothing stops it.

**Evidence.**

```
apps/api/src/clinic/clinic.schema.ts:6-11
```ts
export const recordVisitSchema = z.object({
  studentId: z.string().uuid(),
  symptoms: z.string().trim().min(2).max(1000),
  treatment: z.string().trim().max(1000).optional(),
  notes: z.string().trim().max(1000).optional(),
  notifyGuardian: z.boolean().default(false),
});
```
The comparable SMS path is capped at 480 — apps/api/src/communication/communication.schema.ts:7: `body: z.string().trim().min(3).max(480),`
supabase/migrations/00000000000023_clinic.sql:84 — the full value is queued: `'treatment', nullif(trim(p_treatment), ''),`
apps/workers/src/drain-outbox.ts:48-59 — interpolated with no length guard:
```ts
  if (template === "clinic.visit") {
    const treatment =
      typeof payload.treatment === "string" && payload.treatment.trim() !== ""
        ? ` Matibabu: ${payload.treatment}.`
        : "";
    return (
      `Mpendwa ${payload.guardianName ?? "Mzazi/Mlezi"}. ` +
      `Mwanafunzi ${payload.studentName} (${payload.studentNumber}) ` +
      `alihudumiwa katika zahanati ya shule leo.${treatment} ` +
```
```

**Fix.** Clamp in the worker, not the DB — that covers rows already queued and needs no migration (0023 is written but unapplied, yet CLAUDE.md's additive-only rule makes editing it the worse option, and a DB-side left() would not protect other templates). In /Users/admin/Atlas-System/apps/workers/src/drain-outbox.ts: (1) in the `clinic.visit` branch at lines 50-53, truncate the interpolated value — `const raw = String(payload.treatment).trim(); const clipped = raw.length > 120 ? raw.slice(0, 117) + '...' : raw;` and interpolate `clipped`; (2) add a single global backstop so no future template can leak an unbounded field into a billed message — wrap the existing renderBody as `renderBodyRaw` and add `function renderBody(t, p) { const b = renderBodyRaw(t, p); return b.length > 320 ? b.slice(0, 317) + '...' : b; }` (320 = two concatenated GSM-7 segments' worth of headroom; keep it above the 480 announcement cap only if you intend announcements to stay 3 segments — if so use 480 as the global bound and 120 for the clinic field). Optionally also tighten /Users/admin/Atlas-System/apps/api/src/clinic/clinic.schema.ts:8 and the mirrored ai-actions.service.ts:1831 argsSchema to keep the 1000-char clinical record but document that only the first ~120 chars reach the guardian SMS. Separately worth a follow-up (not this fix): smsThisMonth/platform-metrics count outbox rows, so any future smsMonthly enforcement should count segments, i.e. ceil(len/153), not count(*).

---

### 65. Token field accepts any 10-300 char string with no per-user cap — unbounded device_tokens growth

- **Location:** `apps/api/src/devices/devices.schema.ts:4`
- **Category:** resource-exhaustion · **Verdict:** CONFIRMED (high) · **Found by:** gap:devices / push-token registry (no TenantGuard, no permission, no smoke suite, zero findings)

**What is wrong.** registerDeviceSchema validates only length, not the `ExponentPushToken[...]` / `ExpoPushToken[...]` shape, and register() enforces no ceiling on rows per user. The only limit is the global 300-req/min/IP throttler, so one signed-in account can write junk rows into an API-only table that has no cleanup path and no smoke coverage.

**How it fails.** A parent with a valid portal login (guardians authenticate with no tenant membership at all, so nothing else in the API is reachable to them) scripts `for i in 1..N: POST /api/v1/devices {"token": "junk-"+i, "platform":"ios"}`. Each distinct string misses the unique index and INSERTs a fresh row. At the global cap of 300 requests/min that is 432,000 rows per day per IP, and rotating the source IP multiplies it. Nothing ever deletes them: `last_seen_at` exists solely so a worker that does not exist yet could "drop stale tokens". When the sender is built it will additionally attempt an Expo Push API call per junk row, and `device_tokens_user_idx`/`device_tokens_tenant_idx` bloat alongside.

**Evidence.**

```
apps/api/src/devices/devices.schema.ts:3-7
```ts
export const registerDeviceSchema = z.object({
  token: z.string().trim().min(10).max(300),
  platform: z.enum(['ios', 'android']),
  tenantId: z.string().uuid().optional(),
});
```
The only rate limit in play — apps/api/src/app.module.ts:55:
```ts
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
```
(compare apps/api/src/onboarding/onboarding.controller.ts:24, which adds a tighter per-route `@Throttle` for exactly this class of abuse; /devices has none). The only retention hint is a comment, supabase/migrations/00000000000028_device_tokens.sql:46-47: "Touched on every re-registration; lets the future send worker drop stale tokens."
```

**Fix.** In `/Users/admin/Atlas-System/apps/api/src/devices/devices.controller.ts`:

1. Add a per-route throttle on the `@Post()` handler (a real device re-registers a handful of times a day):
```ts
import { Throttle } from '@nestjs/throttler';
...
@Post()
@Throttle({ default: { limit: 10, ttl: 60_000 } })
async register(...)
```

2. Cap rows per user inside the same request, after the upsert succeeds. Do NOT use a PostgREST `delete().order().limit()` — select the survivors' ids first, then delete the remainder:
```ts
const KEEP = 10;
const { data: mine } = await this.supabase.admin
  .from('device_tokens')
  .select('id')
  .eq('user_id', req.user.id)
  .order('last_seen_at', { ascending: false })
  .range(KEEP, KEEP + 999);
if (mine?.length) {
  await this.supabase.admin
    .from('device_tokens')
    .delete()
    .in('id', mine.map((r) => r.id as string));
}
```
This also cleans up the legitimate orphan rows left behind when a user reinstalls the app and Expo issues a new token.

3. Optional input hygiene in `/Users/admin/Atlas-System/apps/api/src/devices/devices.schema.ts:4` — `.regex(/^Expo(nent)?PushToken\[[^\]]+\]$/)` on `token` in `registerDeviceSchema` (verified compatible with what `apps/mobile/src/lib/notifications.ts` sends). Leave `unregisterDeviceSchema` length-only so already-stored legacy tokens can still be removed. Understand this is hygiene, not mitigation — it does not stop the abuse on its own.

4. Add `apps/api/scripts/smoke-devices.mjs` asserting the cap holds after N+5 registrations and that a malformed token 400s with `DEVICE_INVALID`. This must wait until migration 0028 is applied to the live dev DB (currently blocked by the handover gate).

---

### 66. Route `:id` params are never validated as UUIDs — a malformed id returns 500 instead of 404/400 on a dozen endpoints

- **Location:** `apps/api/src/finance/finance.controller.ts:381`
- **Category:** input-validation · **Verdict:** CONFIRMED (high) · **Found by:** input-validation

**What is wrong.** `@Param('id')` values are passed straight into `.eq('id', …)` filters and RPC uuid arguments with no shape check, so Postgres raises SQLSTATE 22P02 and the controllers' `rpcError`/error branches classify it as an internal failure.

**How it fails.** A stale browser tab, a truncated deep link, or a mistyped URL produces `POST /api/v1/finance/invoices/undefined/payments`. `record_payment` receives `p_invoice_id: 'undefined'`, PostgREST returns `invalid input syntax for type uuid: "undefined"`, and `rpcError` finds no match in its known-code list, so it throws `InternalServerErrorException({code:'FINANCE_RPC_FAILED'})`. The cashier sees the generic server-error message instead of "invoice not found", the request is captured as a 5xx in Sentry (adding noise that masks real incidents), and health/error dashboards show a payments failure that never was. The same pattern applies to `POST /assessments/:id/publish`, `/assessments/:id/scores`, `/payments/:id/reverse`, `/finance/invoices/:id/instalments`, `/imports/:id/approve|cancel|download`, `/hostel/allocations/:id/release`, `/library/loans/:id/return`, `/payroll/runs/:id/post|discard`, `/timetable/slots/:id`, and `/platform/tenants/:id` (where `loadTenant` turns it into `TENANT_LOOKUP_FAILED` 500 rather than the 404 the comment promises).

**Evidence.**

```
apps/api/src/finance/finance.controller.ts:363-393 — `id` goes straight to the RPC:
```ts
  @Post('invoices/:id/payments')
  @RequirePermission('finance.payments.receive')
  async recordPayment(
    @Req() req: TenantRequest,
    @Param('id') id: string,
...
    const { data, error } = await this.supabase.admin.rpc('record_payment', {
      p_tenant_id: req.tenant.tenantId,
      p_actor: req.user.id,
      p_invoice_id: id,
```
finance.controller.ts:28-37 — anything not in the known list becomes a 500:
```ts
function rpcError(error: { message: string }, known: string[]): never {
  const match = known.find((code) => error.message.includes(code));
  if (match) {
    throw new BadRequestException({ code: match, message: error.message });
  }
  throw new InternalServerErrorException({
    code: 'FINANCE_RPC_FAILED',
```
Only one route in the whole API does it right — apps/api/src/payroll/payroll.controller.ts:350: `const parsed = z.string().uuid().safeParse(userId);`
The guard proves the project already has the regex: apps/api/src/tenancy/tenant.guard.ts:56-57 `const UUID_RE = /^[0-9a-f]{8}-…/i;`
```

**Fix.** Do not hand-roll a tenth copy of UUID_RE. Add one shared pipe and apply it to the params that still lack a check. (1) New file apps/api/src/common/parse-uuid.pipe.ts exporting a preconfigured instance so the stable-code error contract is preserved: `export const ParseId = new ParseUUIDPipe({ exceptionFactory: () => new BadRequestException({ code: 'INVALID_ID' }) });` (use ParseUUIDPipe with no `version` option — ids come from gen_random_uuid, and pinning version:'4' would reject nothing useful but adds risk). (2) Apply it at the unvalidated sites only: finance.controller.ts 170, 205, 367, 405; assessments.controller.ts 183, 223; academics.controller.ts 287; reports.controller.ts 183, 201; parents.controller.ts 30 (id) and 197 (studentId); payroll.controller.ts 319, 372 — e.g. `@Param('id', ParseId) id: string`. (3) For the two shared loaders, validating at the single choke point is cheaper than touching every route: in imports.controller.ts loadJob (line 86) and platform.controller.ts loadTenant (line 110), add `if (!UUID_RE.test(id)) throw new NotFoundException({ code: 'IMPORT_JOB_NOT_FOUND' })` / `{ code: 'TENANT_NOT_FOUND' }` before the query — that also makes loadTenant honour the 404 promise in its own comment at lines 116-117. (4) Optionally fold the existing inline regexes in hostel/library/transport/inventory/timetable into the same shared pipe for consistency; that is cleanup, not a fix. Add a negative assertion to apps/api/scripts/smoke-finance.mjs (POST /finance/invoices/not-a-uuid/payments must return 400, not 500) so the regression is caught.

---

### 67. The file-import commit path applies no length or format validation to spreadsheet cells — arbitrary-length names and junk emails land in `students`/`guardians`

- **Location:** `apps/api/src/imports/imports.controller.ts:567`
- **Category:** input-validation · **Verdict:** CONFIRMED (high) · **Found by:** input-validation

**What is wrong.** `applyMapping`/`validateStudents` copy raw cell strings straight into `mapped_data`, and `app.import_commit_chunk` inserts them into `students.first_name`/`last_name` (unbounded `text`) and `guardians.email` (`citext`) — bypassing the `max(100)`/`max(200)`/`.email()` rules the JSON path enforces via `studentRowSchema`.

**How it fails.** A school imports a spreadsheet where one cell was accidentally filled by a formula drag or a paste — Excel allows 32,767 characters per cell. `validateStudents` checks gender, date, section and phone but never length, so the row is marked `valid`, and `import_commit_chunk` runs `insert into public.students (… first_name …) values (…, v_data->>'firstName', …)` into an unbounded `text` column. That student's name then blows out every roster row, every PDF report card and the debtors report, and there is no UI to fix it (students are edited nowhere). Separately, `guardianEmail` is never format-checked: a cell containing `hakuna` is stored as the guardian's email, and when an admin later clicks "Invite parent", `GuardiansController.invite` mints an `invitations` row for `hakuna` and returns an invite URL that no one can ever accept, because `accept_invitation` compares it against the signed-in user's real address.

**Evidence.**

```
apps/api/src/imports/imports.controller.ts:561-570 — the only transformation applied:
```ts
    for (const [header, field] of Object.entries(mapping)) {
      if (!field) continue;
      const value = raw[header];
      if (value !== undefined && value !== '') out[field] = value;
    }
```
No length or email check anywhere in `validateStudents` (imports.controller.ts:572-712) — it only runs `splitFullName`, `normalizeGender`, `parseDate`, `normalizePhone` and duplicate detection.
supabase/migrations/00000000000011_import_pipeline.sql:194-217 — the values go in verbatim:
```sql
        values
          (p_tenant_id, v_job.campus_id, v_number,
           v_data->>'firstName', nullif(v_data->>'middleName',''), v_data->>'lastName',
...
            insert into public.guardians (tenant_id, full_name, phone, email)
            values (p_tenant_id, v_data->>'guardianName',
                    nullif(v_data->>'guardianPhone',''),
                    nullif(v_data->>'guardianEmail','')::citext)
```
supabase/migrations/00000000000004_students_guardians_invitations.sql:12-14 — `first_name text not null`, `middle_name text`, `last_name text not null` (no length bound).
Contrast apps/api/src/students/students.schema.ts:6-8,17: `firstName: z.string().trim().min(1).max(100)`, `email: z.string().trim().email().max(200).optional()`.
```

**Fix.** In `apps/api/src/imports/imports.controller.ts`, inside `validateStudents` (after the name/gender block, ~line 641), add explicit field checks that emit `RowIssue`s so they surface in the dry-run report instead of committing silently:

1. Length: for `firstName`, `middleName`, `lastName` push `{ field, code: 'NAME_TOO_LONG', message }` when `data[field].length > 100`; for `guardianName` when `> 200`; for `guardianEmail` when `> 200`. Add `'NAME_TOO_LONG'` to the `hard` code list at line 727-736 so the row is marked `invalid` (a name over 100 chars is never a real name).
2. Email format: if `data.guardianEmail`, run it through the same rule the JSON path uses — `z.string().trim().email().max(200).safeParse(...)` — and on failure push `{ field: 'guardianEmail', code: 'EMAIL_INVALID' }`. Keep this a warning (not in the `hard` list) and `delete data.guardianEmail` so the junk value is simply dropped rather than stored; that both preserves the row and prevents `GuardiansController.invite` from minting an unacceptable invitation.
3. Same-root fix worth doing in the same edit: normalize `guardianRelationship` against `['mother','father','guardian','sponsor','other']` (case-insensitively, defaulting to `'guardian'` on no match), otherwise `student_guardians`'s CHECK constraint turns a dry-run-`valid` row into a raw `sqlerrm` in `commit_error` at mig 0011:277.

Do NOT wire `importRowSchema` in wholesale as originally proposed: its `guardian` sub-object is nested while `mapped_data` is flat, and a blanket parse would promote current warnings (invalid phone, missing DOB) to hard failures.

Optional backstop, additive migration 0029: `alter table public.students add constraint students_name_len check (char_length(first_name) <= 100 and char_length(coalesce(middle_name,'')) <= 100 and char_length(last_name) <= 100) not valid;` plus the equivalent on `guardians.full_name` (<=200) / `guardians.email` (<=200). Use `not valid` so existing rows are unaffected, per the additive-only migration rule.

---

### 68. POST /imports/:id/cancel reports `{cancelled:true}` without checking that the update matched any row

- **Location:** `apps/api/src/imports/imports.controller.ts:494`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** workers-outbox

**What is wrong.** The cancel handler re-guards the status inside the UPDATE (`.in('status', ['uploaded','validated','queued'])`) but never inspects the result. When the worker has already flipped the job to `committing` between the `loadJob` read and the UPDATE, zero rows change — yet the API writes an `import.cancelled` audit log and returns success while the import runs to completion.

**How it fails.** A bursar approves an 800-row student import, then immediately notices the wrong file was uploaded and clicks Cancel. `POST /imports/:id/approve` fired `queue.kick`, so the BullMQ worker picks the job up within ~1s and `app.import_commit_chunk` sets `status='committing'` (migration 0011 lines 169-171). The cancel request's `loadJob` read still saw `queued` and passed the pre-check; by the time the UPDATE executes the row is `committing`, so the `.in(...)` filter matches nothing. The API returns `{ cancelled: true }`, the web view shows the job as cancelled, and an `import.cancelled` entry lands in `audit_logs` — while all 800 wrong students, guardians and enrolments are created. The audit trail now actively lies about what happened.

**Evidence.**

```
apps/api/src/imports/imports.controller.ts:482-494:
```ts
    await this.supabase.admin
      .from('import_jobs')
      .update({ status: 'cancelled' })
      .eq('id', job.id)
      .in('status', ['uploaded', 'validated', 'queued']);
    await this.supabase.admin.from('audit_logs').insert({
      ...
      action: 'import.cancelled',
      ...
    });
    return { cancelled: true };
```
Compare the sibling `approve` handler at lines 448-456, which does it correctly:
```ts
      .eq('status', 'validated') // guard against double-approve races
      .select('id');
    if (!updated || updated.length === 0) {
      throw new BadRequestException({ code: 'IMPORT_JOB_NOT_VALIDATED' });
    }
```
The worker claims the job immediately after approve via `queue.kick('imports', ...)` at line 465-471.
```

**Fix.** In apps/api/src/imports/imports.controller.ts, cancel handler (lines 482-486): destructure the result and check it, mirroring approve. Replace the fire-and-forget update with:

const { data: cancelled, error: cancelErr } = await this.supabase.admin
  .from('import_jobs')
  .update({ status: 'cancelled' })
  .eq('id', job.id)
  .eq('tenant_id', req.tenant.tenantId)
  .in('status', ['uploaded', 'validated', 'queued'])
  .select('id');
if (cancelErr) throw new InternalServerErrorException({ code: 'IMPORT_CANCEL_FAILED' });
if (!cancelled || cancelled.length === 0) {
  throw new BadRequestException({ code: 'IMPORT_JOB_NOT_CANCELLABLE' });
}

Only then insert the audit_logs row and return { cancelled: true }. IMPORT_JOB_NOT_CANCELLABLE is already the code used by the pre-check at line 480, so no new error code or i18n key is needed (packages/i18n error maps already cover it). Optionally also add `this.assertDomainPermission(req, job.domain)` after loadJob for parity with approve.

---

### 69. Parent portal attendance totals silently stop counting past 1000 records, and the endpoint is N+1 per child

- **Location:** `apps/api/src/parents/parents.controller.ts:143`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** data-integrity-perf

**What is wrong.** GET /portal/children fetches every attendance_record ever written for each child with no date filter and no limit, then tallies statuses in JS; PostgREST truncates at 1000 rows, so a child past their ~5th school year shows frozen/incorrect attendance. It also issues 6 queries per child inside a per-child loop.

**How it fails.** A parent of a Standard 6 pupil opens the portal. The child has ~190 attendance records per year × 6 years = ~1,140 rows; the read returns an arbitrary 1,000 of them, so the portal reports e.g. `{present: 940, absent: 55, late: 5}` — a number that stops moving no matter how the child attends from then on, and whose absent count is understated because the truncation is unordered. Separately, a guardian linked to 4 children triggers 4 × 6 = 24 sequential round-trips (students, tenants, academic_terms, invoices, payments, attendance_records) inside the `for (const link of links)` loop, so portal latency scales linearly with family size.

**Evidence.**

```
apps/api/src/parents/parents.controller.ts:104 and 130-153
```ts
    for (const link of links) {
      const [{ data: student }, { data: tenant }, { data: terms }] =
        await Promise.all([ ... ]);
...
      const [{ data: invoices }, { data: payments }, { data: attendance }] =
        await Promise.all([
          ...
          this.supabase.admin
            .from('attendance_records')
            .select('status')
            .eq('student_id', link.studentId)
            .eq('tenant_id', link.tenantId),
        ]);

      const attendanceCounts: Record<string, number> = {};
      for (const record of (attendance ?? []) as Array<{ status: string }>) {
        attendanceCounts[record.status] =
          (attendanceCounts[record.status] ?? 0) + 1;
      }
```
supabase/config.toml `max_rows = 1000` caps the read.
```

**Fix.** In `apps/api/src/parents/parents.controller.ts`, replace the unbounded attendance fetch (lines 142-146) and the JS tally (lines 149-153) with exact head counts, copying the pattern already used at `apps/api/src/ai/ai-tools.service.ts:154-176`:

```ts
const STATUSES = ['present', 'absent', 'late', 'excused'] as const;
const counts = await Promise.all(
  STATUSES.map((s) =>
    this.supabase.admin
      .from('attendance_records')
      .select('id, attendance_sessions!inner(tenant_id, session_date)', {
        count: 'exact',
        head: true,
      })
      .eq('student_id', link.studentId)
      .eq('attendance_sessions.tenant_id', link.tenantId)
      .gte('attendance_sessions.session_date', currentTerm.starts_on)
      .lte('attendance_sessions.session_date', currentTerm.ends_on)
      .eq('status', s),
  ),
);
const attendanceCounts: Record<string, number> = {};
STATUSES.forEach((s, i) => { attendanceCounts[s] = counts[i].count ?? 0; });
```

Pick `currentTerm` from the `terms` array already fetched at lines 121-125 (the term whose `starts_on`/`ends_on` bracket today, else the latest) — scoping to the current term also fixes the semantics, since a lifetime "present: 940" is not a useful number for a parent. Keep the `.eq('student_id', …)` filter alongside the join filter so the tenant scoping stays explicit.

Optional, same file: apply the same `count: 'exact', head: true` treatment (or a single sum RPC) to the `invoices`/`payments` reads at lines 132-141 that compute `balance`, which have the identical unbounded shape.

The N+1 loop is not worth changing on its own; if touched, hoist the `tenants` and `academic_terms` reads out of the `for (const link of links)` loop by de-duplicating `link.tenantId` first, since siblings almost always share a tenant.

---

### 70. Parent-portal report card is still served for an archived school that the portal list already hides

- **Location:** `apps/api/src/parents/parents.controller.ts:194`
- **Category:** access-control · **Verdict:** CONFIRMED (medium) · **Found by:** gap:tenant suspension / offboarding / data deletion (RLS layer never checks tenant status; no purge or export exists)

**What is wrong.** `GET /portal/children` filters out archived tenants at line 128, but `GET /portal/children/:studentId/report-card` performs no tenant-status check at all — it only verifies the guardian link and then calls the `report_card` RPC. Offboarding is therefore half-enforced: the school vanishes from the parent's list while its full academic record stays retrievable by direct request, and neither endpoint blocks `suspended`.

**How it fails.** A school is archived at the end of the contract. A parent opens the portal: `/portal/children` skips the school (parents.controller.ts:128 `if (!tenant || tenant.status === 'archived') continue;`) so the dashboard shows "no children" and support tells the parent the school is closed. The parent (or anyone replaying a request from their browser history / a cached link) re-issues `GET /portal/children/<studentId>/report-card?termId=<uuid>` with their still-valid JWT. `reportCard` at :194-220 checks only `linkedStudents()` and the termId format, then returns the complete `report_card` RPC payload — every subject mark, grade, position and teacher comment for an archived tenant. Under suspension the inconsistency runs the other way: `/portal/children` still lists the school and returns each child's outstanding balance, so a school suspended for non-payment keeps serving parents financial data the operator meant to cut off.

**Evidence.**

```
apps/api/src/parents/parents.controller.ts:128 —
```ts
      if (!student || student.status !== 'active') continue;
      if (!tenant || tenant.status === 'archived') continue;
```
versus :194-220 —
```ts
  @Get('children/:studentId/report-card')
  async reportCard(@Req() req, @Param('studentId') studentId: string, @Query('termId') termId: string) {
    if (!termId || !/^[0-9a-f-]{36}$/.test(termId)) throw new BadRequestException({ code: 'PORTAL_TERM_INVALID' });
    const links = await this.linkedStudents(req.user.id);
    const link = links.find((l) => l.studentId === studentId);
    if (!link) throw new ForbiddenException({ code: 'PORTAL_NOT_YOUR_CHILD' });
    const { data, error } = await this.supabase.admin.rpc('report_card', { p_tenant_id: link.tenantId, … });
```
(no tenant load, no status branch). The controller is `@Controller('portal') @UseGuards(AuthGuard)` at :75-76 — TenantGuard, which would have raised TENANT_ARCHIVED, is intentionally absent because guardians are not members.
```

**Fix.** In apps/api/src/parents/parents.controller.ts, add a private helper on `PortalController` and call it before the RPC in `reportCard`:

```ts
private async assertPortalTenant(tenantId: string) {
  const { data: tenant } = await this.supabase.admin
    .from('tenants').select('status').eq('id', tenantId).maybeSingle();
  if (!tenant || tenant.status === 'archived' || tenant.status === 'suspended') {
    throw new ForbiddenException({ code: 'PORTAL_SCHOOL_UNAVAILABLE' });
  }
}
```

Call `await this.assertPortalTenant(link.tenantId);` immediately after the `PORTAL_NOT_YOUR_CHILD` check at :207, and replace the inline test at :128 with the same predicate (`continue` on rejection) so `children` and `reportCard` agree — that also brings the portal in line with docs/ADMIN_GUIDE.md:179 ("suspend → all API access stops instantly"), which suspension currently does not honour for guardians. Add EN+SW keys for `PORTAL_SCHOOL_UNAVAILABLE` in packages/i18n/src/index.ts (both key sets mirrored) so apps/web/src/app/portal/portal-view.tsx:118 renders a real message, and extend apps/api/scripts/smoke-parents.mjs to archive the tenant and assert the report-card call returns 403 before the existing cleanup. Note that hiding a *suspended* school from parents is a product decision (it makes a parent's dashboard go empty when the school misses a payment) — confirm it with the owner; the archived branch alone is the strictly-safe minimal change.

---

### 71. Payroll statutory rates accept any magnitude and an empty PAYE band array — negative net pay makes the run un-postable, or PAYE silently becomes zero

- **Location:** `apps/api/src/payroll/payroll.schema.ts:30`
- **Category:** input-validation · **Verdict:** CONFIRMED (medium) · **Found by:** input-validation

**What is wrong.** `payrollRatesSchema` bounds rates only with `.nonnegative()` (no `.max()`, no `.min(1)` on `paye_bands`), and the RPC it defers to validates nothing beyond `jsonb_typeof(paye_bands) = 'array'`, so out-of-range or empty rates flow straight into salary computation.

**How it fails.** A bursar (or a script) calls `PUT /api/v1/payroll/settings` with `nssf_employee_rate: 10` — the natural mistake of entering "10%" where the schema wants the fraction `0.10`. Nothing rejects it: zod passes (`10 >= 0`), and `app.update_payroll_settings` only checks that `paye_bands` is an array. `app.run_payroll` then computes `v_nssf := round(v_gross * 10, 2)` and `v_net := v_gross - v_paye - v_nssf - v_heslb`, i.e. roughly **-9× gross** for every employee. `app.post_payroll` sums those: `v_deductions` now exceeds `v_gross`, and because the Cash credit is only appended `if v_net > 0`, the journal it hands to `app.post_journal` has credits ≠ debits and raises `LEDGER_UNBALANCED_ENTRY`. The controller's `rpcError` known-code list doesn't contain it, so the school gets an opaque 500 `PAYROLL_RPC_FAILED` and simply cannot run payroll, with no hint that a settings value is the cause. The quieter variant: `paye_bands: []` also passes both layers, `app.compute_paye` loops over zero elements and returns 0, so every payslip shows **zero PAYE** and the school under-remits to TRA with no error at all.

**Evidence.**

```
apps/api/src/payroll/payroll.schema.ts:23-36
```ts
export const payeBandSchema = z.object({
  up_to: z.number().nonnegative().nullable(),
  rate: z.number().nonnegative(),
});

export const payrollRatesSchema = z
  .object({
    paye_bands: z.array(payeBandSchema),
    nssf_employee_rate: z.number().nonnegative(),
    heslb_rate: z.number().nonnegative(),
    employer: z.record(z.string(), z.number()),
  })
  .passthrough();
```
The comment above it claims "the RPC (`update_payroll_settings`) validates the shape and raises PAYROLL_SETTINGS_INVALID on bad values" — supabase/migrations/00000000000025_payroll.sql:540-544 is the entire validation:
```sql
  if p_rates is null or p_rates->'paye_bands' is null
     or jsonb_typeof(p_rates->'paye_bands') <> 'array' then
    raise exception 'PAYROLL_SETTINGS_INVALID';
  end if;
```
supabase/migrations/00000000000025_payroll.sql (run_payroll) — `v_net := v_gross - v_paye - v_nssf - v_heslb;` with no floor; `payroll_items.net numeric(12,2)` has no `check (net >= 0)`.
supabase/migrations/00000000000025_payroll.sql:430-435 (post_payroll) — the Cash leg is dropped when net is negative:
```sql
  if v_deductions > 0 then
    v_lines := v_lines || jsonb_build_object('code', '2100', 'debit', 0, 'credit', v_deductions);
  end if;
  if v_net > 0 then
    v_lines := v_lines || jsonb_build_object('code', '1000', 'debit', 0, 'credit', v_net);
  end if;
```
supabase/migrations/00000000000007_finance.sql:208-210 — `if v_debits is null or v_debits <> v_credits or v_debits <= 0 then raise exception 'LEDGER_UNBALANCED_ENTRY';`
```

**Fix.** 1) `/Users/admin/Atlas-System/apps/api/src/payroll/payroll.schema.ts` — bound the domain and fix the misleading comment:
```ts
export const payeBandSchema = z.object({
  up_to: z.number().nonnegative().max(1_000_000_000).nullable(),
  rate: z.number().min(0).max(1),
});

export const payrollRatesSchema = z
  .object({
    paye_bands: z.array(payeBandSchema).min(1).max(20),
    nssf_employee_rate: z.number().min(0).max(1),
    heslb_rate: z.number().min(0).max(1),
    employer: z.record(z.string(), z.number().min(0).max(1)),
  })
  .passthrough();
```
(Keep `.passthrough()` unless you also audit stored rate blobs — `.strict()` would start rejecting any extra key already persisted. Rewrite the 18-22 comment: the RPC checks only that `paye_bands` is an array.)

2) DB backstop — migration 0025 has NOT been applied to the live DB yet, so tighten `app.update_payroll_settings` in place at `supabase/migrations/00000000000025_payroll.sql:541-544` (if it has been applied by the time this lands, do it in a new 0029 instead):
```sql
  if p_rates is null or jsonb_typeof(p_rates->'paye_bands') <> 'array'
     or jsonb_array_length(p_rates->'paye_bands') = 0
     or coalesce((p_rates->>'nssf_employee_rate')::numeric, 0) > 1
     or coalesce((p_rates->>'heslb_rate')::numeric, 0) > 1
     or exists (select 1 from jsonb_array_elements(p_rates->'paye_bands') b
                where (b->>'rate')::numeric > 1 or (b->>'rate')::numeric < 0) then
    raise exception 'PAYROLL_SETTINGS_INVALID';
  end if;
```

3) Fail at compute time rather than at posting: add `check (net >= 0)` to `public.payroll_items` (same file, line 94) — or, better, have `app.run_payroll` raise a stable `PAYROLL_RATES_INVALID` when any computed `v_net < 0`, and add that code to the `rpcError` known list in `payroll.controller.ts:222-226` so the school sees "check your statutory rates" instead of an opaque 500.

Separately (higher value than the above, worth filing on its own): `apps/web/src/app/payroll/payroll-view.tsx:79-97, 900-1033` uses camelCase keys (`payeBands`/`from`, `nssfEmployee`, `heslb`, `wcf`, `sdl`) while the API returns and accepts the DB jsonb shape (`paye_bands`/`up_to`, `nssf_employee_rate`, `heslb_rate`, `employer.{nssf_rate,wcf_rate,sdl_rate}`). The dialog will throw on `rates.payeBands.map` once a rates row exists, and its PUT can never pass zod. Map the two shapes in the view (or add the mapping in `payroll.controller.ts` getSettings/updateSettings) — and note the "(%)" i18n labels mean the UI should show `rate * 100` and divide on save.

---

### 72. Subscription period arithmetic uses setUTCMonth, which overflows on month-end dates and grants extra unpaid days

- **Location:** `apps/api/src/platform/platform.controller.ts:419`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** finance-correctness

**What is wrong.** Both the plan-change and manual payment-reconciliation endpoints advance the billing period with `Date.setUTCMonth(getUTCMonth() + n)`, which rolls a day-31 (or Feb-29) anchor forward into the following month instead of clamping to the last valid day.

**How it fails.** Platform admin puts a school on the monthly plan on 2027-01-31 via POST /platform/tenants/:id/plan {cycle:'monthly'}. `end.setUTCMonth(0 + 1)` produces 2027-02-31, which JavaScript normalises to 2027-03-03 — the school's paid period is 31 days instead of 28 and the lapse-enforcement check lets it keep full access three days past the month it paid for. Recording a 12-month payment against a 2028-02-29 period end (`newEnd.setUTCMonth(getUTCMonth() + 12)`) yields 2029-03-01 rather than 2029-02-28. The drift compounds on every renewal that lands on a 29th/30th/31st anchor.

**Evidence.**

```
apps/api/src/platform/platform.controller.ts:417-421 —
```ts
    const start = new Date();
    const end = new Date(start);
    end.setUTCMonth(
      end.getUTCMonth() + (parsed.data.cycle === 'annual' ? 12 : 1),
    );
```
apps/api/src/platform/platform.controller.ts:543-544 —
```ts
    const newEnd = new Date(base);
    newEnd.setUTCMonth(newEnd.getUTCMonth() + parsed.data.months);
```
```

**Fix.** In apps/api/src/platform/platform.controller.ts, add a module-level clamping helper and use it at both sites.

Helper (place near the zod schemas at the top of the file):

/** Advance a UTC instant by N months, clamping to the last valid day —
 *  plain setUTCMonth rolls 2027-01-31 + 1mo into 2027-03-03. */
function addUTCMonths(from: Date, months: number): Date {
  const day = from.getUTCDate();
  const d = new Date(from);
  d.setUTCDate(1);                       // park on a day every month has
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

Then replace lines 417-421 in changePlan:
  const start = new Date();
  const end = addUTCMonths(start, parsed.data.cycle === 'annual' ? 12 : 1);

and lines 543-544 in recordPayment:
  const newEnd = addUTCMonths(base, parsed.data.months);

(Time-of-day is preserved by the copy constructor, so period ends keep their original clock time.) Leave extendTrial (line 487) alone — day arithmetic in milliseconds is correct. Optionally cover it in apps/api/scripts/smoke-platform.mjs by recording a payment against a subscription whose current_period_end is set to a 31st and asserting the new end lands on the 28th/30th of the target month.

---

### 73. GET /reports/:id returns financial totals without re-checking the report's own permission

- **Location:** `apps/api/src/reports/reports.controller.ts:181`
- **Category:** broken-access-control · **Verdict:** CONFIRMED (high) · **Found by:** authz-permissions

**What is wrong.** POST /reports and GET /reports/:id/download both re-check the per-report CATALOGUE permission, but GET /reports/:id (detail) and GET /reports (list) check only the generic reports.generate gate, so any role that can generate reports can read the totals and params of finance reports it is not permitted to see.

**How it fails.** An `academic_master` holds reports.generate (migration 0012:341+) but not finance.reports.view (granted only to bursar/accountant in 0007). The bursar generates a trial_balance report. The academic_master calls GET /api/v1/reports, which returns every report job for the tenant including the bursar's job id, report_key and params, then calls GET /api/v1/reports/<that id> and receives `totals` — for trial_balance that is {debits, credits}, for fee_collection {total, byMethod}, for student_statement {closingBalance} keyed to the studentId in `params` (see apps/workers/src/process-reports.ts:80-141, which writes those objects into report_jobs.totals at line 236). The same user calling GET /api/v1/reports/<id>/download is correctly 403'd, which shows the check was intended.

**Evidence.**

```
apps/api/src/reports/reports.controller.ts:181-196 — detail(), no per-report permission check:
  @Get(':id')
  @RequirePermission('reports.generate')
  async detail(@Req() req: TenantRequest, @Param('id') id: string) {
    const { data: job, error } = await this.supabase.admin
      .from('report_jobs')
      .select('id, report_key, format, status, reference, params, totals, error, created_at, completed_at')
      .eq('id', id).eq('tenant_id', req.tenant.tenantId).maybeSingle();
    ...
    return { job };

Contrast download() at lines 215-222, which does check:
  const def = CATALOGUE[job.report_key as ReportKey];
  if (def && !req.tenant.isOwner && !req.tenant.permissions.has(def.permission)) {
    throw new ForbiddenException(`Missing permission: ${def.permission}`);
  }

and create() at lines 104-107 which checks the same way. CATALOGUE (lines 30-64) marks fee_collection, outstanding_balances, trial_balance and student_statement as permission: 'finance.reports.view'.
```

**Fix.** Two parts; the controller fix alone is insufficient.

(1) apps/api/src/reports/reports.controller.ts — in `detail()` (line 181), after the `if (!job) throw new NotFoundException(...)` at line 195, insert the same check `download()` uses at 215-222:

    const def = CATALOGUE[job.report_key as ReportKey];
    if (def && !req.tenant.isOwner && !req.tenant.permissions.has(def.permission)) {
      throw new ForbiddenException(`Missing permission: ${def.permission}`);
    }

Optionally also filter `list()` (line 164) in JS after the query: drop rows whose `CATALOGUE[report_key].permission` the caller lacks, or null out `params` for them. Note `list()` does NOT select `totals`, so the finder's claim about the list endpoint leaking totals is wrong — it leaks only report_key/params/reference.

(2) New additive migration (0029) — the real boundary. `report_jobs` currently has `create policy "members read report jobs" ... using (app.is_tenant_member(tenant_id))` (0012:39-41), which lets any member read `totals` straight from PostgREST. Follow the precedent set by 0027 for ai_tool_calls/ai_usage/clinic_visits: `drop policy "members read report jobs" on public.report_jobs;` and either add no replacement (API-only reads, since apps/web/src/app/reports/reports-view.tsx already goes through apiFetch for all four calls and nothing in web/mobile queries the table directly) or restrict it to `requested_by = auth.uid()`. Re-run smoke-reports after applying.

---

### 74. EAS production/preview builds ship with no EXPO_PUBLIC_* env — the app throws at launch and, if it starts, points at http://localhost:4000

- **Location:** `apps/mobile/eas.json:16`
- **Category:** build-config · **Verdict:** CONFIRMED (medium) · **Found by:** config-ops-secrets+mobile-i18n

**What is wrong.** No build profile in eas.json defines `env`, and `apps/mobile/.env` is git-ignored (root .gitignore:37) so it is never uploaded to the EAS builder. `EXPO_PUBLIC_SUPABASE_URL`/`ANON_KEY` inline as `undefined`, and `src/lib/supabase.ts` throws at module scope; `apiBaseUrl()` additionally falls back to a cleartext localhost URL.

**How it fails.** A human follows apps/mobile/README.md:64-70 and runs `eas build -p android --profile production`. The EAS builder receives a project archive that excludes `apps/mobile/.env` (git-ignored), so at bundle time `process.env.EXPO_PUBLIC_SUPABASE_URL` is undefined. On first launch `src/app/_layout.tsx` imports `@/lib/auth` → `@/lib/supabase`, which throws "EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY missing" before any component mounts — the store build crashes to the home screen on every launch. If the Supabase vars are later supplied but `EXPO_PUBLIC_API_URL` is not, `apiBaseUrl()` returns `http://localhost:4000` (Constants.expoConfig.hostUri is null outside the Expo dev server), so every write — attendance save, record payment, Ask ATLAS, POST /devices — targets the phone itself and is additionally blocked by Android 9+ cleartext policy / iOS ATS.

**Evidence.**

```
eas.json:5-19 — `"build": { "development": { "developmentClient": true, "distribution": "internal" }, "preview": {...}, "production": { "autoIncrement": true } }` (no `env` on any profile, no EAS environment-variable reference).
Root .gitignore:37 — `apps/mobile/.env` (and no `.easignore` exists anywhere in the repo).
src/lib/supabase.ts:5-12 — `const url = process.env.EXPO_PUBLIC_SUPABASE_URL; ... if (!url || !anonKey) { throw new Error("EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY missing — copy apps/mobile/.env.example to .env"); }`
src/lib/api.ts:12-21 — `const configured = process.env.EXPO_PUBLIC_API_URL; if (configured) return ...; const hostUri = Constants.expoConfig?.hostUri; if (hostUri) { ... return \`http://${host}:4000\`; } return "http://localhost:4000";`
```

**Fix.** Two minimal changes.

1. Code (the only real defect): apps/mobile/src/lib/api.ts:12-21 — replace the silent localhost fallback with a loud failure so a standalone build can never point at the handset:

export function apiBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_API_URL;
  if (configured) return configured.replace(/\/$/, "");
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) return `http://${hostUri.split(":")[0]}:4000`;
  throw new Error("EXPO_PUBLIC_API_URL missing — required for standalone (non-dev-server) builds");
}

(keeping `return "http://localhost:4000"` behind an `if (__DEV__)` branch is acceptable if a simulator-only path is wanted).

2. Release config: add `"environment": "preview"` / `"environment": "production"` to the matching profiles in apps/mobile/eas.json and create the three EAS-hosted variables once the API is actually deployed:
  eas env:create --environment production --name EXPO_PUBLIC_SUPABASE_URL --value https://zwbsyiwtrabpysylyaaj.supabase.co --visibility plaintext
  (same for EXPO_PUBLIC_SUPABASE_ANON_KEY and EXPO_PUBLIC_API_URL=https://<api host>)
Inlining an `env` block in eas.json also works here since all three values are public, but EXPO_PUBLIC_API_URL cannot be filled in yet — the API has no deployment target in this repo. Add the env step to apps/mobile/README.md:62-71 between `eas init` and `eas build`, since the documented recipe currently omits it entirely.

---

### 75. Attendance save is non-idempotent with no timeout/retry — a dropped response makes the teacher believe the register failed, and every retry returns 403

- **Location:** `apps/mobile/src/app/(tabs)/attendance.tsx:216`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** mobile-i18n

**What is wrong.** `save()` treats any fetch rejection as "could not reach the server", but the server has already committed the register; re-submitting the same section/date is treated as a correction requiring `attendance.correct`, so the retry 403s and the mobile 403 branch does not even fire because `existing` is still stale-false.

**How it fails.** A Form 2A teacher who holds `attendance.mark` but not `attendance.correct` marks 45 students and taps Save on a 3G connection in Mbeya. The POST reaches the API, `mark_attendance` commits the session and queues guardian SMS, and the connection drops before the response arrives. `apiFetch` rejects, the catch at line 216 sets `common.apiUnreachable` ("Could not reach the server…"), and no register is shown as saved. When signal returns the teacher taps Save again: attendance.controller.ts:52-72 finds the existing session and throws 403. Mobile's special-case at line 204 requires `existing` to be true, but `existing` is still `false` (loadRoster has not re-run since the invisible success), so the generic `err.forbidden` ("You do not have permission") is shown instead. The teacher concludes the app cannot record attendance, re-enters the register on paper, and the SMS alerts have already gone out to parents. There is also no draft persistence — `statuses` lives only in component state, so an Android low-memory kill mid-register loses all 45 marks.

**Evidence.**

```
src/app/(tabs)/attendance.tsx:199-220 — `if (!response.ok) { ... if (response.status === 403 && existing) { setSaveError(t("err.attendanceCorrectForbidden")); } else { setSaveError(apiErrorMessage(t, body, response.status)); } ... } ... } catch { setSaveError(t("common.apiUnreachable")); }`
src/lib/api.ts:33-43 — plain `return fetch(...)` with no AbortController/timeout and no retry.
apps/api/src/attendance/attendance.controller.ts:66-72 — `if (existing && !req.tenant.isOwner && !req.tenant.permissions.has('attendance.correct')) { throw new ForbiddenException('Missing permission: attendance.correct'); }`
```

**Fix.** Fix the error signalling, not idempotency (the RPC is already effectively idempotent — duplicate-SMS is guarded by `v_prev_absent`).

1. `apps/api/src/attendance/attendance.controller.ts:72` — give the 403 a stable code like every other business error in this codebase:
   `throw new ForbiddenException({ code: 'ATTENDANCE_CORRECT_FORBIDDEN', message: 'Missing permission: attendance.correct' });`
2. `apps/mobile/src/lib/api-error.ts` (ERROR_KEYS, ~line 26) and `apps/web/src/lib/api-error.ts` (ERROR_KEYS, line 12) — add `ATTENDANCE_CORRECT_FORBIDDEN: "err.attendanceCorrectForbidden"`. Both keys already exist in EN+SW (`packages/i18n/src/index.ts:757` / `:1515`), so no new strings.
3. `apps/mobile/src/app/(tabs)/attendance.tsx:203-208` — delete the stale-flag special case (`response.status === 403 && existing`) and let `apiErrorMessage` handle it from the server code; add `void loadRoster();` in the non-ok branch so `existing`, the correction banner, and `statuses` resync with what the server actually holds. Optionally do the same in the `catch` at line 216 so a dropped response self-heals.
4. Optional hardening, separate from this finding: wrap `fetch` in `apps/mobile/src/lib/api.ts` with an `AbortController` timeout (~20s) so hung requests surface instead of spinning forever. Skip the client idempotency key — it buys nothing given the RPC's existing behaviour.

---

### 76. students/[id] and finance/[id] render with no session guard — an atlas:// deep link opened while signed out hangs on skeletons forever

- **Location:** `apps/mobile/src/app/students/[id].tsx:71`
- **Category:** correctness · **Verdict:** CONFIRMED (medium) · **Found by:** mobile-i18n

**What is wrong.** Every other surface checks `session` (tabs layout, portal, settings, no-school, index), but the two top-level detail routes reachable via the `atlas` URL scheme only check `tenantId` and silently return from `load()`, leaving the screen in its permanent loading state with no redirect to login.

**How it fails.** A parent or teacher taps `atlas://students/5f3c…` shared in a WhatsApp/SMS message while signed out (or while signed in as a guardian, who has `tenant === null`). expo-router mounts `students/[id].tsx` directly from the root Stack — there is no `(tabs)` or `(auth)` layout in the path to guard it. `tenantId` is undefined, so `load()` returns at line 71 without setting `student`, `invoices` or `error`. The screen renders the Header plus four skeleton cards indefinitely; there is no login prompt, no error, and no automatic recovery even after the user signs in in another tab. `finance/[id].tsx:81` behaves identically.

**Evidence.**

```
app.json:8 — `"scheme": "atlas"` (deep links enabled).
src/app/students/[id].tsx:70-71 — `const load = useCallback(async () => { if (!tenantId || !id) return;` — the component has no `session` check anywhere.
src/app/finance/[id].tsx:80-81 — `const load = useCallback(async () => { if (!tenantId || !id) return;`
Contrast src/app/(tabs)/_layout.tsx:21-22 `if (!session) return <Redirect href="/login" />; if (!tenant) return <Redirect href={isGuardian ? "/portal" : "/no-school"} />;` and src/app/settings.tsx:19 `if (session === null) return <Redirect href="/login" />;`
```

**Fix.** Add the same declarative guard the tabs layout uses to both detail screens (or, better, move them under a shared authenticated group).

Minimal, per-file: in /Users/admin/Atlas-System/apps/mobile/src/app/students/[id].tsx change line 62 to `const { session, tenant, isGuardian } = useAuth();` and, immediately before the `return (` at line 168 (after all hooks, so hook order stays stable), insert:

```tsx
if (session === undefined || (session && tenant === undefined)) {
  return <View style={styles.loading}><ActivityIndicator color={color.primary} /></View>;
}
if (!session) return <Redirect href="/login" />;
if (!tenant) return <Redirect href={isGuardian ? "/portal" : "/no-school"} />;
```

(import `Redirect` from "expo-router" and `ActivityIndicator` from "react-native"; copy the `loading` style from `(tabs)/_layout.tsx:94-99`). Apply the identical block to /Users/admin/Atlas-System/apps/mobile/src/app/finance/[id].tsx before its `return (`.

Cleaner alternative: create `src/app/(app)/_layout.tsx` containing exactly the `(tabs)/_layout.tsx:14-22` guard wrapped around a `<Stack>`, and move `students/[id].tsx` and `finance/[id].tsx` under it — the route URLs (`/students/<id>`, `/finance/<id>`) are unchanged by the group, so the existing `router.push` call sites at `(tabs)/students.tsx:159`, `(tabs)/finance.tsx:158` and `students/[id].tsx:316` keep working.

---

### 77. SUBSCRIPTION_LAPSED and AI_QUOTA_EXCEEDED have no error mapping — users see the raw code

- **Location:** `apps/mobile/src/lib/api-error.ts:52`
- **Category:** i18n · **Verdict:** CONFIRMED (high) · **Found by:** mobile-i18n

**What is wrong.** `ERROR_KEYS` maps SUBSCRIPTION_EXPIRED but not SUBSCRIPTION_LAPSED, which TenantGuard throws for every non-GET request once a paid subscription goes past_due or its period ends; AI_QUOTA_EXCEEDED is likewise unmapped. Neither ends in _NOT_FOUND/_INVALID/_FAILED, so both fall through to the raw-code branch.

**How it fails.** A school's paid subscription period ends (or goes past_due). Every write from the mobile app — saving an attendance register, recording a payment — hits tenant.guard.ts:133 and gets `{ code: 'SUBSCRIPTION_LAPSED' }`. `apiErrorMessage` finds no exact key and no matching suffix, so line 52 returns "Kuna hitilafu imetokea (SUBSCRIPTION_LAPSED)" — a Kiswahili-speaking bursar is shown an untranslated English code with no indication that the school simply needs to renew, even though `err.subscriptionExpired` ("Usajili wako umeisha muda wake. Wasiliana na ATLAS ili kuufanya upya.") already exists in the dictionary. Same for the assistant when the plan's `aiMonthlyTokens` budget is exhausted: "Kuna hitilafu imetokea (AI_QUOTA_EXCEEDED)".

**Evidence.**

```
src/lib/api-error.ts:8-37 — `ERROR_KEYS` contains `SUBSCRIPTION_EXPIRED: "err.subscriptionExpired"` and `NO_SUBSCRIPTION` but no `SUBSCRIPTION_LAPSED` and no `AI_QUOTA_EXCEEDED`.
src/lib/api-error.ts:49-52 — `if (code.endsWith("_NOT_FOUND")) ...; if (code.endsWith("_INVALID")) ...; if (code.endsWith("_FAILED")) ...; return \`${t("err.generic")} (${code})\`;`
apps/api/src/tenancy/tenant.guard.ts:132-133 — `if (request.method !== 'GET' && subscriptionLapsed) { throw new ForbiddenException({ code: 'SUBSCRIPTION_LAPSED' }); }`
apps/api/src/ai/ai.controller.ts:126-134 — `throw new HttpException({ code: 'AI_QUOTA_EXCEEDED', limit: quotaLimit, used: usedThisMonth }, HttpStatus.TOO_MANY_REQUESTS)` — because a `code` is present, the `status === 429` branch at api-error.ts:54 is never reached.
```

**Fix.** Three files, mirrored EN+SW. (1) packages/i18n/src/index.ts — add one key to BOTH dictionaries, keeping the sets exactly mirrored: next to "err.subscriptionExpired" (EN ~line 706) add `"err.aiQuotaExceeded": "This school's monthly AI allowance is used up. It resets next month, or upgrade your plan."`, and next to the SW "err.subscriptionExpired" (~line 1463) add `"err.aiQuotaExceeded": "Kiasi cha AI cha mwezi huu kwa shule hii kimeisha. Kitaanza upya mwezi ujao, au boresha mpango wako."`. (2) apps/mobile/src/lib/api-error.ts — in ERROR_KEYS, after `SUBSCRIPTION_EXPIRED: "err.subscriptionExpired",` add `SUBSCRIPTION_LAPSED: "err.subscriptionExpired",` and add `AI_QUOTA_EXCEEDED: "err.aiQuotaExceeded",` under an "// AI" comment. (3) apps/web/src/lib/api-error.ts — add the identical two entries (the file is a tab-indented mirror; "@/i18n" is just a re-export of @atlas/i18n so the new DictKey resolves automatically). Optional follow-up while in the file: the web copy is also missing ATTENDANCE_DUPLICATE_STUDENT / ATTENDANCE_STUDENT_NOT_ENROLLED that mobile has — the two tables have drifted despite the "keep the two in sync" comment.

---

### 78. Marks-entry subject picker is not tenant-filtered — a teacher in two schools cannot save marks

- **Location:** `apps/web/src/app/assessments/[id]/page.tsx:58`
- **Category:** cross-tenant-data-mixing · **Verdict:** CONFIRMED (high) · **Found by:** tenant-isolation

**What is wrong.** The assessment itself is read with `.eq("tenant_id", tenantId)`, but the subject dropdown that feeds POST /assessments/:id/scores is fetched with no tenant filter, relying solely on RLS — which admits every tenant the caller is an active member of, while the page pins `tenant` to the oldest membership.

**How it fails.** Teacher T onboarded School A in January (so A is the oldest membership) and later accepted a staff invitation to School B. Both schools ran POST /subjects/preset, so both have a subject with code MATH. T opens /assessments/<an A assessment>. The page resolves `tenant` = School A (lines 28-35, and there is no tenant switcher anywhere in apps/web), correctly loads the A assessment, then loads `subjects` with only `education_level` + `status` filters. RLS returns A's MATH *and* B's MATH — two visually identical options. T picks B's, enters the class's marks and saves. apps/web sends `subjectId` (School B's uuid) with `x-tenant-id: <School A>`; app.record_scores looks the subject up as `where id = p_subject_id and tenant_id = p_tenant_id`, finds nothing and raises SCORES_SUBJECT_NOT_FOUND (00000000000006_assessments.sql:191). The teacher gets a 400 saying the subject does not exist while that exact subject is on screen, and the whole register of marks is lost. Becoming multi-tenant is trivial: POST /onboarding (apps/api/src/onboarding/onboarding.controller.ts:23) makes the caller school_owner of a brand-new tenant and can be called repeatedly.

**Evidence.**

```
apps/web/src/app/assessments/[id]/page.tsx — the assessment read IS scoped (line 45-46 `.eq("id", id) .eq("tenant_id", tenantId)`), the subject read is not:
```tsx
57	const [{ data: subjects }, { data: enrolments }] = await Promise.all([
58		supabase
59			.from("subjects")
60			.select("id, code, name, name_sw")
61			.eq("education_level", level)
62			.eq("status", "active")
63			.order("code"),
```
Tenant pinning, same file lines 29-35:
```tsx
	const { data: tenants } = await supabase
		.from("tenants")
		.select("id, name")
		.order("created_at", { ascending: true })
		.limit(1);
```
```

**Fix.** In /Users/admin/Atlas-System/apps/web/src/app/assessments/[id]/page.tsx, add the explicit tenant filter to the subjects query (lines 58-63):

  supabase
    .from("subjects")
    .select("id, code, name, name_sw")
    .eq("tenant_id", tenantId)      // <- add
    .eq("education_level", level)
    .eq("status", "active")
    .order("code"),

That alone fixes the reported failure. Apply the identical one-line fix to the two other pages with the same omission, which feed the same kind of picker:
- /Users/admin/Atlas-System/apps/web/src/app/timetable/page.tsx:48-51 — add .eq("tenant_id", tenant.id) to the subjects read.
- /Users/admin/Atlas-System/apps/web/src/app/library/page.tsx:34-38 — add .eq("tenant_id", tenant.id) to the subjects read.

No API, RPC, or migration change is needed: record_scores already validates the subject's tenant, so this is purely the client picking the wrong id. The class_enrolments (line 64) and assessment_scores (line 76) reads on the same page are already correct via their tenant-scoped parent ids; adding .eq("tenant_id", tenantId) there is optional defence-in-depth, not a fix.

---

### 79. Record-payment dialog pre-fills a stale balance after the first payment on an invoice

- **Location:** `apps/web/src/app/finance/[id]/invoice-view.tsx:285`
- **Category:** stale-state · **Verdict:** CONFIRMED (high) · **Found by:** web-correctness

**What is wrong.** `amount` is seeded from `balance` in a useState initializer, but the dialog is never remounted across `router.refresh()` (no `key` on InvoiceView, and the `balance > 0` guard keeps the same element position), so the prefill keeps showing the balance as it was on first page load.

**How it fails.** An invoice totals 500,000 TZS. The bursar opens Record payment (prefilled 500000), edits it to 200,000 (M-Pesa part payment) and saves. `router.refresh()` re-renders with balance 300,000, but RecordPaymentDialog is the same React instance so `amount` state is still the string the bursar last typed / the original 500000 seed — it is NOT re-derived from the new 300,000 balance. The parent then pays the remaining 300,000. The bursar reopens the dialog and sees a prefilled figure that does not match the 300,000 balance shown two lines above it; hitting Save trips the `max={balance}` constraint (a native validation bubble) or the API's PAYMENT_EXCEEDS_BALANCE. Every subsequent payment on that invoice requires manually clearing a wrong prefill, and the mismatch between the displayed balance and the prefilled amount is exactly the kind of thing that gets keyed into the ledger wrong.

**Evidence.**

```
apps/web/src/app/finance/[id]/invoice-view.tsx:285 `const [amount, setAmount] = useState(String(balance));`
Mount guard that never removes the component while a balance remains — invoice-view.tsx:108-115:
```
						{balance > 0 && (
							<RecordPaymentDialog
								balance={balance}
```
Parent renders without a `key` — apps/web/src/app/finance/[id]/page.tsx:139 `<InvoiceView invoice={detail} lang={lang} tenantId={tenant.id} />`.
The same class of bug hits SetInstalmentsDialog (invoice-view.tsx:385-389: `rows` seeded once) — and there Cancel at line 491 does not discard edits either, so an abandoned edit survives and can be saved later by accident.
```

**Fix.** In /Users/admin/Atlas-System/apps/web/src/app/finance/[id]/invoice-view.tsx, reseed the form when the dialog opens, mirroring the existing pattern at apps/web/src/app/staff/staff-view.tsx:206-215. Replace `onOpenChange={setOpen}` at line 318 with:

  onOpenChange={(v) => {
    setOpen(v);
    if (v) { setAmount(String(balance)); setReference(""); setError(null); }
  }}

Apply the same at line 429 for SetInstalmentsDialog, reseeding `rows` from the current props and clearing `error`:

  onOpenChange={(v) => {
    setOpen(v);
    if (v) {
      setRows(instalments.length > 0
        ? instalments.map((i) => ({ amount: String(i.amount), dueOn: i.dueOn }))
        : [{ amount: String(total), dueOn: "" }]);
      setError(null);
    }
  }}

This also fixes the Cancel-does-not-discard issue at line 491, since the next open reseeds. Prefer this over adding `key={invoice.id + ':' + invoice.paid}` in page.tsx:139 — the key approach remounts the whole subtree and discards unrelated state (e.g. an open ReverseDialog's typed reason) on every refresh. Longer term, converting these to the parent-controlled conditional-mount pattern used in hostel/transport/library/inventory/payroll views would remove the whole class of bug.

---

### 80. Create-invoice dialog keeps its previous selections after Cancel — the next invoice silently inherits the old fee lines

- **Location:** `apps/web/src/app/finance/finance-view.tsx:312`
- **Category:** stale-state · **Verdict:** CONFIRMED (high) · **Found by:** web-correctness

**What is wrong.** CreateInvoiceDialog holds studentId, the selected fee-item Set, term, due date and the custom line in component state that is never reset by the Cancel button or by `onOpenChange(false)`, so a cancelled draft survives and merges into the next invoice.

**How it fails.** The bursar opens New invoice, selects student Neema and ticks "Tuition Term 1 — 500,000", then realises she meant a different student and clicks Cancel. Later she reopens the dialog, selects student Baraka and ticks only "Transport — 100,000". The Tuition checkbox is still ticked from the abandoned draft (`selected` is the same Set), so `lines` posts BOTH fee items and Baraka is invoiced 600,000 TZS instead of 100,000. Because financial records are immutable by DB trigger, fixing this needs a reversal, not an edit.

**Evidence.**

```
apps/web/src/app/finance/finance-view.tsx:312-320 — all form state lives outside the open/close lifecycle:
```
	const [open, setOpen] = useState(false);
	...
	const [studentId, setStudentId] = useState("");
	const [termId, setTermId] = useState("");
	const [dueOn, setDueOn] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
```
Cancel only closes — finance-view.tsx:452-454:
```
							<Button onClick={() => setOpen(false)} type="button" variant="outline">
								{t("common.cancel")}
							</Button>
```
and `<Dialog onOpenChange={setOpen} open={open}>` at line 373 does no reset either. Note the codebase already knows the fix: payroll-view.tsx:374 and library-view.tsx:245 remount their dialogs with `key={open ? "open" : "closed"}`.
```

**Fix.** Minimal, self-contained fix in apps/web/src/app/finance/finance-view.tsx (do NOT use the `key={open ? ...}` form as proposed — `open` is local to CreateInvoiceDialog, so the parent cannot key on it without lifting the state first). Add a reset handler inside CreateInvoiceDialog and route every close through it:

function changeOpen(next: boolean) {
  setOpen(next);
  if (!next) {
    setStudentId(""); setTermId(""); setDueOn("");
    setSelected(new Set()); setCustomDesc(""); setCustomAmount(""); setError(null);
  }
}

Then change line 373 to `<Dialog onOpenChange={changeOpen} open={open}>` (this covers Esc / backdrop / X-button closes, which go through Base UI) and line 452's Cancel button to `onClick={() => changeOpen(false)}` (a programmatic `setOpen(false)` does not fire `onOpenChange`, so the Cancel button must call the handler directly). Leave the success path's `setOpen(false)` + `router.push` as-is, or point it at `changeOpen(false)` for consistency.

Alternative, if you prefer to match the newer house pattern (payroll-view.tsx:374, library-view.tsx:245, hostel-view.tsx:242, clinic-view.tsx:181): lift `open` into FinanceView, pass `open`/`onClose` into CreateInvoiceDialog, replace DialogTrigger with a plain Button that sets it, and render `<CreateInvoiceDialog key={invoiceOpen ? "open" : "closed"} ... />` at line 96.

Apply the same reset to FeeItemsDialog (finance-view.tsx:201, `name`/`amount`). For RecordPaymentDialog (finance/[id]/invoice-view.tsx:269) the stale field is `amount`, seeded once from `String(balance)`; resync it on close/reopen (`setAmount(String(balance))` in the same close handler) so a partial payment does not leave the pre-payment balance prefilled.

---

### 81. Student/section pickers on hostel, transport, library, clinic and timetable pages list other schools' children

- **Location:** `apps/web/src/app/hostel/page.tsx:27`
- **Category:** cross-tenant-data-mixing · **Verdict:** CONFIRMED (high) · **Found by:** tenant-isolation

**What is wrong.** Five module pages build their operational pickers from unfiltered reads of students/class_sections/subjects/timetable_periods/academic_years, relying only on RLS, while `tenant` is pinned to the oldest membership — so a user who belongs to two schools sees both schools' rows merged and indistinguishable.

**How it fails.** A warden/bursar U is an active member of School A (oldest) and School B. U opens /hostel to allocate a bed. `tenant` resolves to School A, but the student picker is loaded with only `.eq("status","active")`, so RLS returns School A's AND School B's active boarders in one list of 1000. Because student numbers are per-tenant counters (`'STU-' || lpad(app.next_counter(p_tenant_id,'student_number')...)`, 00000000000010_audit_hardening.sql:37), both schools contain a student numbered STU-00001, and the row renders only number + name — U has no way to tell which school a row came from. U picks School B's STU-00001; the client posts to /hostel/allocations with `x-tenant-id: <School A>`; app.allocate_hostel_bed rejects with HOSTEL_STUDENT_NOT_FOUND (00000000000019_hostel.sql:92). The allocation cannot be completed, and School B's boarders' full names, gender and boarding status have already been rendered inside a page whose header reads "School A".

**Evidence.**

```
apps/web/src/app/hostel/page.tsx:26-38 — `tenant` is set at line 24 from the oldest membership, then never used to scope the picker:
```tsx
26	const [{ data: students }, { data: years }, { data: memberships }] = await Promise.all([
27		supabase
28			.from("students")
29			.select("id, student_number, first_name, last_name, gender, boarding_status")
30			.eq("status", "active")
31			.order("student_number")
32			.limit(1000),
33		supabase
34			.from("academic_years")
35			.select("id, name")
36			.eq("status", "active")
```
Identical unfiltered reads: apps/web/src/app/transport/page.tsx:27 (students) and :33 (academic_years); apps/web/src/app/library/page.tsx:27 (students) and :33 (subjects); apps/web/src/app/clinic/page.tsx:27 (students); apps/web/src/app/timetable/page.tsx:38 (class_sections), :42 (timetable_periods), :47 (subjects). By contrast the same files' `tenant_memberships` reads DO carry `.eq("tenant_id", tenant.id)`.
```

**Fix.** Add the explicit tenant filter to the ten RLS picker reads, matching the convention already used in students/admissions/reports/finance pages (`.eq("tenant_id", tenant.id)` placed before `.eq("status", ...)`):
- apps/web/src/app/hostel/page.tsx:28 (students), :34 (academic_years)
- apps/web/src/app/transport/page.tsx:28 (students), :34 (academic_years)
- apps/web/src/app/library/page.tsx:28 (students), :34 (subjects)
- apps/web/src/app/clinic/page.tsx:28 (students)
- apps/web/src/app/timetable/page.tsx:39 (class_sections), :43 (timetable_periods), :48 (subjects)

The academic_years reads on hostel/transport are the load-bearing ones — fix those first, since an unfiltered `limit(1)` there breaks every write on the page for a dual-membership user, not just an unlucky row.

Optional follow-up (prevents recurrence, matches the finder's suggestion): put the tenant resolution behind a helper in apps/web/src/lib/ that returns `{ tenant, scoped: (table) => supabase.from(table).eq("tenant_id", tenant.id) }` so a new module page cannot query a tenant table unscoped, and add a lint/grep check for `.from("students")` without a sibling `tenant_id` filter.

---

### 82. 13 direct RLS reads omit the tenant_id filter, mixing two schools' rosters for anyone who is a member of more than one school

- **Location:** `apps/web/src/app/hostel/page.tsx:28`
- **Category:** tenant-isolation · **Verdict:** CONFIRMED (high) · **Found by:** web-security

**What is wrong.** Every page resolves the active school as `tenants[0]` (oldest membership-visible tenant) but several reads then query students / subjects / class_sections / academic_years / academic_terms / timetable_periods / class_enrolments / assessment_scores with no `.eq("tenant_id", …)`. RLS scopes those tables to *all* tenants the user is an active member of, not to the tenant the page is rendering, so a multi-school user sees both schools' data merged under one school's name — violating the house rule 'explicit tenant filter on top of RLS'.

**How it fails.** A matron is an active member of St. Mary's (created 2024, so `tenants[0]`) and is later invited to Uhuru Secondary. She opens /hostel: the header says 'St. Mary's', but the student picker at apps/web/src/app/hostel/page.tsx:28-32 lists every active student of BOTH schools with full name, admission number, gender and boarding status. She allocates a bed to a student who is actually enrolled at Uhuru; the API validates the student against x-tenant-id = St. Mary's and rejects with HOSTEL_* / not-found, so the workflow is also broken. The same merge happens on /clinic (page.tsx:28), /library (28, 34), /transport (28, 34), /timetable (39, 43, 48), /assessments/[id] (59, 65, 77 — subject list and existing marks) and /students/[id]/report-card (31 fetches ANY student by id with no tenant filter, 36 lists both schools' terms).

**Evidence.**

```
apps/web/src/app/hostel/page.tsx:27-32
    supabase
      .from("students")
      .select("id, student_number, first_name, last_name, gender, boarding_status")
      .eq("status", "active")        // <-- no .eq("tenant_id", tenant.id)
      .order("student_number")
      .limit(1000),

apps/web/src/app/students/[id]/report-card/page.tsx:30-34
    supabase
      .from("students")
      .select("id, first_name, last_name, student_number")
      .eq("id", id)                  // <-- no tenant filter at all
      .maybeSingle(),

Same omission at: clinic/page.tsx:28; library/page.tsx:28 and :34; transport/page.tsx:28 and :34; timetable/page.tsx:39, :43, :48; assessments/[id]/page.tsx:59, :65, :77; students/[id]/report-card/page.tsx:36. Compare the correct pattern in students/page.tsx:37 (`.eq("tenant_id", tenantId)`).
```

**Fix.** Add the explicit tenant filter to each RLS read, matching the pattern already used in apps/web/src/app/academics/page.tsx:45.

Add `.eq("tenant_id", tenant.id)` at:
- apps/web/src/app/hostel/page.tsx:28 (students) and :34 (academic_years)
- apps/web/src/app/transport/page.tsx:28 (students) and :34 (academic_years)
- apps/web/src/app/clinic/page.tsx:28 (students)
- apps/web/src/app/library/page.tsx:28 (students) and :34 (subjects)
- apps/web/src/app/timetable/page.tsx:39 (class_sections), :43 (timetable_periods), :48 (subjects)

Add `.eq("tenant_id", tenantId)` at:
- apps/web/src/app/assessments/[id]/page.tsx:59 (subjects)
- apps/web/src/app/students/[id]/report-card/page.tsx:31 (students — this also makes a foreign id fall through to the existing `notFound()` at line 40) and :36 (academic_terms)

The two academic_years reads (hostel:34, transport:34) are the highest-value fixes: with `.limit(1)` and no tenant filter they can hand the view another school's academic_year_id, which breaks every allocation write.

Do NOT change assessments/[id]/page.tsx:65 or :77 — both are already constrained through the tenant-verified assessment row fetched at line 40-48.

The finder's second suggestion (replace `tenants[0]` with a persisted, membership-validated active-tenant selection) is a separate feature gap, not part of this fix; the one-line filters make each page internally consistent regardless of which tenant `tenants[0]` resolves to.

---

### 83. Imports: after approving a commit the page polls forever and the "queued" spinner never resolves

- **Location:** `apps/web/src/app/imports/imports-view.tsx:103`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** web-correctness

**What is wrong.** `approved` is set to true on approve and is never cleared when the job finishes, so the 3-second polling interval runs for the lifetime of the page and the terminal "Import queued…" spinner card stays on screen even after the job status becomes `committed`.

**How it fails.** A school admin imports 400 students, clicks "Approve 400 rows", and `setApproved(true)` starts a 3s poll. Thirty seconds later the worker commits and the history table below shows status `committed` with 400 imported — but the spinner card at line 390-397 still says "Import queued…" and spins forever, and the browser keeps hitting GET /api/v1/imports every 3 seconds until the tab is closed. The admin cannot tell the import finished from the primary status indicator, and leaving the tab open on a school laptop generates ~1,200 API calls per hour against a rate-limited API. Contrast reports-view.tsx:103-107, which correctly stops when no job is queued/processing.

**Evidence.**

```
apps/web/src/app/imports/imports-view.tsx:102-107
```
	// While a job is committing, poll history so progress is visible.
	useEffect(() => {
		if (!approved) return;
		const timer = setInterval(() => void reload(), 3000);
		return () => clearInterval(timer);
	}, [approved, reload]);
```
`approved` is only reset in `resetWizard()` (line 207-212) and `handleUpload` (line 113) — never by the poll itself. `handleUpload`/`handleValidate`/`handleApprove` (lines 109-190) are also try/finally with no catch, so a network drop mid-upload shows nothing at all.
```

**Fix.** In apps/web/src/app/imports/imports-view.tsx, derive the in-flight state from the live job status instead of the sticky `approved` flag (mirrors reports-view.tsx:103-107 and avoids set-state-in-effect, which the file already has to suppress at line 98). Add near line 101:

  const TERMINAL = ["committed", "failed", "cancelled"];
  const committing = approved && !jobs.some((j) => j.id === upload?.jobId && TERMINAL.includes(j.status));

Then change the poll gate at line 104 from `if (!approved) return;` to `if (!committing) return;` with deps `[committing, reload]`, and change the spinner card at line 390 from `{approved && (` to `{committing && (`. Leave `approved` driving the step-2/step-3 hide conditions (lines 266, 336) so the wizard does not reappear once the job finishes; the history table below is then the completion indicator, which is what the `imports.queued` copy already promises. Optionally show a one-line terminal result there instead of the spinner. Separately, add `catch { setError(t("common.apiUnreachable")); }` before the `finally` in handleUpload (138), handleValidate (166) and handleApprove (187), matching handleDownload at line 202.

---

### 84. A linked parent who opens any page other than "/" is dropped into the "Set up your school" wizard and can create a bogus tenant

- **Location:** `apps/web/src/app/onboarding/page.tsx:24`
- **Category:** routing-authorization · **Verdict:** CONFIRMED (high) · **Found by:** web-security

**What is wrong.** Only the root page (apps/web/src/app/page.tsx:27-33) has the guardian branch that routes a linked parent to /portal. Every other protected page ends its tenant lookup with `if (!tenants || tenants.length === 0) redirect("/onboarding")`, and /onboarding itself only checks for tenant membership — never for a guardian link. Parents are deliberately not tenant members (migration 0009), so every deep link funnels them into school creation, and POST /api/v1/onboarding is guarded by AuthGuard alone.

**How it fails.** A parent receives the fee-reminder SMS/report-card link that points at /finance (or simply bookmarks /students from a demo). Signed in, the proxy lets them through, finance/page.tsx:27 finds no tenants for them and redirects to /onboarding, which at line 24 sees no membership and renders the OnboardingWizard. The parent — expecting their child's fee statement — fills in the form and creates a real tenant with themselves as school_owner. The platform now carries a junk school with a trial subscription in the control-centre tenant list and revenue metrics, and the parent still cannot reach their portal.

**Evidence.**

```
apps/web/src/app/onboarding/page.tsx:19-26
    const { data: tenants } = await supabase
      .from("tenants").select("id").order("created_at", { ascending: true }).limit(1);
    if (tenants && tenants.length > 0) {
      redirect("/");
    }
    // no guardians check — falls through to <OnboardingWizard>

apps/web/src/app/page.tsx:26-34 has the branch that every other page lacks:
    const { data: guardianLinks } = await supabase.from("guardians").select("id").limit(1);
    if (guardianLinks && guardianLinks.length > 0) { redirect("/portal"); }

apps/api/src/onboarding/onboarding.controller.ts:23-30 — `@Post()` `@UseGuards(AuthGuard)` only.
```

**Fix.** Minimal fix in /Users/admin/Atlas-System/apps/web/src/app/onboarding/page.tsx: after the existing `if (tenants && tenants.length > 0) redirect("/")` block (line 24-26) and before `getServerDict()`, add the same guardian branch that page.tsx:26-33 uses — `const { data: guardianLinks } = await supabase.from("guardians").select("id").limit(1); if (guardianLinks && guardianLinks.length > 0) redirect("/portal");`. Placing it after the tenants check preserves page.tsx's precedence (a staff member who is also a guardian still gets the dashboard). Because all 26 protected pages already funnel no-tenant users through /onboarding, this single edit fixes every deep link at once — no per-page change and no proxy.ts change is required. The "guardians read own row" RLS policy from migration 0009 already makes this query return the parent's row under the anon-key server client. Optional hardening if junk tenants are a concern operationally: in apps/api/src/onboarding/onboarding.controller.ts, before calling onboard_school, reject when the caller is already linked as a guardian (`select id from guardians where user_id = req.user.id`) with a `{ code: 'ONBOARDING_GUARDIAN_ACCOUNT' }` 400.

---

### 85. Dashboard attendance read is not paginated — "Present today" can show zero on a day every register was taken

- **Location:** `apps/web/src/app/page.tsx:78`
- **Category:** data-truncation · **Verdict:** CONFIRMED (high) · **Found by:** web-correctness

**What is wrong.** The 30-day attendance_sessions read has no `.range()` pagination and no ordering, so once a school exceeds the Supabase 1000-row cap over the window, PostgREST returns an arbitrary 1000 sessions and today's rows may be among the dropped ones.

**How it fails.** A large secondary school runs Form 1–6 with 8 streams each = 48 active sections × ~21 school days in the 30-day window = ~1,008 attendance_sessions rows. The read caps at 1000 with no ORDER BY, so which sessions come back is arbitrary. If today's 48 sessions fall outside the returned set, `byDate.get(today)` is undefined and the headline tile renders "0" present with the hint "No registers taken" (dash.noRegisters) on a morning when every class teacher took the register — and the 30-day trend chart is missing days. The head teacher's first-glance metric is simply wrong. The same file deliberately paginates payments and invoices with `fetchAllRows` immediately above and below this query, so the omission is an oversight, not a deliberate cap.

**Evidence.**

```
apps/web/src/app/page.tsx:78-82 (no .range, no .order):
```
		supabase
			.from("attendance_sessions")
			.select("session_date, attendance_records(status)")
			.eq("tenant_id", tenantId)
			.gte("session_date", monthAgo),
```
while the neighbouring money reads use the helper at page.tsx:44-58 (`// Supabase caps row reads at 1000; paginate money-summation reads…`) — e.g. page.tsx:83-89 for payments and 90-96 for invoices.
Consumed at page.tsx:120 `const todayBucket = byDate.get(today);` and page.tsx:149-152 for `presentToday` / `attendanceRateToday`.
```

**Fix.** In apps/web/src/app/page.tsx, replace the bare attendance_sessions read (lines 78-82) with the existing fetchAllRows helper, and give it a STABLE sort — a unique tiebreaker is mandatory or .range() paging can duplicate/skip same-date rows and corrupt the buckets:

  fetchAllRows<{ session_date: string; attendance_records: Array<{ status: string }> | null }>(
    (from, to) =>
      supabase
        .from("attendance_sessions")
        .select("session_date, attendance_records(status)")
        .eq("tenant_id", tenantId)
        .gte("session_date", monthAgo)
        .order("session_date", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
  ),

Then change the destructure at line 63 from `{ data: sessions }` to `sessions` and the loop at line 107 from `sessions ?? []` to `sessions`. Descending session_date means any residual truncation drops the oldest days rather than today; `.order("id")` is the unique tiebreaker that makes paging correct.

Better fix if you want to spend more: this read also drags every attendance_record for 30 days into the Node process (a 2,000-student school x 22 days is ~44k embedded rows, and PostgREST's max-rows does not bound embedded resources). Per the repo's "business logic lives in NestJS + Postgres" rule, replace it with an app.* RPC + service-role public wrapper that returns one row per session_date with present/total counts, which removes both the truncation and the payload problem in one move.

---

### 86. Report-card page picks a term from another school, so it fails to render with no user action

- **Location:** `apps/web/src/app/students/[id]/report-card/page.tsx:35`
- **Category:** cross-tenant-data-mixing · **Verdict:** CONFIRMED (high) · **Found by:** tenant-isolation

**What is wrong.** `academic_terms` is fetched with no tenant filter and no `.eq("id")`, and `students` is fetched by id alone; the page then auto-selects a default term across every tenant the user belongs to, while sending the oldest tenant's id to the report API.

**How it fails.** User U is an active member of School A (oldest membership) and School B. School B's terms run later in the calendar than School A's. U opens /students/<an A student>/report-card. `tenant` resolves to School A (lines 21-27), but `terms` is loaded unfiltered, so RLS returns A's and B's terms merged and ordered by starts_on. The default-term logic at lines 42-46 (`terms.find(t => t.starts_on <= today && t.ends_on >= today) ?? terms.at(-1)`) matches or falls back to a School B term id. The view then requests the report card with `x-tenant-id: <School A>` and that School B `termId`; app.report_card looks the term up as `where id = p_term_id and tenant_id = p_tenant_id` and raises REPORT_TERM_NOT_FOUND (00000000000006_assessments.sql:297). The report card never renders and there is no term or school switcher in the UI to recover. Separately, because `students` is read by id only, navigating to /students/<a School B student id>/report-card renders School B's student name and admission number inside a page whose AppShell header says School A.

**Evidence.**

```
apps/web/src/app/students/[id]/report-card/page.tsx:29-39 — `tenant` is resolved at line 27 and then ignored by both reads:
```tsx
29	const [{ data: student }, { data: terms }] = await Promise.all([
30		supabase
31			.from("students")
32			.select("id, first_name, last_name, student_number")
33			.eq("id", id)
34			.maybeSingle(),
35		supabase
36			.from("academic_terms")
37			.select("id, name, starts_on, ends_on")
38			.order("starts_on"),
39	]);
```
Default-term selection across the merged list, same file lines 43-46:
```tsx
	const current =
		(terms ?? []).find((t) => t.starts_on <= today && t.ends_on >= today) ??
		(terms ?? []).at(-1);
```
```

**Fix.** In apps/web/src/app/students/[id]/report-card/page.tsx, add the tenant filter to both reads in the `Promise.all` (lines 29-39), matching finance/[id]/page.tsx:38-39 and reports/page.tsx:35:

  supabase
    .from("students")
    .select("id, first_name, last_name, student_number")
    .eq("id", id)
    .eq("tenant_id", tenant.id)
    .maybeSingle(),
  supabase
    .from("academic_terms")
    .select("id, name, starts_on, ends_on")
    .eq("tenant_id", tenant.id)
    .order("starts_on"),

The existing `if (!student) notFound();` at line 40 then correctly 404s a student from another school instead of passing the id through to a doomed API call. No API, RPC, or migration change is needed — the server side is already correctly scoped. Optional cleanup: the selected first_name/last_name/student_number columns are never rendered, so the select can be narrowed to "id".

---

### 87. Web import dialog swallows spreadsheet parse failures — a corrupt file silently does nothing

- **Location:** `apps/web/src/app/students/students-view.tsx:673`
- **Category:** error-handling · **Verdict:** CONFIRMED (high) · **Found by:** input-validation

**What is wrong.** `handleFile` is invoked as `void handleFile(file)` with no `.catch()`, and its body has no try/catch around `XLSX.read`, so any parse error becomes an unhandled promise rejection and the dialog gives the user no feedback at all.

**How it fails.** A school admin selects a password-protected .xlsx (very common when a spreadsheet came from a bank or an accountant), or a truncated download, or a .csv that was renamed to .xlsx. `XLSX.read(buffer)` throws inside `handleFile`; because the call site is `void handleFile(file)` with no rejection handler and the function has no try/catch, the rejection goes unhandled. `setRows` is never called, `setError` is never called: the dialog stays exactly as it was, showing no "N rows loaded" line and no error, and the Validate button remains disabled. The user re-picks the same file repeatedly with zero diagnostic information, and never learns the file needs to be re-saved. (The API's server-side parser does distinguish this case — `IMPORT_FILE_ENCRYPTED` at imports.parser.ts:44-49 — but this dialog never reaches the API.)

**Evidence.**

```
apps/web/src/app/students/students-view.tsx:617-626 — no try/catch:
```tsx
	async function handleFile(file: File) {
		setError(null);
		setReport(null);
		setDone(null);
		const buffer = await file.arrayBuffer();
		const workbook = XLSX.read(buffer);
		const sheet = workbook.Sheets[workbook.SheetNames[0]];
		const raw = XLSX.utils.sheet_to_json<RawRow>(sheet, { raw: false });
		setRows(raw.map(toImportRow));
	}
```
students-view.tsx:671-674 — the fire-and-forget call site:
```tsx
						onChange={(e) => {
							const file = e.target.files?.[0];
							if (file) void handleFile(file);
						}}
```
Note also that `workbook.SheetNames[0]` is used unconditionally — a workbook whose first sheet is empty/hidden yields `undefined`, and `sheet_to_json(undefined)` throws down the same silent path (the server parser deliberately picks the first sheet *with content*, imports.parser.ts:46-49).
```

**Fix.** In /Users/admin/Atlas-System/apps/web/src/app/students/students-view.tsx:

1. Wrap the body of `handleFile` (lines 617-626) in try/catch and always give feedback:
```tsx
async function handleFile(file: File) {
  setError(null); setReport(null); setDone(null); setRows([]);
  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer);
    const name = workbook.SheetNames.find((n) => workbook.Sheets[n]?.["!ref"]);
    const raw = name ? XLSX.utils.sheet_to_json<RawRow>(workbook.Sheets[name], { raw: false }) : [];
    if (raw.length === 0) { setError(t("students.importEmpty")); return; }
    if (raw.length > 2000) { setError(t("students.importTooLarge")); return; }
    setRows(raw.map(toImportRow));
  } catch {
    setError(t("students.importUnreadable"));
  }
}
```
(The `SheetNames.find(... "!ref")` mirrors imports.parser.ts:46-49; note it fixes a 0-row silent case, not a throw.)

2. At the call site (lines 671-674), still attach a rejection handler and reset the input so re-picking the same file re-fires `onChange`:
```tsx
onChange={(e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (file) handleFile(file).catch(() => setError(t("students.importUnreadable")));
}}
```

3. Add the three new keys to BOTH the EN and SW blocks of /Users/admin/Atlas-System/packages/i18n/src/index.ts (key sets must stay mirrored; apps/web/src/i18n/index.ts is only a re-export): `students.importUnreadable` ("This file could not be read — if it is password-protected, re-save it without a password." / SW), `students.importEmpty` ("No data rows found in this file." / SW), `students.importTooLarge` ("This file has more than 2000 rows — split it." / SW).

---

### 88. Fast typing in the students / parents / admissions search shows results for a previous query

- **Location:** `apps/web/src/app/students/students-view.tsx:182`
- **Category:** race-condition · **Verdict:** CONFIRMED (high) · **Found by:** web-correctness

**What is wrong.** `reload()` has no AbortController and no request-id guard, so when two debounced searches overlap the slower (older) response lands last and overwrites the fresher result set while the input still shows the newer query.

**How it fails.** On a 1.5s-latency mobile link, a clerk types "Ju" (debounce fires at t=300ms → request A for "Ju"), then finishes typing "Juma" (debounce fires at t=700ms → request B for "Juma"). B returns at t≈2.0s and sets rows = the 3 Juma matches, loading=false. A returns at t≈2.2s and overwrites rows with the 40 "Ju*" matches and count, while the search box still reads "Juma". The clerk sees a list that does not match what they typed, and the count shown next to "students in total" is wrong for the visible query. Pressing Next then pages through the wrong result set.

**Evidence.**

```
apps/web/src/app/students/students-view.tsx:182-218 — nothing discards a stale response:
```
	const reload = useCallback(async () => {
		setLoading(true);
		...
		const { data, count: exact, error } = await builder
			.order("created_at", { ascending: false })
			.range(page * STUDENTS_PAGE_SIZE, ...);
		if (error) { setLoadError(t("err.server")); } else {
			setRows((data ?? []) as unknown as StudentListRow[]);
			setCount(exact ?? 0);
		}
		setLoading(false);
	}, [tenantId, search, page, t]);

	useEffect(() => { if (firstRun.current) { firstRun.current = false; return; } void reload(); }, [reload]);
```
Identical in apps/web/src/app/parents/parents-view.tsx:86-120 and apps/web/src/app/admissions/admissions-view.tsx:79-113. The correct guard already exists elsewhere in the app — students/[id]/report-card/report-card-view.tsx:76-99 uses an `ignore` flag in the effect cleanup.
```

**Fix.** Apply the existing `ignore`-flag pattern from apps/web/src/app/students/[id]/report-card/report-card-view.tsx:74-99 to all three list views. Minimal change per file — keep `reload` but give it a staleness predicate and guard every state write, then add the cleanup:

apps/web/src/app/students/students-view.tsx (same shape in parents/parents-view.tsx:86-120 and admissions/admissions-view.tsx:79-113):
1. Change the signature to `const reload = useCallback(async (isStale: () => boolean) => { ... }, [tenantId, search, page, t]);`
2. Immediately after the awaited query (`const { data, count: exact, error } = await builder...`), insert `if (isStale()) return;` BEFORE the `if (error) ... else { setRows(...); setCount(...) }` block and before `setLoading(false)` — so a superseded response touches neither rows/count nor the loading flag.
3. Replace the effect at students-view.tsx:210-218 with:
   useEffect(() => {
     if (firstRun.current) { firstRun.current = false; return; }
     let ignore = false;
     void reload(() => ignore);
     return () => { ignore = true; };
   }, [reload]);
   (parents-view.tsx:112-120, admissions-view.tsx:105-113 identically.)

No API, DB, or migration change is required — this is purely client-render state.

---

### 89. Swahili users see raw English database enums in every status column

- **Location:** `apps/web/src/app/students/students-view.tsx:302`
- **Category:** i18n · **Verdict:** CONFIRMED (high) · **Found by:** web-correctness

**What is wrong.** Status badges render the raw DB value (`active`, `graduated`, `queued`, `committed`, `processing`) instead of a dictionary lookup, even though the column headers around them are translated.

**How it fails.** A school admin who has switched the interface to Kiswahili opens /students. The column header reads "Hali" (translated) but every badge underneath reads "active" / "transferred" / "graduated" in English. Same on /admissions, /academics (year, section and subject status), /staff, /settings (tenant status), /imports (job status: queued, mapping, committed, failed) and /reports (queued, processing, completed, expired). The dictionary already proves the project's standard — every other enum family (finance.status.*, finance.method.*, assessments.type.*, hostel.gender.*, acct.type.*, inventory.kind.*) has full EN+SW coverage, so these columns are the odd ones out.

**Evidence.**

```
apps/web/src/app/students/students-view.tsx:301-303
```
												<TableCell>
													<Badge variant="outline">{s.status}</Badge>
												</TableCell>
```
Same raw render at admissions-view.tsx:239, academics-view.tsx:170 / 235 / 305, imports-view.tsx:434 (`<Badge variant={STATUS_VARIANT[job.status] ?? "secondary"}>{job.status}</Badge>`), reports-view.tsx:294, settings-view.tsx:181 and staff-view.tsx.
Verified the dictionary is otherwise complete: packages/i18n/src/index.ts has 713 EN keys and 713 SW keys with zero asymmetry and zero duplicates, and every dynamic key family used with an `as DictKey` cast resolves (getDict falls back to returning the key verbatim, so any gap would print the raw key on screen).
```

**Fix.** Add one shared mirrored key family in /Users/admin/Atlas-System/packages/i18n/src/index.ts (EN block and SW block, identical key sets — the turbo typecheck enforces the DictKey union), covering the union of the DB-checked values: `status.active`, `status.transferred`, `status.withdrawn`, `status.graduated`, `status.archived`, `status.draft`, `status.closed`, `status.inactive`, `status.invited`, `status.suspended`, `status.revoked`, `status.uploaded`, `status.validated`, `status.queued`, `status.committing`, `status.committed`, `status.failed`, `status.cancelled`, `status.processing`, `status.completed`, `status.expired`. A single family is preferable to per-module families because the same literals recur across students, academics, imports, reports and memberships.

Then swap the raw renders for a lookup, matching the existing `as DictKey` pattern used at finance-view.tsx:148:
- apps/web/src/app/students/students-view.tsx:302 → `{t(`status.${s.status}` as DictKey)}`
- apps/web/src/app/admissions/admissions-view.tsx:239 (same)
- apps/web/src/app/academics/academics-view.tsx:170, 235, 305 (same, on y.status / s.status)
- apps/web/src/app/imports/imports-view.tsx:434 → keep `variant={STATUS_VARIANT[job.status] ?? "secondary"}`, translate only the child text
- apps/web/src/app/reports/reports-view.tsx:294 → translate the `{job.status}` text, leave the spinner condition keyed on the raw value
- apps/web/src/app/settings/settings-view.tsx:181 and apps/web/src/app/staff/staff-view.tsx:121 → `{t(`status.${m.status}` as DictKey)}`
- apps/mobile/src/app/students/[id].tsx:238 → `label={t(`status.${student.status}` as DictKey)}` (keep `tone={student.status === "active" ? ...}` on the raw value)

Import `type DictKey` where a file does not already have it. Do not translate the raw value used for variant/tone/conditional logic — only the displayed label.

---

### 90. proxy.ts discards Supabase's rotated session cookies whenever it issues a redirect

- **Location:** `apps/web/src/proxy.ts:45`
- **Category:** session-management · **Verdict:** CONFIRMED (medium) · **Found by:** web-security

**What is wrong.** `supabase.auth.getUser()` can rotate the refresh token and calls back into `setAll`, which rebuilds `response` with the fresh cookies. Both redirect branches then return a brand-new `NextResponse.redirect(url)` and never copy those cookies onto it, so the browser keeps the pre-rotation token while the server has already consumed it.

**How it fails.** A head teacher leaves the tab idle past the access-token TTL and then clicks a bookmarked https://app.atlas.co.tz/login. The proxy's getUser() refreshes the session (Supabase rotates the refresh token and `setAll` puts the new pair on `response`), `user` is now truthy, so line 45-49 returns `NextResponse.redirect('/')` — dropping the Set-Cookie headers. The browser still holds the old refresh token; once Supabase's reuse-detection window closes, the next refresh with that stale token fails and the user is bounced to /login and must re-authenticate mid-shift. The same drop happens on the unauthenticated → /login branch.

**Evidence.**

```
apps/web/src/proxy.ts:23-32 (setAll writes the refreshed cookies onto `response`)
    response = NextResponse.next({ request });
    for (const { name, value, options } of cookiesToSet) {
      response.cookies.set(name, value, options);
    }
apps/web/src/proxy.ts:44-49 — the refreshed `response` is then thrown away:
    if (user && path.startsWith("/login")) {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      return NextResponse.redirect(url);
    }
```

**Fix.** In /Users/admin/Atlas-System/apps/web/src/proxy.ts, carry the cookies from `response` onto every early-return redirect. Add a helper above `proxy` and use it in both branches:

    function redirectWith(url: URL, from: NextResponse) {
        const redirect = NextResponse.redirect(url);
        for (const cookie of from.cookies.getAll()) redirect.cookies.set(cookie);
        return redirect;
    }

then replace line 46 `return NextResponse.redirect(url);` with `return redirectWith(url, response);` and line 51 likewise. (`response` must stay a `let` because `setAll` reassigns it — the helper reads it at call time, which is after `getUser()` has resolved, so it sees the rotated pair.) No other file changes are needed; the DB, guards and the API session handling are unaffected.

---

### 91. `process-imports.js --once` and `process-reports.js --once` always exit 0, even when the drain fails completely

- **Location:** `apps/workers/src/process-imports.ts:155`
- **Category:** reliability · **Verdict:** CONFIRMED (high) · **Found by:** workers-outbox

**What is wrong.** Both standalone entrypoints wrap the drain in a top-level `.catch()` that only logs, so the process exits 0 whether or not anything was drained. `drain-outbox.ts` deliberately does the opposite (its `--once` path lets errors reach `process.exit(1)`), so the failure semantics the smokes and any CI/cron wrapper rely on are inconsistent across the three workers.

**How it fails.** A cron job or CI step runs `node apps/workers/dist/process-imports.js --once` with a stale `SUPABASE_SERVICE_ROLE_KEY`. `drainImportsOnce` throws on the very first `from('import_jobs')` select; the `.catch()` at line 156 logs `imports drain pass errored` and the process exits 0. The wrapper records a successful run and no alert fires, while every queued import stays at `status='queued'` indefinitely. The same applies to `process-reports.js --once`: a run in which every single report job fails (each caught and marked `failed` inside `drainReportsOnce` at lines 279-292) also exits 0, so `smoke-reports.mjs`'s `execFileSync` at line 47 passes on a totally broken worker and only the subsequent DB assertions catch it.

**Evidence.**

```
apps/workers/src/process-imports.ts:152-160:
```ts
  const once = process.argv.includes("--once");
  const supabase = createServiceClient();
  const run = () =>
    drainImportsOnce(supabase).catch((err) =>
      logger.error({ err: (err as Error).message }, "imports drain pass errored"),
    );
  void run().then(() => {
    if (once) return;
```
Identical shape in apps/workers/src/process-reports.ts:302-309. Contrast apps/workers/src/drain-outbox.ts:167-173 and 198-201, which get it right:
```ts
  if (once) {
    // --once must fail loudly so smokes surface real errors.
    const result = await drainOnce();
```
```ts
void main().catch((err) => {
  logger.error({ err: (err as Error).message }, "outbox drain fatal");
  process.exit(1);
});
```
```

**Fix.** Split the `--once` path from the poll path in both entrypoints, matching `drain-outbox.ts:165-201`. Keep the swallowing `.catch()` for interval passes only (that part is correct — a single bad pass must not kill a poller).

`apps/workers/src/process-imports.ts`, replace lines 155-169:

```ts
  const pass = () =>
    drainImportsOnce(supabase).catch((err) =>
      logger.error({ err: (err as Error).message }, "imports drain pass errored"),
    );

  if (once) {
    // --once must fail loudly so smokes/cron surface real errors.
    void drainImportsOnce(supabase)
      .then((processed) => logger.info({ processed }, "imports drain pass complete"))
      .catch((err) => {
        logger.error({ err: (err as Error).message }, "imports drain fatal");
        process.exit(1);
      });
  } else {
    void pass().then(() => {
      let running = false;
      setInterval(() => {
        if (running) return;
        running = true;
        void pass().finally(() => {
          running = false;
        });
      }, POLL_MS);
    });
  }
```

`apps/workers/src/process-reports.ts`, lines 305-319: identical change with `drainReportsOnce`/`"reports drain fatal"`/`REPORTS_POLL_MS`.

Do NOT also exit non-zero when jobs were marked `failed` — `drain-outbox --once` exits 0 with `failed > 0`, and per-job failure is a retryable data condition (`process-imports.ts:139-144`, `process-reports.ts:279-292`), not a run failure. Adding it would break the consistency this fix is establishing.

Optional follow-up (separate, improves the diagnostic, not the exit code): `apps/api/scripts/smoke-imports.mjs:60` and `apps/api/scripts/smoke-reports.mjs:48` pass `stdio: 'pipe'`, which discards the worker's stderr. Switch to `'inherit'`, or catch the `execFileSync` throw and re-throw with `err.stderr.toString()`, so the worker's real error is visible once it starts exiting 1.

---

### 92. Import and report workers process queued jobs for suspended/archived tenants — unlike the outbox drainer, they have no tenant-status filter

- **Location:** `apps/workers/src/process-imports.ts:126`
- **Category:** access-control · **Verdict:** CONFIRMED (high) · **Found by:** gap:tenant suspension / offboarding / data deletion (RLS layer never checks tenant status; no purge or export exists)

**What is wrong.** `drain-outbox.ts` deliberately joins `tenants!inner(status)` and restricts to the four live statuses so a suspended school never sends SMS, but `drainImportsOnce` and `drainReportsOnce` select jobs purely by job status. A job queued before suspension/archival is still committed or rendered afterwards — writing new student rows into a suspended school and generating fresh PDFs of its financial data into the `reports` bucket.

**How it fails.** A school uploads an admissions spreadsheet at 09:00 and clicks Commit (`import_jobs.status='queued'`). At 09:05 the platform admin suspends the school for non-payment; the API immediately 403s every request with TENANT_SUSPENDED, so the operator believes the school is frozen. At 09:06 the imports poller's next pass runs `.in("status", ["queued","committing"])` with no tenant join, claims the job and inserts 180 new pupil records — plus guardians and enrolments — into the suspended tenant, and uploads an error-report CSV containing raw spreadsheet rows to the `imports` bucket. The same holds for `report_jobs`: a queued fee-collection report is rendered and its PDF/XLSX written to storage after archival, and the stale-claim recovery at process-reports.ts:250-254 will even requeue an archived tenant's job indefinitely.

**Evidence.**

```
apps/workers/src/process-imports.ts:125-132
```ts
  const { data: jobs, error } = await supabase
    .from("import_jobs")
    .select("id, tenant_id, domain, created_by")
    .in("status", ["queued", "committing"])
    .order("created_at")
    .limit(10);
```
apps/workers/src/process-reports.ts:256-262
```ts
    const { data: jobs, error } = await supabase
      .from("report_jobs")
      .select("id, tenant_id, report_key, format, params, reference, requested_by")
      .eq("status", "queued")
      .order("created_at")
      .limit(5);
```
Compare apps/workers/src/drain-outbox.ts:87-93, which gets it right:
```ts
    // !inner join so draft/suspended/archived tenants never send queued
      .select("id, tenant_id, recipient, template, payload, attempts, tenants!inner(status)")
      .eq("status", "pending")
      .in("tenants.status", ["configuration", "data_review", "training", "live"]);
```
```

**Fix.** Minimal fix — add the same tenant-status gate the outbox uses, in THREE places, not two:

1. apps/workers/src/process-imports.ts:126-131 (drainImportsOnce)
2. apps/workers/src/process-reports.ts:256-261 (drainReportsOnce)
   Change the select list to include the join and add the filter, e.g.
     .select("id, tenant_id, domain, created_by, tenants!inner(status)")
     .not("tenants.status", "in", "(suspended,archived)")
   Prefer the negative form over copying drain-outbox's positive four-status allowlist: `tenants.status` still defaults to 'draft' (migration 0001:40), and an allowlist of configuration/data_review/training/live would silently starve any job belonging to a tenant in 'draft' forever. Strip the joined `tenants` key before passing the row to processImportJob/processReportJob, or type the destructure target (per the CLAUDE.md eslint gotcha, don't `as`-cast the supabase result).
3. apps/workers/src/main.ts:36-70 — the BullMQ processors miss the same check and are the fast path. Add `tenants!inner(status)` + the same `.not(...)` to the imports lookup (line 39-44), and for reports do the status check as a read before the atomic queued→processing claim (the claim is an UPDATE and cannot join), bailing out as a no-op if the tenant is suspended/archived.

Optional hardening (the finder's second half, schema-compatible — both tables already allow 'cancelled': migration 0011:29-30 and 0012:21-22): in platform.controller.ts suspend()/archive(), move that tenant's `import_jobs` in ('queued','committing') and `report_jobs` in ('queued','processing') to 'cancelled' so they aren't resurrected on reactivate. Do this only if you accept that the operator must re-approve the import after reactivation — otherwise the filter alone is enough, since jobs simply resume when the tenant returns to a live status.

---

### 93. Nothing enforces one primary guardian per student, so a single event queues duplicate SMS to the same family

- **Location:** `supabase/migrations/00000000000004_students_guardians_invitations.sql:52`
- **Category:** data-integrity · **Verdict:** CONFIRMED (high) · **Found by:** concurrency-idempotency

**What is wrong.** student_guardians has no partial unique index on (student_id) where is_primary, while three independent writers set is_primary = true. Every SMS producer joins `sg.is_primary` without a LIMIT, so a student with two primary guardians generates two outbox rows — two SMS charges — per absence, clinic visit and fee reminder.

**How it fails.** A student is admitted through the students import, which unconditionally links their guardian with is_primary = true. Later the school links the father through the AI assistant's linkGuardian action with isPrimary = true (or through a second import row for the same child). The student now has two rows with is_primary = true. From that day, `app.mark_attendance`'s alert insert joins both rows and queues two absence SMS every time the child is marked absent; `app.queue_fee_reminders` (0009:204) and `app.record_clinic_visit` (0023:88, whose `limit 1` sits outside the join in a set-returning insert) behave the same way. The school pays double SMS for that family indefinitely and the parents receive duplicate messages.

**Evidence.**

```
supabase/migrations/00000000000004_students_guardians_invitations.sql:52-59 —
```
create table public.student_guardians (
  student_id uuid not null references public.students(id),
  guardian_id uuid not null references public.guardians(id),
  ...
  is_primary boolean not null default false,
  primary key (student_id, guardian_id)
);   -- no unique index on (student_id) where is_primary
```
Writers that set it true: 0011:219-221 and 0009:146-148 (`values (v_student_id, v_guardian_id, ..., true)`), and apps/api/src/ai/ai-actions.service.ts:2202-2207 —
```
const { error } = await supabase.admin.from('student_guardians').insert({
  student_id: resolved.student.id, guardian_id: resolved.guardian.id,
  relationship: ..., is_primary: args.isPrimary === true,
});
```
Consumers: 0005:162, 0009:204, 0017:206, 0023:89 — all `join public.student_guardians sg on sg.student_id = s.id and sg.is_primary`.
```

**Fix.** Two edits; the index alone is not sufficient (the existing catch at ai-actions.service.ts:2208 maps any 23505 to `GUARDIAN_ALREADY_LINKED`, so a bare unique index would surface a misleading error).

1. New migration `supabase/migrations/00000000000029_*.sql` (additive-only rule — do not edit 0004):
   `create unique index student_guardians_one_primary_idx on public.student_guardians (student_id) where is_primary;`
   No de-duplication step is needed unless production data already has multi-primary students; check first with `select student_id from public.student_guardians where is_primary group by student_id having count(*) > 1;` and demote all but one before creating the index.

2. `apps/api/src/ai/ai-actions.service.ts`, `linkGuardian.execute` (~line 2200): when `args.isPrimary === true`, demote first —
   `await supabase.admin.from('student_guardians').update({ is_primary: false }).eq('student_id', resolved.student.id).eq('is_primary', true);`
   before the insert. Correspondingly change the preview warning at line 2176 from "adding a second primary; SMS reminders pick one primary only" to "this will replace the current primary guardian for SMS".

Optional defence-in-depth if you prefer not to add a DB constraint: in the same new migration redefine `app.mark_attendance` and `app.queue_fee_reminders` to use `left join lateral (select g.full_name, g.phone from public.student_guardians sg join public.guardians g on g.id = sg.guardian_id where sg.student_id = s.id and sg.is_primary and g.phone is not null order by sg.guardian_id limit 1) g on true`, matching the pattern already used in 0017:206 and 0023:88.

---

### 94. student_guardians has no index on guardian_id — every parent-portal request seq-scans the cross-tenant link table

- **Location:** `supabase/migrations/00000000000004_students_guardians_invitations.sql:58`
- **Category:** performance · **Verdict:** CONFIRMED (high) · **Found by:** data-integrity-perf

**What is wrong.** student_guardians' only index is the primary key `(student_id, guardian_id)`, whose leading column is student_id. The parent portal resolves children by embedding student_guardians from guardians, i.e. filtering on guardian_id, which no index can serve.

**How it fails.** A parent opens /portal or requests a report card. `linkedStudents()` embeds `student_guardians(student_id)` off a guardians row, which PostgREST resolves as a lookup on `student_guardians.guardian_id` — with no index this is a full sequential scan of the table for all tenants (≈1,500 links per school × 100 schools = 150,000 rows). `reportCard()` calls `linkedStudents()` again, so each report-card view costs two full scans. Every parent request on the platform pays for every other school's guardian links, and portal latency grows as new schools are onboarded rather than as the parent's own school grows.

**Evidence.**

```
supabase/migrations/00000000000004_students_guardians_invitations.sql:52-59 — no secondary index at all:
```sql
create table public.student_guardians (
  student_id uuid not null references public.students(id),
  guardian_id uuid not null references public.guardians(id),
  relationship text not null default 'guardian'
    check (relationship in ('mother','father','guardian','sponsor','other')),
  is_primary boolean not null default false,
  primary key (student_id, guardian_id)
);
```
apps/api/src/parents/parents.controller.ts:82-85 — the guardian_id-side lookup:
```ts
    const { data: guardians } = await this.supabase.admin
      .from('guardians')
      .select('id, tenant_id, student_guardians(student_id)')
      .eq('user_id', userId);
```
(`guardians.user_id` is fine — 00000000000009_parents.sql:14 declares it `unique`.)
```

**Fix.** Add a new additive migration `supabase/migrations/00000000000029_student_guardians_guardian_idx.sql` containing exactly:

  create index if not exists student_guardians_guardian_idx
    on public.student_guardians (guardian_id);

That single index serves every guardian_id-side lookup: parents.controller.ts:82-85 (linkedStudents, both /portal/children and /portal/children/:id/report-card), the 50-row-per-page embeds in apps/web/src/app/parents/page.tsx:27-37 and parents-view.tsx:44-46, ai-tools.service.ts:604, and the guardians->student_guardians join in queue_announcement (0008:94). It also gives the guardians FK a supporting index for cascade/RI checks.

Do NOT add the finder's second suggestion (a partial index on (student_id) where is_primary): every is_primary consumer filters sg.student_id = s.id, which the existing primary key (student_id, guardian_id) already serves as its leading column — that index would be dead weight.

`concurrently` is optional here: the migrations contain no explicit BEGIN/COMMIT and are applied via `psql -f` in autocommit, so CREATE INDEX CONCURRENTLY would work, but the table is small enough today that the plain form (which is what `create index if not exists` above uses, and what matches the house style at 0004:30, 0004:46, 0004:72) is simpler and safe. Apply it in the same batch the human already has to run for 0016-0028.

---

### 95. A student with two `is_primary` guardians gets every absence alert and fee reminder twice — and the AI action that creates this state states the opposite

- **Location:** `supabase/migrations/00000000000005_attendance.sql:162`
- **Category:** cost-exposure · **Verdict:** CONFIRMED (high) · **Found by:** workers-outbox

**What is wrong.** `student_guardians` has PK `(student_id, guardian_id)` and a plain `is_primary boolean` with no partial-unique constraint. `app.mark_attendance` and `app.queue_fee_reminders` both inner-join on `sg.is_primary` with no DISTINCT/LIMIT, so N primary guardians produce N outbox rows per event. The AI `linkGuardian` action explicitly permits adding a second primary and warns 'SMS reminders pick one primary only', which is false.

**How it fails.** A school owner types into Ask ATLAS: 'add Baba Juma 0712345678 as primary guardian for STU-00042'. Juma already has his mother as primary. The proposal card shows the warning 'The student already has a primary guardian — adding a second primary; SMS reminders pick one primary only' and the owner confirms. From then on, every day Juma is marked absent, `app.mark_attendance` inserts TWO `attendance.absent` outbox rows (one per primary), and every fee-reminder run queues TWO `fees.reminder` SMS for the same invoice. Both parents receive duplicate messages and the school is billed 2× for that student forever; `app.record_clinic_visit` (migration 0023 line 93) has `limit 1` and does NOT duplicate, so the behaviour is inconsistent across modules and hard for support to diagnose.

**Evidence.**

```
supabase/migrations/00000000000004_students_guardians_invitations.sql:52-59 — no uniqueness on the primary flag:
```sql
create table public.student_guardians (
  student_id uuid not null references public.students(id),
  guardian_id uuid not null references public.guardians(id),
  relationship text not null default 'guardian' ...,
  is_primary boolean not null default false,
  primary key (student_id, guardian_id)
);
```
supabase/migrations/00000000000005_attendance.sql:160-166 fans out:
```sql
  from public.attendance_records ar
  join public.students s on s.id = ar.student_id
  join public.student_guardians sg on sg.student_id = s.id and sg.is_primary
  join public.guardians g on g.id = sg.guardian_id and g.phone is not null
```
Identical join in supabase/migrations/00000000000009_parents.sql:203-205 (`queue_fee_reminders`). apps/api/src/ai/ai-actions.service.ts:2174-2178:
```ts
      if (args.isPrimary === true && resolved.hasPrimary) {
        warnings.push(
          'The student already has a primary guardian — adding a second primary; SMS reminders pick one primary only.',
        );
      }
```
Compare supabase/migrations/00000000000023_clinic.sql:88-93, which does bound the fan-out with `limit 1`.
```

**Fix.** Pick one semantic and make everything agree; the minimal correct change is three parts, none of which may edit an existing migration file (additive-only rule). (1) apps/api/src/ai/ai-actions.service.ts — in linkGuardian.execute (~line 2202), before the insert, demote the incumbent when args.isPrimary === true: `await supabase.admin.from('student_guardians').update({ is_primary: false }).eq('student_id', resolved.student.id).eq('is_primary', true);` and change the preview warning at 2174-2178 to say the existing primary will be demoted (it currently claims 'SMS reminders pick one primary only', which is false). (2) New migration supabase/migrations/00000000000029_one_primary_guardian.sql — first demote any pre-existing extras (`update public.student_guardians sg set is_primary = false where sg.is_primary and sg.ctid <> (select min(x.ctid) from public.student_guardians x where x.student_id = sg.student_id and x.is_primary);`) then `create unique index student_guardians_one_primary_idx on public.student_guardians (student_id) where is_primary;`. (3) In that same 0029, `create or replace function app.mark_attendance(...)` copying the body from 0010 (NOT 0005 — 0010 is the live definition) with `distinct on (s.id)` / an ordered `limit 1` lateral on the guardian join, and likewise `create or replace function app.queue_fee_reminders(...)` from 0009:174, matching the `limit 1` pattern already used in 0023:93 and 0017:206. If instead the product decision is that multiple primaries SHOULD all be notified, then only step (1)'s warning text and the clinic/debtors `limit 1` need changing — but the two behaviours must not stay split.

---

### 96. `students.update` and `students.archive` are seeded, granted to head_teacher/school_admin and documented in the admin guide, but no endpoint implements them

- **Location:** `supabase/migrations/00000000000005_attendance.sql:219`
- **Category:** dead-permission · **Verdict:** CONFIRMED (high) · **Found by:** gap:student-enrolment-lifecycle (zero findings; entire feature absent)

**What is wrong.** Both permission keys exist in `public.permissions` (seed.sql:7-8) and are granted to `head_teacher` and `school_admin`, and `docs/ADMIN_GUIDE.md:132` advertises "Students: view / create / archive" as a role capability. `grep -rn "RequirePermission(" apps/api/src` shows only `students.view` (4 sites) and `students.create` (2 sites) — neither `students.update` nor `students.archive` is required by any route, because no such route exists. The RBAC model and the operator documentation promise a capability the product does not have.

**How it fails.** A school owner reads docs/ADMIN_GUIDE.md:132, assigns the `school_admin` role to the bursar so she can archive leavers, and tells her to clean up the roster before the plan renews. She logs in, opens `/students`, and finds only "Add student" and "Import" — no edit, no archive, no row menu (students-view.tsx has exactly two mutating call sites, `/api/v1/students` and `/api/v1/students/import`, at lines 459 and 632). She files a support ticket; the answer is that the feature does not exist, while the seat cap keeps rejecting new admissions (finding 2).

**Evidence.**

```
supabase/migrations/00000000000005_attendance.sql:218-226
  when 'head_teacher' then array[
    'students.view', 'students.create', 'students.update', 'students.archive',
    ...
  when 'school_admin' then array[
    'students.view', 'students.create', 'students.update', 'students.archive',

supabase/seed.sql:7-8
  ('students.update',          'students',   'Update student records'),
  ('students.archive',         'students',   'Archive student records'),

docs/ADMIN_GUIDE.md:132
| Students: view / create / archive | ✓ | ✓ | ✓ | view | view | view | view | view | view | own children |

$ grep -rn "RequirePermission(" apps/api/src | grep students
  -> only 'students.view' and 'students.create'
```

**Fix.** Pick one of two, both minimal. (A) Implement the endpoints the keys were seeded for: in /Users/admin/Atlas-System/apps/api/src/students/students.controller.ts add `@Patch(':id')` with `@RequirePermission('students.update')` and `@Patch(':id/status')` with `@RequirePermission('students.archive')`, each zod-validating the body via a new schema in students.schema.ts (status limited to the 0004 check constraint values 'active'|'transferred'|'withdrawn'|'graduated'|'archived'), each doing `.from('students').update(...).eq('id', id).eq('tenant_id', req.tenant.tenantId)` and writing an audit_logs row, then surface a row action in apps/web/src/app/students/students-view.tsx. (B) If archive stays out of scope, correct the promise instead: change docs/ADMIN_GUIDE.md:132 to "Students: view / create", drop 'students.update'/'students.archive' from the head_teacher and school_admin arrays in supabase/seed.sql:85 and :98, and — since migrations are additive-only — add a new migration that deletes those two role_permissions rows for the system roles rather than editing 00000000000005_attendance.sql. Note that (B) leaves schools unable to free plan seats (migration 0013:144 counts status='active'), so (A) is the better fix.

---

### 97. pre_primary (Chekechea) has no default grading bands, so record_scores' cross-join-lateral silently discards every mark and still returns 201

- **Location:** `supabase/migrations/00000000000006_assessments.sql:216`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** payroll-necta-domain

**What is wrong.** grading_bands is seeded for primary / o_level / a_level only, but grade_levels and subjects both accept 'pre_primary' (and the onboarding wizard offers it as "Chekechea"). app.grade_for returns zero rows for pre_primary, and because record_scores inserts via `cross join lateral app.grade_for(...)`, every score row is eliminated instead of erroring — the RPC reports `{saved: 0}` and the API returns HTTP 201.

**How it fails.** A nursery-plus-primary school selects Chekechea in step 3 of onboarding (LEVEL_PRESETS.pre_primary), giving a class_sections row whose grade_levels.education_level = 'pre_primary'. An admin creates a pre_primary subject through POST /api/v1/subjects (createSubjectSchema's educationLevel enum includes 'pre_primary'), the head teacher creates an assessment for the Chekechea section and enters marks for 30 children. record_scores passes both guards (v_level = v_subject_level = 'pre_primary'), then `cross join lateral app.grade_for(tenant,'pre_primary',marks)` yields no rows for any child, so `insert … select` writes nothing, GET DIAGNOSTICS sets v_count = 0, and the RPC returns `{saved: 0}` with no exception. The controller returns 201, and marks-view.tsx shows `t("assessments.marksSaved")` and calls router.refresh(). The teacher sees a green "Marks saved" message and then an empty mark sheet. Every mark for the class is lost, silently, on every attempt.

**Evidence.**

```
supabase/migrations/00000000000006_assessments.sql:211-220 —
`  insert into public.assessment_scores (tenant_id, assessment_id, student_id, subject_id, marks, grade, points, entered_by)`
`  select p_tenant_id, p_assessment_id, (r->>'studentId')::uuid, p_subject_id, (r->>'marks')::numeric, g.grade, g.points, p_actor`
`  from jsonb_array_elements(p_rows) r`
`  cross join lateral app.grade_for(p_tenant_id, v_level, (r->>'marks')::numeric) g`
`  … get diagnostics v_count = row_count;`
supabase/migrations/00000000000006_assessments.sql:104-122 — the default bands insert covers only 'primary', 'o_level', 'a_level'; there is no 'pre_primary' row anywhere (`grep -n pre_primary supabase/migrations/*.sql supabase/seed.sql` returns only the three CHECK constraints).
apps/api/src/assessments/assessments.schema.ts:3,9 — `const educationLevel = z.enum(['pre_primary','primary','o_level','a_level']); … createSubjectSchema = z.object({ …, educationLevel })`
apps/web/src/app/onboarding/onboarding-wizard.tsx:33 — `pre_primary: { hint: "(Chekechea)", grades: ["Chekechea"] },`
apps/web/src/app/assessments/[id]/marks-view.tsx:120-126 — `if (!response.ok) { … } setMessage(t("assessments.marksSaved")); router.refresh();` (the `saved` count is never inspected)
```

**Fix.** Additive migration only — 0006 is already live, so add supabase/migrations/00000000000029_pre_primary_grading.sql doing two things: (1) seed the missing defaults, `insert into public.grading_bands (tenant_id, education_level, grade, min_marks, max_marks, points) values (null,'pre_primary','A',80,100,1),(null,'pre_primary','B',60,79,2),(null,'pre_primary','C',40,59,3),(null,'pre_primary','D',20,39,4),(null,'pre_primary','E',0,19,5) on conflict do nothing;` (2) `create or replace function app.record_scores(...)` identical to 0006:159-231 except that immediately after `get diagnostics v_count = row_count;` it adds `if v_count <> jsonb_array_length(p_rows) then raise exception 'SCORES_NO_GRADING_BANDS'; end if;` — safe because the controller already rejects duplicate studentIds (assessments.controller.ts:194-200) and a same-statement duplicate would error in ON CONFLICT anyway. Then surface it: add 'SCORES_NO_GRADING_BANDS' to the rpcError allowlist in apps/api/src/assessments/assessments.controller.ts:209-215, add the case to describeError's switch in apps/web/src/app/assessments/[id]/marks-view.tsx:89-95, and add EN+SW `assessments.error.SCORES_NO_GRADING_BANDS` keys in packages/i18n/src/index.ts. Optional hardening: also apply the same non-silent treatment to the report-card RPC (0006:329) and 0018_necta.sql:195, and either add 'pre_primary' to presetSubjectsSchema/LEVELS or drop Chekechea from LEVEL_PRESETS so the offered level matches what the product can grade.

---

### 98. A student can hold two primary guardians, and the fee-reminder queue then sends and bills one SMS per primary

- **Location:** `supabase/migrations/00000000000009_parents.sql:204`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** finance-correctness

**What is wrong.** student_guardians has no uniqueness constraint on is_primary (its PK is (student_id, guardian_id)), and app.queue_fee_reminders inner-joins on `sg.is_primary` without a limit, so every extra primary guardian multiplies the outbound fee-reminder SMS for that student — the invoice-level dedupe only guards against re-queuing the same pending invoice.

**How it fails.** Student STU-00042 is admitted with her mother linked as primary (app.import_students always inserts is_primary = true — 00000000000010_audit_hardening.sql:68-70). Later the head teacher asks the assistant to 'add the father as the main contact', and the linkGuardian action inserts a second row with is_primary: true (nothing rejects it). The bursar clicks 'Send reminders': queue_fee_reminders emits two notification_outbox rows for the same unpaid invoice — the school pays twice for the SMS, both parents receive the same 'you owe 400,000 TZS' message, and the debtors report shows an arbitrary one of the two numbers because app.report_debtors picks the phone with `limit 1` (00000000000017_instalments.sql:202-208).

**Evidence.**

```
supabase/migrations/00000000000004_students_guardians_invitations.sql:52-59 —
```sql
create table public.student_guardians (
  student_id uuid not null references public.students(id),
  guardian_id uuid not null references public.guardians(id),
  ...
  is_primary boolean not null default false,
  primary key (student_id, guardian_id)
);
```
supabase/migrations/00000000000009_parents.sql:202-213 —
```sql
  from unpaid u
  join public.students s on s.id = u.student_id and s.status = 'active'
  join public.student_guardians sg on sg.student_id = s.id and sg.is_primary
  join public.guardians g on g.id = sg.guardian_id and g.phone is not null
  where u.balance > 0
    and not exists (
      select 1 from public.notification_outbox o
      ... and (o.payload->>'invoiceId')::uuid = u.id
    );
```
apps/api/src/ai/ai-actions.service.ts:2202-2207 —
```ts
      const { error } = await supabase.admin.from('student_guardians').insert({
        student_id: resolved.student.id,
        guardian_id: resolved.guardian.id,
        relationship: (args.relationship as string | undefined) ?? 'guardian',
        is_primary: args.isPrimary === true,
      });
```
```

**Fix.** Minimal, zero-data-risk fix first — make the notification RPCs pick one primary, matching the convention already used in 0017/0023. In a new migration (e.g. `supabase/migrations/00000000000029_*.sql`), `create or replace` both functions verbatim except for the guardian join:

1. `app.queue_fee_reminders` (currently 0009:202-205): replace
   `join public.student_guardians sg on sg.student_id = s.id and sg.is_primary`
   `join public.guardians g on g.id = sg.guardian_id and g.phone is not null`
   with
   `join lateral (select g.full_name, g.phone from public.student_guardians sg join public.guardians g on g.id = sg.guardian_id where sg.student_id = s.id and sg.is_primary and g.phone is not null order by sg.guardian_id limit 1) g on true`
   (deterministic `order by` so the debtors report and the SMS agree on the same number).

2. `app.mark_attendance` (0010:211-217): same substitution for the `attendance.absent` outbox insert — it has the identical fan-out.

Optionally also add the `order by sg.guardian_id` to the `report_debtors` lateral (0017:202-208) so the reported phone is stable rather than arbitrary.

Only if you additionally want the invariant enforced: add `create unique index student_guardians_one_primary_idx on public.student_guardians (student_id) where is_primary;` — but two prerequisites, or it breaks things: (a) it fails to create on any tenant that already has two primaries, so ship a demote-all-but-one backfill in the same migration; (b) `apps/api/src/ai/ai-actions.service.ts:2208` maps *any* 23505 to `GUARDIAN_ALREADY_LINKED`, so a second-primary rejection would surface as a wrong error code — branch on `error.message`/constraint name, and change `linkGuardian.execute` to demote the existing primary (`update student_guardians set is_primary = false where student_id = … `) before inserting, inside one RPC/transaction. If multi-primary is kept as an allowed state instead, fix the now-false preview warning text at line 2176.

---

### 99. Debtors report marks money overdue on the day it falls due, contradicting the invoice screen's own instalment states

- **Location:** `supabase/migrations/00000000000017_instalments.sql:178`
- **Category:** correctness · **Verdict:** CONFIRMED (high) · **Found by:** finance-correctness

**What is wrong.** app.report_debtors classifies an invoice or instalment as overdue when `due_on <= p_as_of`, while the instalment API and the invoice page both use strict `due_on < today`; the same balance therefore reads 'due' on the invoice screen and 'overdue' (and is chased) in the debtors report and its subtotals on the due date itself.

**How it fails.** Invoice INV-00031 for 600,000 TZS has a 3-part plan with instalment #2 of 200,000 due 2026-09-30. On 2026-09-30 the bursar opens /finance/INV-00031: instalment #2 renders with the badge 'due' (apps/api/src/finance/finance.controller.ts:256 `row.due_on < today` is false, so it falls through to the `due` branch; apps/web/src/app/finance/[id]/page.tsx:88 uses the same strict `<`). She then opens /finance/debtors with asOf = 2026-09-30 and the same family shows overdue = 200,000 TZS, is coloured red under 'Wadaiwa', and rolls into the class and grand-total overdue subtotals. The parent is chased for a payment that is not late until tomorrow. smoke-instalments.mjs never tests the boundary — every fixture date is d(-160)/d(-120)/d(-10)/d(300), never d(0).

**Evidence.**

```
supabase/migrations/00000000000017_instalments.sql:176-187 —
```sql
      'overdue', case
        when inv.has_schedule then greatest(inv.due_by_asof - inv.paid, 0)
        when inv.due_on is not null and inv.due_on <= p_as_of then inv.total - inv.paid
        else 0
      end
    ...
             coalesce((select sum(ii.amount) from public.invoice_instalments ii
                       where ii.invoice_id = i.id and ii.due_on <= p_as_of), 0) as due_by_asof,
```
apps/api/src/finance/finance.controller.ts:253-263 —
```ts
        let state: 'paid' | 'overdue' | 'due' | 'upcoming';
        if (rowPaid >= amount) {
          state = 'paid';
        } else if (row.due_on < today) {
          state = 'overdue';
```
```

**Fix.** Align the SQL to the strict convention already used everywhere else (an amount due today is not yet late). In supabase/migrations/00000000000017_instalments.sql, since 0016-0028 have not been applied to any environment, edit 0017 in place: line 178 `when inv.due_on is not null and inv.due_on < p_as_of then inv.total - inv.paid`, and line 187 `where ii.invoice_id = i.id and ii.due_on < p_as_of`. Fix the header comment at line 120 to read 'instalment amounts due strictly before p_as_of' so it matches line 122's 'once invoices.due_on has passed'. If 0017 has already been applied anywhere by the time this lands, do not edit it (migrations are additive-only) — add a new migration 00000000000029_debtors_due_boundary.sql containing the same `create or replace function app.report_debtors(...)` body with the two `<` fixes, and keep the existing public wrapper/grants. Then add a boundary case to apps/api/scripts/smoke-instalments.mjs: give one invoice an instalment due d(0), assert GET /finance/invoices/:id/instalments returns state 'due' for it AND GET /finance/debtors?asOf=d(0) reports overdue 0 for that amount, plus a d(-1) case asserting both flip to overdue.

---

### 100. app.compute_paye silently under-withholds PAYE when the configured bands have no terminal open-ended band

- **Location:** `supabase/migrations/00000000000025_payroll.sql:167`
- **Category:** money-calculation · **Verdict:** CONFIRMED (high) · **Found by:** rls-sql-security+payroll-necta-domain

**What is wrong.** The PAYE loop only taxes income above the highest threshold if a band with `up_to: null` exists; if a school's edited bands end with a finite up_to, the loop runs off the end and all income above that threshold is taxed at 0%. Neither app.update_payroll_settings nor the zod schema requires a terminal band or ascending order.

**How it fails.** A bursar opens Payroll → Settings and re-types the TRA bands, entering only the four bracket rows from the TRA table and omitting the open-ended "above 1,000,000" row: paye_bands = [{up_to:270000,rate:0},{up_to:520000,rate:0.08},{up_to:760000,rate:0.20},{up_to:1000000,rate:0.25}], then ticks Verified. updateSettingsSchema (apps/api/src/payroll/payroll.schema.ts:23-35) accepts it — payeBandSchema allows a nullable up_to but never requires one band to be null — and app.update_payroll_settings only checks `jsonb_typeof(p_rates->'paye_bands') <> 'array'` (00000000000025_payroll.sql:541-543), so it is stored. The head teacher's gross is 3,000,000 TZS; taxable base after 10% NSSF is 2,700,000. compute_paye walks all four bands, never hits the `exit`, and returns 0 + 20,000 + 48,000 + 60,000 = 128,000 instead of 128,000 + 0.30 × 1,700,000 = 638,000. The run is posted to the ledger (app.post_payroll) with ~510,000 TZS/month of PAYE under-withheld per senior employee — a TRA under-remittance the school only discovers at audit.

**Evidence.**

```
supabase/migrations/00000000000025_payroll.sql:166-177
  begin
    for v_band in select * from jsonb_array_elements(p_bands)
    loop
      v_upper := (v_band->>'up_to')::numeric;  -- null = top band
      if v_upper is null or p_income <= v_upper then
        v_tax := v_tax + (v_band->>'rate')::numeric * (p_income - v_prev);
        exit;
      end if;
      v_tax := v_tax + (v_band->>'rate')::numeric * (v_upper - v_prev);
      v_prev := v_upper;
    end loop;
    return round(greatest(v_tax, 0), 2);

The only validation on the bands (same file, 541-543):
    if p_rates is null or p_rates->'paye_bands' is null
       or jsonb_typeof(p_rates->'paye_bands') <> 'array' then
      raise exception 'PAYROLL_SETTINGS_INVALID';

The same loop also mis-computes if the array is not in ascending up_to order, which is likewise unvalidated.
```

**Fix.** Two small changes; since 0016-0028 are written but NOT yet applied anywhere, amend 0025 in place (otherwise add a 0029 with `create or replace`).

1. supabase/migrations/00000000000025_payroll.sql — in `app.update_payroll_settings` (line ~541), replace the lone `jsonb_typeof` check with a real band validation before the upsert:
```sql
declare
  v_bands jsonb := p_rates->'paye_bands';
  v_prev numeric := -1;
  v_upper numeric;
  v_n int;
  v_i int := 0;
begin
  if p_rates is null or v_bands is null or jsonb_typeof(v_bands) <> 'array'
     or jsonb_array_length(v_bands) = 0 then
    raise exception 'PAYROLL_SETTINGS_INVALID';
  end if;
  v_n := jsonb_array_length(v_bands);
  for v_band in select * from jsonb_array_elements(v_bands) loop
    v_i := v_i + 1;
    v_upper := (v_band->>'up_to')::numeric;
    if (v_band->>'rate') is null or (v_band->>'rate')::numeric < 0
       or (v_band->>'rate')::numeric > 1 then
      raise exception 'PAYROLL_SETTINGS_INVALID';
    end if;
    if v_i < v_n then                              -- only the LAST band may be open-ended
      if v_upper is null or v_upper <= v_prev then -- strictly ascending, finite
        raise exception 'PAYROLL_SETTINGS_INVALID';
      end if;
      v_prev := v_upper;
    elsif v_upper is not null then                 -- last band must be up_to = null
      raise exception 'PAYROLL_SETTINGS_INVALID';
    end if;
  end loop;
```
(declare `v_band jsonb` alongside the others.)

2. Same file, `app.compute_paye` (line ~166): make it fail loudly instead of under-taxing. After the loop, add
```sql
  if v_prev > 0 and p_income > v_prev then
    raise exception 'PAYROLL_BANDS_INVALID';
  end if;
```
before the `return` (the `exit` path leaves `v_prev` at the last consumed threshold; add a `v_done boolean := false` set to true just before `exit` if you prefer an explicit flag). Add `'PAYROLL_BANDS_INVALID'` to the `rpcError(error, [...])` allow-list on the run-payroll handler in apps/api/src/payroll/payroll.controller.ts and an EN+SW key in packages/i18n/src/index.ts.

3. apps/api/src/payroll/payroll.schema.ts:29-35 — mirror it so the operator gets a field-level error:
```ts
paye_bands: z.array(payeBandSchema).min(1).superRefine((bands, ctx) => {
  if (bands.at(-1)!.up_to !== null)
    ctx.addIssue({ code: 'custom', message: 'Last band must have up_to = null (open-ended top band)' });
  let prev = -1;
  bands.slice(0, -1).forEach((b, i) => {
    if (b.up_to === null || b.up_to <= prev)
      ctx.addIssue({ code: 'custom', path: [i, 'up_to'], message: 'Bands must ascend strictly; only the last may be null' });
    else prev = b.up_to;
  });
}),
```

Separately (out of scope for this finding but worth filing): the payroll settings dialog at apps/web/src/app/payroll/payroll-view.tsx:60-90 and 900-1000 uses `payeBands/{from}/nssfEmployee` while `GET /api/v1/payroll/settings` returns the raw snake_case jsonb (`paye_bands/{up_to}/nssf_employee_rate`) — the dialog crashes on `rates.payeBands.map` once a settings row exists and can never save. Either map in the controller's `getSettings`/`updateSettings` or fix the view's types.

---

### 101. 0025 drops and re-adds the live ledger's source_type CHECK as two separate autocommitted statements with no lock_timeout and no way to re-run

- **Location:** `supabase/migrations/00000000000025_payroll.sql:117`
- **Category:** data-integrity · **Verdict:** CONFIRMED (medium) · **Found by:** gap:migration application safety / disaster recovery (the human is about to apply 13 migrations by hand)

**What is wrong.** `alter table public.journal_entries drop constraint journal_entries_source_type_check;` (line 118) and the widened `add constraint` (line 120) are two independently committed statements against the live double-entry ledger. Both take ACCESS EXCLUSIVE on a hot table with no `lock_timeout` set anywhere in the batch, and 0025 cannot be re-run to repair the gap.

**How it fails.** The API and the workers' DB pollers are running against the live dev project (they must be — the post-apply checklist in CLAUDE.md starts the API immediately after). The `drop constraint` at line 118 needs ACCESS EXCLUSIVE on `journal_entries`; a drain-outbox poller or an in-flight `record_payment` holds a conflicting lock, so the ALTER queues and every subsequent read/write on journal_entries queues behind it — the whole finance module freezes. The operator, watching the app go down, Ctrl-Cs psql. If the drop had already acquired its lock and committed, the live ledger has PERMANENTLY lost `journal_entries_source_type_check` (0007:116 `source_type text not null check (source_type in ('invoice','payment','reversal'))`) and any future bug or manual insert can write `source_type='refund'`/typo/empty and the reporting RPCs that reconcile by source_type will silently mis-bucket real money. Recovery by re-running the loop is impossible: 0025 restarts at line 40 `create table public.staff_salaries`, which now already exists, ON_ERROR_STOP aborts, `|| break` fires, and the constraint is never restored. Nothing reports the missing constraint — no smoke test asserts its existence. The identical drop/add pair at 0026:218-222 removes `ai_proposed_actions_status_check`, which is what stops the AI propose->confirm->execute path from accepting an arbitrary status string.

**Evidence.**

```
00000000000025_payroll.sql:117-122
`alter table public.journal_entries`
`  drop constraint journal_entries_source_type_check;`
`alter table public.journal_entries`
`  add constraint journal_entries_source_type_check`
`  check (source_type in ('invoice','payment','reversal','payroll'));`

00000000000026_production_hardening.sql:218-222 (same shape)
`alter table public.ai_proposed_actions`
`  drop constraint ai_proposed_actions_status_check;`

No lock guard anywhere: `grep -rn -i 'lock_timeout|statement_timeout' supabase/migrations/*.sql` -> no matches.
```

**Fix.** Both files are unapplied, so edit them in place (no new migration needed; the additive-only rule is not violated because nothing has run yet).

1. supabase/migrations/00000000000025_payroll.sql — make the constraint swap atomic and re-runnable. Replace lines 117-121 with:

    begin;
    set local lock_timeout = '5s';
    alter table public.journal_entries
      drop constraint if exists journal_entries_source_type_check;
    alter table public.journal_entries
      add constraint journal_entries_source_type_check
      check (source_type in ('invoice','payment','reversal','payroll'));
    commit;

   (`set local` requires the surrounding transaction, hence the begin/commit. A blocked ALTER now aborts in 5s and rolls back with the constraint intact, instead of freezing finance and inviting an interrupt.)

2. supabase/migrations/00000000000026_production_hardening.sql — same treatment for lines 218-222: wrap in `begin; set local lock_timeout = '5s'; ... commit;` and change line 219 to `drop constraint if exists ai_proposed_actions_status_check;`.

3. Optional but cheap detection, since nothing currently asserts the constraint survives: append to 0025 a guard that fails the apply if the swap did not land —

    do $$ begin
      if not exists (select 1 from pg_constraint
                     where conname = 'journal_entries_source_type_check') then
        raise exception 'MIGRATION_0025_CONSTRAINT_MISSING';
      end if;
    end $$;

4. Also worth adding `if not exists` to the 4 `create table` statements in 0025 (lines 40, 57, and the two payroll_runs/payroll_items tables) so a partially-applied file can be re-run at all — that is the part that actually blocks recovery, independently of the constraint.

Do NOT rely on `psql --single-transaction` at the call site as the fix: it would be per-file and would silently change the semantics of every other migration in the batch. Put the transaction in the two files that need it.

---

### 102. accept_invitation grants a brand-new active membership to a suspended or archived school

- **Location:** `supabase/migrations/00000000000026_production_hardening.sql:186`
- **Category:** access-control · **Verdict:** CONFIRMED (high) · **Found by:** gap:tenant suspension / offboarding / data deletion (RLS layer never checks tenant status; no purge or export exists)

**What is wrong.** `app.accept_invitation` validates the token, the e-mail, expiry and the plan seat cap but never checks `public.tenants.status`, and the `POST /invitations/accept` route deliberately has no TenantGuard ("the caller is not a member yet"). Any invitation minted before suspension/archival — invitations live 14 days — can still be redeemed afterwards, creating a fresh `tenant_memberships` row with `status='active'` that immediately satisfies `app.is_tenant_member` and unlocks the whole dataset via RLS.

**How it fails.** On day 1 a school admin invites teacher@example.com; the invite expires on day 15 (invitations.controller.ts:104, `expires_at = now + 14d`). On day 3 the platform admin suspends the school for non-payment and on day 5 archives it. On day 10 the teacher clicks the emailed link. `POST /invitations/accept` runs with `@UseGuards(AuthGuard)` only (invitations.controller.ts:134-136), calls `accept_invitation`, which finds the pending non-expired invitation, passes the e-mail check and the seat cap, and inserts `tenant_memberships (…, 'active')` at 0026:186-190. The teacher — who has never had access to this school — can now open the web app and read every student, guardian phone number, invoice and journal line of a school that the operator believes is fully offboarded. The API returns `{ tenantId }` with no hint that the school is dead.

**Evidence.**

```
supabase/migrations/00000000000026_production_hardening.sql:141-190 — the only guards are
```sql
  select * into v_inv from public.invitations
  where token_hash = p_token_hash and status = 'pending' and expires_at > now();
  if v_inv.id is null then raise exception 'INVITE_INVALID_OR_EXPIRED'; end if;
  if lower(v_inv.email::text) <> lower(p_email) then raise exception 'INVITE_EMAIL_MISMATCH'; end if;
  …
  insert into public.tenant_memberships (tenant_id, user_id, status, campus_ids)
  values (v_inv.tenant_id, p_user_id, 'active', v_inv.campus_ids)
```
(no `select status from public.tenants where id = v_inv.tenant_id` anywhere in the function).
apps/api/src/invitations/invitations.controller.ts:133-136 —
```ts
  /** No TenantGuard: the caller is not a member yet. */
  @Post('accept')
  @UseGuards(AuthGuard)
```
apps/api/src/invitations/invitations.controller.ts:104 — `expires_at: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),`
```

**Fix.** Both 0026 and 0027 are still unapplied (the migration gate in CLAUDE.md), so patch in place — but the load-bearing edit is 0027, not 0026.

1. supabase/migrations/00000000000027_security_polish.sql, inside `app.accept_invitation` (immediately after the INVITE_EMAIL_MISMATCH check at ~line 133, so it covers the guardian/parent branch too), add:
```sql
  perform 1 from public.tenants
   where id = v_inv.tenant_id
     and status in ('configuration','data_review','training','live');
  if not found then
    raise exception 'INVITE_TENANT_NOT_ACTIVE';
  end if;
```
Deliberately excludes 'draft' as well as 'suspended'/'archived' — the valid set is from the 0001:41 check constraint and mirrors REACTIVATE_STATUSES in platform.controller.ts:26-31. Apply the same block to the 0026 copy only for consistency; it changes nothing on its own.

2. apps/api/src/invitations/invitations.controller.ts:145-152 — add a branch to the error map so the code is stable rather than being swallowed by the INVITE_INVALID_OR_EXPIRED default:
`else if (error.message.includes('TENANT_NOT_ACTIVE')) { code = 'INVITE_TENANT_NOT_ACTIVE'; }`
Add EN+SW keys for it in packages/i18n/src/index.ts (both key sets mirrored) and wire it into the invite-accept error map used by apps/web/src/app/invite/[token]/invite-accept.tsx.

3. apps/api/src/platform/platform.controller.ts — in both `suspend` (after line 297) and `archive` (after line 335), revoke outstanding invites in the same operation:
```ts
await this.supabase.admin.from('invitations')
  .update({ status: 'revoked' })
  .eq('tenant_id', id)
  .eq('status', 'pending');
```
('revoked' is already allowed by the 0001:230 check constraint.) This is defence in depth; the DB check in step 1 is the authoritative guard.

Optional, and the larger issue this finding is a symptom of — tracked separately, not part of this fix: `app.is_tenant_member` (0001:276-290) ignores tenant status, so every existing member of a suspended/archived tenant still reads students, guardian phones, invoices and journal lines straight through PostgREST while the API returns TENANT_SUSPENDED. Tightening it to `join public.tenants t on t.id = tm.tenant_id and t.status not in ('suspended','archived')` in a new additive migration 0029 would align RLS with the guard, but it changes read behaviour for every tenant table at once and needs its own smoke pass.

---

### 103. seed.sql's `pilot` plan uses the wrong limit keys, silently disabling student and staff-seat caps

- **Location:** `supabase/seed.sql:136`
- **Category:** entitlements · **Verdict:** CONFIRMED (high) · **Found by:** authz-permissions+rls-sql-security

**What is wrong.** app.tenant_entitlements passes plans.limits through untouched, and every enforcement site reads limits.students / limits.staff, but the seeded `pilot` plan declares maxStudents / smsPerMonth / storageGb instead — so a tenant on that plan gets `undefined` limits, every `usage + n > undefined` comparison evaluates false, and both the API pre-check and the DB backstop become no-ops.

**How it fails.** Platform staff move a school onto the pilot plan: POST /api/v1/platform/tenants/<id>/plan {planKey:'pilot', cycle:'monthly'} (the row is is_active by default — 00000000000001_control_plane.sql:96). tenant_entitlements now returns limits = {maxStudents:2500, smsPerMonth:5000, storageGb:20, aiMonthlyTokens:5000000}. A school_admin then imports 10,000 students: assertStudentCapacity evaluates `limits.students !== null` as true (undefined !== null) and then `usage.students + 10000 > undefined` → false, so the 2,500-student cap never fires. Identically, invitations.controller.ts:86 evaluates `usage.staff + pending + 1 > undefined` → false, and the DB backstop in migration 0026 reads `limits->>'staff'` → NULL → treated as unlimited. The school runs at 4x its paid tier with no error anywhere.

**Evidence.**

```
supabase/seed.sql:134-137
  insert into public.plans (key, name, description, limits) values
    ('pilot', 'Pilot', 'Pilot programme plan for early schools',
     '{"maxStudents": 2500, "smsPerMonth": 5000, "storageGb": 20, "aiMonthlyTokens": 5000000}')

vs the canonical shape in 00000000000013_platform.sql:16-23
  ('trial', 'Trial', '30-day evaluation', 0, 0,
   '{"students": 300, "staff": 20, "campuses": 1, "smsMonthly": 200}'),

app.tenant_entitlements (00000000000013_platform.sql) returns `'limits', v_limits` with v_limits := the plan's raw jsonb — no key mapping.

Enforcement sites that read the canonical keys:
  apps/api/src/students/students.controller.ts:70-77 — `if (limits.students !== null && usage.students + adding > limits.students)`
  apps/api/src/invitations/invitations.controller.ts:79-86 — `if (limits.staff !== null) { ... if (usage.staff + (pendingInvites ?? 0) + 1 > limits.staff) }`
  supabase/migrations/00000000000026_production_hardening.sql:172 — `v_staff_limit := (app.tenant_entitlements(v_inv.tenant_id)->'limits'->>'staff')::int;`
```

**Fix.** Two parts — the data fix repairs the current damage, the code fix prevents the class of bug.

1. Fix the seed row (`/Users/admin/Atlas-System/supabase/seed.sql:134-137`). Replace the limits literal with the canonical key set:
   `'{"students": 2500, "staff": 150, "campuses": 1, "smsMonthly": 5000, "aiMonthlyTokens": 5000000}'`
   Editing seed.sql alone is NOT sufficient — the insert ends in `on conflict (key) do nothing`, so it will never repair a row that already exists. Because migrations here are additive-only, add a new `supabase/migrations/00000000000029_pilot_plan_limits.sql` that rewrites it in place, guarded so operator overrides survive re-runs:
   `update public.plans set limits = jsonb_build_object('students', 2500, 'staff', 150, 'campuses', 1, 'smsMonthly', 5000, 'aiMonthlyTokens', coalesce((limits->>'aiMonthlyTokens')::bigint, 5000000)) where key = 'pilot' and not (limits ? 'students');`
   If the pilot plan is simply a leftover (the sales docs route founding schools to Msingi/Kati, never to Pilot), the even smaller containment is `update public.plans set is_active = false where key = 'pilot';` — `changePlan` filters on `is_active = true`, so that removes it from both the dropdown and the endpoint.

2. Fail closed on an unrecognised limits shape, in ONE place rather than the eight call sites. In `/Users/admin/Atlas-System/apps/api/src/tenancy/tenant.guard.ts`, replace the unchecked `const entitlements = entData as TenantEntitlements;` at line 103 with a zod parse:
   `const limitsSchema = z.object({ students: z.number().int().nullable(), staff: z.number().int().nullable(), campuses: z.number().int().nullable(), smsMonthly: z.number().int().nullable() });`
   applied to `entData.limits` (allow unknown extra keys such as `aiMonthlyTokens`), and on `!success` throw `InternalServerErrorException({ code: 'ENTITLEMENTS_MALFORMED' })`. A malformed plan document must break loudly at request time, never silently grant unlimited quota. This single change also covers `imports.controller.ts:436`, `students.controller.ts:73`, `invitations.controller.ts:79`, and `ai-actions.service.ts:1100/1109/1221/1238` without touching them, since all eight read `req.tenant.entitlements.limits`.

Optionally add a regression assertion in `apps/api/scripts/smoke-platform.mjs`: after `POST /platform/tenants/:id/plan`, assert every row returned by `GET /platform/plans` has all four canonical limit keys present.

---
