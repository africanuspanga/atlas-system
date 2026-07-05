# ATLAS Reporting & Export Specification

_Audit date: 2026-07-05 · Status: **NOT BUILT** (only the report-card screen exists)_

## Finding

There is no central reporting/export system and **no PDF/CSV/XLSX download**
anywhere. The only "report" is the on-screen report card (`/students/[id]/
report-card`), which uses the browser print dialog. The CTO letter requires a
central `ReportingModule` producing PDF, CSV, XLSX, printable HTML, and
authorised JSON.

## Principles

- **Deterministic services calculate all numbers.** The AI may request and
  explain a report, but never computes its figures.
- Financial reports must reconcile to the ledger:
  `fees = invoices + debit notes − credit notes − allocations − adjustments`,
  and statements must tie to the double-entry journal (already immutable, AUD-002).
- Large reports run in **BullMQ workers**, not request handlers.

## Architecture

`ReportingModule` with a job model:
`select report → check permission → validate filters → create job → worker
fetches data → validate totals → generate file → store privately → signed
download link → notify → record download`. States: `queued, processing,
completed, failed, cancelled, expired`.

Every file carries: school, campus, title, academic year, term, filters, date
range, generated-by, generated-at, page numbers (PDF), unique report reference,
confidentiality label.

## Formats

### CSV (injection-safe)
UTF-8 with BOM, quoted values, stable column order, documented date format,
phone/admission numbers as text. **Escape formula injection** — prefix any cell
starting with `= + - @` (and tab/CR) with a `'`. This is a hard requirement.

### PDF
A4, school logo, header/footer, page numbers, consistent typography, repeated
table headers across page breaks, currency formatting (TZS), EN + SW templates,
print-safe, no cut-off. Suggested: a server-side HTML→PDF renderer in a worker.

### XLSX
Typed cells, frozen header, stable columns.

## Initial report catalogue

- **Platform:** active schools, trial conversion, subscription revenue, failed
  payments, usage/storage/SMS/AI by tenant, onboarding completion, job failures.
  (Depends on the unbuilt platform layer.)
- **Student:** register, profile, admission list, class list, guardian contacts,
  transfers, withdrawals. (Data all present.)
- **Academic:** report cards (exists on-screen — port to PDF first), broadsheet,
  subject analysis, grade distribution, mark-entry progress, promotion,
  curriculum coverage, teacher workload. (Assessment data present.)
- **Attendance:** daily, monthly, chronic absenteeism, late arrivals, staff
  attendance, class comparison. (Attendance data present.)
- **Finance:** student statement, invoice, receipt, collection report,
  outstanding balances, receivables ageing, collection by channel/class,
  unallocated payments, discounts, trial balance (exists on-screen), general
  ledger, income statement, balance sheet, cash-flow, budget vs actual, bank
  reconciliation. (Ledger data present and immutable.)

## Recommended first slice

1. `ReportingModule` + job table + private bucket + signed downloads.
2. **Report-card PDF** (highest demo value; data + layout already exist).
3. **Fee collection + outstanding CSV/XLSX** with injection-safe escaping.
4. **Trial balance + student statement PDF** reconciled to the journal.
Wire the AI's `generateReport` tool to these same services so figures reconcile.
