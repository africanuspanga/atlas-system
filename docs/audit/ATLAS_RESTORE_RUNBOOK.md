# ATLAS Backup & Restore Runbook

_Restore test performed: **2026-07-08** (passed) · Closes release-readiness
item 17 for pilot scope. Repeat quarterly and after any migration touching
finance tables._

## Backup posture

- Supabase project `zwbsyiwtrabpysylyaaj` (Postgres 17, eu-west-3): daily
  automated backups on the current plan. **Ops step before pilot:** confirm
  the plan includes point-in-time recovery (PITR); if not, upgrade — RPO with
  daily backups alone is up to 24h, with PITR ≈ 2 min.
- Logical backup (this runbook) supplements Supabase's own backups and is the
  portable path (works to any Postgres, no vendor dependency).
- Storage buckets (`imports`, `reports`) hold regenerable artifacts (uploaded
  source files, generated reports); DB restore does not depend on them.

## Tested procedure (local restore — no Docker required)

```bash
brew install postgresql@17         # pg_dump/pg_restore must be >= server version
export PATH="/usr/local/opt/postgresql@17/bin:$PATH"

# 1. Dump application + identity schemas over the session pooler
pg_dump "$DATABASE_URL" --schema=public --schema=app --schema=auth \
  --schema=storage -Fc -f atlas-$(date +%Y%m%d).dump

# 2. Scratch cluster
initdb -D ./pgdata -U postgres --auth=trust -E UTF8 --locale=en_US.UTF-8
pg_ctl -D ./pgdata -o "-p 5544" -l pg.log start
createdb -p 5544 -h localhost -U postgres atlas_restore

# 3. Pre-create Supabase roles + extensions (dump references them)
for r in anon authenticated service_role authenticator supabase_admin \
         supabase_auth_admin supabase_storage_admin dashboard_user; do
  psql -p 5544 -h localhost -U postgres -d atlas_restore -c "create role $r nologin"
done
psql -p 5544 -h localhost -U postgres -d atlas_restore <<'SQL'
create schema extensions;
create extension citext;
create extension pgcrypto with schema extensions;
create extension "uuid-ossp" with schema extensions;
SQL

# 4. Restore (the single "schema public already exists" error is benign)
pg_restore --no-owner --no-privileges -h localhost -p 5544 -U postgres \
  -d atlas_restore atlas-YYYYMMDD.dump
```

## Validation gates (all must pass — 2026-07-08 results in parens)

| Check | Result |
|---|---|
| Object parity: tables / policies / RLS tables / app functions | 70 / 37 / 39 / 22 — identical to live |
| Row parity: tenants, auth.users, students, invoices, payments, journal_lines, audit_logs | all identical (38 / 92 / 344 / 266 / 328 / 1188 / 1135) |
| Every tenant ledger balances (Σdebit = Σcredit) | 0 unbalanced |
| Every journal entry balances individually | 0 unbalanced |
| FK orphans (journal→entries, payments→invoices, memberships→auth.users) | 0 / 0 / 0 |
| Cross-tenant integrity (no journal line under another tenant's entry) | 0 |
| Financial immutability triggers present **and fire** (UPDATE payment / DELETE journal line rejected) | 4 triggers, both mutations rejected |

## Cleanup (dumps contain real PII — never leave them around)

```bash
pg_ctl -D ./pgdata stop && rm -rf ./pgdata atlas-*.dump
```

## Cloud restore (staging/production replacement)

Same dump restores into a fresh Supabase project (`psql $NEW_DATABASE_URL` +
steps 3–4; roles/extensions already exist there, so step 3 is skipped and
`--clean` is added if the target has the schema). Then: run the validation
gates, point `SUPABASE_URL`/keys at the new project, and verify login with a
known account. Note: both free-tier project slots are currently occupied by
unrelated projects — a dedicated staging project needs a paid org or a freed
slot; the local path above is the tested fallback until then.

## Targets

- **RPO:** 24h with daily backups (2 min once PITR is confirmed).
- **RTO:** measured end-to-end locally ≈ 4 minutes for the current data volume
  (dump 1.0 MB); budget 1h for a cloud restore including DNS/env swaps.
