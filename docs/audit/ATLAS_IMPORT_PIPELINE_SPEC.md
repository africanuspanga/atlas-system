# ATLAS Import Pipeline Specification

_Audit date: 2026-07-05 · Status of current importer: **partial (students only)**_

## Current state

`app.import_students` + `/students/import` + the web Excel dialog exist and are
tested (`smoke-students.mjs`):

- Parses `.xlsx/.xls/.csv` client-side (SheetJS), maps `className`+`stream` to a
  section server-side, validates via zod, supports **dry-run**, and is
  **all-or-nothing** (any bad row aborts the batch).
- **AUD-001 fixed:** the RPC now rejects a `classSectionId` from another tenant.
- Guardian email captured; phone-deduped guardians backfilled.

### Gaps vs. a customer-grade migration
- **No staging tables** — rows go straight into production inside one RPC. Fine
  for a few hundred rows; wrong for a 2,400-row whole-school migration.
- **Single domain** — only students+guardians+enrolment. No importer for staff,
  subjects, historical results, historical payments/opening balances, etc.
- **No private upload storage, no import history, no downloadable error report**
  (errors are returned inline only).
- **No column-mapping UI** — headers are fixed to the template.
- **Runs in the request**, not a BullMQ worker — large files will time out.

## Target design (per CTO §8)

Per-domain import contracts (students, guardians, staff, classes, subjects,
teacher assignments, enrolments, fee structures, opening balances, historical
invoices, historical payments, historical results, attendance history). **Not**
one universal importer.

### Pipeline
`Upload → detect type → store privately → parse → map columns → validate →
dedupe → preview/dry-run → approve → queue → write to staging → commit →
summary → error report → history`.

### Storage
Private bucket, tenant-prefixed: `imports/{tenant_id}/{import_job_id}/original.xlsx`.
Never trust the original filename as an id. (No buckets exist yet — first one
must be tenant-scoped with a signed-URL download policy.)

### Staging tables (to add)
`import_jobs`, `import_files`, `import_column_mappings`, `import_staging_rows`,
`import_validation_errors`, `import_row_decisions`, `import_results`. Each
staging row: `tenant_id, import_job_id, row_number, raw_data, mapped_data,
validation_status, validation_errors, duplicate_status, final_record_id`.

### Parsing rules
Treat phone numbers and admission/student numbers as **strings** (preserve
leading zeros). Handle comma/semicolon/tab delimiters, UTF-8 + fallbacks,
trimmed/duplicate headers, numeric-stored-as-text, Excel date serials, multiple
sheets, formulas. Reject encrypted workbooks, macros, dangerous formulas.

### Execution
BullMQ workers, chunked, idempotent (re-running must not duplicate students or
payments — use natural keys / import_job dedupe), progress-reported, retry with
backoff, tenant context on every job, transaction boundaries per chunk.

### Financial imports (extra controls)
Never write opening balances as raw edits. Create opening-balance **invoices**
and **journal entries**, historical payment records, and adjustment entries,
each traceable `import_job → original row → ATLAS record → journal entry`. This
preserves the immutability + double-entry guarantees the finance module already
enforces (AUD-002).

## Recommendation

Before a real school migration: build the staging-table workflow + private
bucket + BullMQ execution for **students/guardians first** (upgrade the existing
importer), then add the financial importer with the invoice/journal-backed
opening-balance approach. AI may *suggest* column mappings but must never commit.
