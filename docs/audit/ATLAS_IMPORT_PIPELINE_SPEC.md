# ATLAS import pipeline — implemented scope

_Updated 3 August 2026 · introduced in migration `0011` and hardened later._

## Current workflow

`upload → private storage → detect/map → dry run → validation/deduplication →
human approval → durable job claim → staged commit → summary/error report`.

The current `/imports` workflow supports:

- students, guardians, class enrolments;
- finance opening balances posted as invoices and balanced journal entries;
- CSV/XLSX parsing with English/Swahili column mapping;
- private tenant-prefixed source/error files and signed downloads;
- bounded file/row validation, formula/macro/workbook safety checks;
- exact string handling for phone/student numbers and leading zeros;
- chunked, resumable DB-backed jobs with BullMQ kick/poll fallback;
- idempotent commits and paginated validation/error handling;
- audit/history from import job and original row to resulting records.

`smoke-imports.mjs` verifies dry run, approval, commit, financial
reconciliation, error output, and idempotent rerun.

## Controls

- Import jobs and every staging/result row carry `tenant_id`.
- The API resolves section/year/entity ownership; source ids cannot select
  another tenant.
- A malformed row never weakens finance or RLS constraints.
- Opening balances are not raw balance edits; they create traceable financial
  documents and journals.
- A worker claim is conditional and recoverable. Redis is only a kick; job-table
  state is authoritative.
- Imported financial history uses Tanzania dates and must reconcile before
  school acceptance.

## Pilot procedure

Use staging first. Save mappings, compare ATLAS totals with the school's source,
resolve every rejected/duplicate row, and obtain head-teacher plus bursar
signatures using `ATLAS_PILOT_RUNBOOK.md`. Reuse the signed files/mappings in
production and abort on any summary difference.

## Remaining domains

Dedicated import contracts are still needed for staff, subjects/teacher
assignments, historical results, historical attendance, hostel/transport/
library/inventory, and richer historical payment/provider data. Do not create a
single permissive universal importer. Each new domain requires its own schema,
permission, dedupe key, dry-run behavior, audit mapping, and smoke test.

AI may propose mappings or explain validation errors; it may not approve or
commit an import.
