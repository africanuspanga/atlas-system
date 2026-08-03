# ATLAS reporting and export — implemented scope

_Updated 3 August 2026 · introduced in migration `0012`._

## Architecture

`select report → permission/filter validation → durable report job → worker
claims → deterministic/reconciling RPC → format → private Storage object →
signed download → audit`.

The database is the source of figures. The worker formats results; the AI can
request/explain the same report but never calculates its financial totals.
Report jobs recover stale processing claims and retain failure codes.

## Current catalogue

| Report                          | Formats        | Extra permission       |
| ------------------------------- | -------------- | ---------------------- |
| Fee collection by period/method | PDF, CSV, XLSX | `finance.reports.view` |
| Outstanding fee balances        | PDF, CSV, XLSX | `finance.reports.view` |
| Trial balance                   | PDF, CSV, XLSX | `finance.reports.view` |
| Student fee statement           | PDF            | `finance.reports.view` |
| Student report card             | PDF            | `students.view`        |

Financial RPCs reconcile to the ledger and raise
`REPORT_RECONCILE_FAILED` rather than generate a misleading file. The trial
balance must have equal debits/credits and outstanding balances must tie to
accounts receivable.

## File safety

- CSV/XLSX output has stable columns, preserves identifiers as text, and
  neutralizes cells beginning with spreadsheet formula/control characters.
- PDF output is server-generated, A4/print-safe, titled with school/report
  metadata and page information.
- Files use tenant-prefixed private Storage paths and expiring signed links.
- Parameters and entity ids are tenant validated before job creation.
- Report jobs/files are not broadly member-readable; access goes through the
  guarded API.

## Verification

`smoke-reports.mjs` verifies catalogue/permissions, generation/download,
CSV formula safety, and refusal after a deliberately tampered reconciliation.
The 3 August full smoke pass included this suite.

## Remaining catalogue

Before broad product claims, add and test the needed student registers,
broadsheets/subject analysis, attendance trends, general ledger/income
statement/balance sheet/cash flow/budget/reconciliation, payroll statutory
reports, platform subscription invoices, and operational-module reports.
Every financial addition must reconcile and every large report must remain a
durable worker job.
