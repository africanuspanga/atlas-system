# ATLAS backup and restore runbook

_Updated 3 August 2026._

## Current evidence and gap

- A full logical restore was performed on 8 July 2026 at the then-current
  schema and passed object/row, ledger, orphan, and immutability checks.
- On 3 August 2026, a copy of existing live public data at the migration-15
  boundary successfully upgraded through the go-live hardening batch; all 75
  tenants, 422 students, and 356 payments survived. The complete schema chain
  through `0033` also passed from scratch.
- These prove upgrade compatibility, but they are **not a current full disaster
  recovery drill** for Auth, Storage, backups/PITR, DNS, secrets, and deployed
  applications together. A full migration-33 restore is required before pilot.

Do not assume the Supabase plan's backup/PITR entitlement. Confirm it in the
project dashboard, assign an owner, and record the actual retention/RPO.

## Handling rules

- Dumps contain student, guardian, finance, health, and identity data. Use an
  access-controlled encrypted location, never the repository or chat/email.
- Prefer a sanitized staging copy for routine migration testing.
- Record who created/accessed/destroyed each real-data dump and when.
- Verify the `pg_dump`/`pg_restore` major version is at least the server's.
- Never restore over the live project to “test” a backup. Use a new project or
  isolated local cluster.

## Logical backup

```bash
export PATH="/usr/local/opt/postgresql@17/bin:$PATH"
restore_workdir="$(mktemp -d /tmp/atlas-restore.XXXXXX)"
dump_path="$restore_workdir/atlas.dump"

pg_dump "$DATABASE_URL" \
  --schema=public --schema=app --schema=auth --schema=storage \
  --format=custom --file="$dump_path"
pg_restore --list "$dump_path" >/dev/null
```

Also capture, through the approved secret manager/operations record: Supabase
project settings, Auth provider/redirect settings, Storage bucket policies,
deployed environment-variable names (not plaintext secrets), DNS, Redis, Beem,
Sentry, Moonshot model/config, and release tag.

## Isolated local restore outline

Supabase-managed schemas depend on roles/extensions. The exact bootstrap used by
the schema rehearsal is in `scripts/shadow-migrations.sh`; use that as the
reference instead of copying an old role list from a dated audit.

```bash
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
initdb -D "$restore_workdir/data" -U postgres -E UTF8 --locale=en_US.UTF-8
pg_ctl -D "$restore_workdir/data" \
  -o "-p 5544 -k $restore_workdir" -l "$restore_workdir/postgres.log" start
createdb -h "$restore_workdir" -p 5544 -U postgres atlas_restore

# Bootstrap required Supabase roles/schemas/extensions, then:
pg_restore --no-owner --no-privileges \
  -h "$restore_workdir" -p 5544 -U postgres \
  -d atlas_restore "$dump_path"
```

A managed replacement project already supplies Supabase roles/extensions; use
the provider's documented restore path and test it in a separate project.

## Required validation

All must pass before calling the backup restorable:

1. Migration history ends at `0033`; expected application tables/functions/
   policies exist and no unintended RLS table has zero policies.
2. Row parity for tenants, Auth users, memberships, students, guardians,
   invoices, payments, journal entries/lines, payroll, audit logs, imports,
   reports, outbox, and AI audit/usage.
3. Every journal entry balances; every tenant ledger balances.
4. No cross-tenant or FK orphan among memberships, enrolments, guardians,
   finance, payroll, and jobs.
5. Immutability triggers reject payment/invoice/journal edits/deletes.
6. Parent/teacher/finance RLS attacks pass as non-superuser JWT roles.
7. Login, tenant switcher, one read-only report, signed Storage download,
   worker claims/heartbeats, and health endpoints work.
8. Secrets/DNS can be switched without putting service credentials in clients.
9. Measure dump time, restore time, application cutover time, and data loss
   window; compare them with the approved RTO/RPO.

Run `scripts/go-live-regression.sql` on the isolated target and confirm it
rolls back cleanly. Do not run the mutating smoke suite until the restored
environment is unmistakably isolated from customer integrations.

## Cleanup

Stop the scratch cluster, verify the target path is the task-specific temporary
directory, remove the temporary directory through the approved secure-disposal
procedure, and record disposal. Do not leave unencrypted dumps under `/tmp`.

## Schedule

- Verify automated backup/PITR status daily through monitoring.
- Perform and document a full restore before the first pilot, quarterly, after
  finance/Auth/Storage migration changes, and after changing backup plans.
- Treat an overdue/failed restore as a go-live blocker.
