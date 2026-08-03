#!/usr/bin/env bash
#
# shadow-migrations.sh — apply the whole migration chain to a throwaway local
# Postgres 17 cluster and report the first failure.
#
# WHY THIS EXISTS
# The permission classifier blocks agents from writing DDL to the live dev
# Supabase project, and the live project is the only other place the chain has
# ever run. Without this, a migration's first real execution is against real
# school data. This gives every migration a rehearsal.
#
# It caught three genuine defects that would otherwise have shipped:
#   - 0029 failed midway and left student_guardians with RLS enabled and ZERO
#     policies (deny-all — presents to a school as "our data disappeared").
#     That is why 0029/0030 wrap themselves in an explicit transaction.
#   - 0029's platform_role trigger was SECURITY DEFINER, so current_user was
#     the function owner and the role check could never fire; the escalation it
#     existed to stop succeeded.
#   - 0030 added an index byte-identical to one from 0004 (create index IF NOT
#     EXISTS matches on NAME, not columns, so it was not suppressed).
#
# USAGE
#   ./scripts/shadow-migrations.sh              # apply 0001..NNNN, then seed
#   ./scripts/shadow-migrations.sh --keep       # leave the cluster running
#   ./scripts/shadow-migrations.sh --psql       # apply, then open a psql shell
#
# NOTES / THINGS THAT BITE
#   - macOS needs LC_ALL=en_US.UTF-8 for pg_ctl, or initdb's postmaster dies
#     with "postmaster became multithreaded".
#   - The unix socket path has a hard 103-byte limit, which the session
#     scratchpad path blows straight through. Data dir and socket dir are
#     therefore kept separate: data under ./.shadow, socket under /tmp/atsh.
#   - A schema-only shadow cannot catch data-dependent problems (a backfill
#     that behaves differently against real rows, a constraint that existing
#     data violates). It proves the DDL applies and the logic is sound; it does
#     not replace testing against a restore. See ATLAS_RESTORE_RUNBOOK.md.

set -euo pipefail

PGBIN="${PGBIN:-/usr/local/opt/postgresql@17/bin}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$REPO/.shadow/data"
SOCK="/tmp/atsh"
PORT="${SHADOW_PORT:-55432}"
DB=atlas_shadow
MAX_VERSION="${SHADOW_MAX_VERSION:-}"
SKIP_SEED="${SHADOW_SKIP_SEED:-0}"

KEEP=0
OPEN_PSQL=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --psql) OPEN_PSQL=1; KEEP=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8

if [ ! -x "$PGBIN/initdb" ]; then
  echo "postgres 17 not found at $PGBIN — set PGBIN=/path/to/pg/bin" >&2
  exit 1
fi

cleanup() {
  if [ "$KEEP" -eq 0 ]; then
    "$PGBIN/pg_ctl" -D "$DATA" stop -m fast >/dev/null 2>&1 || true
    rm -rf "$REPO/.shadow" "$SOCK"
  fi
}
trap cleanup EXIT

echo "==> initialising scratch cluster"
rm -rf "$REPO/.shadow" "$SOCK"
mkdir -p "$REPO/.shadow" "$SOCK"
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=en_US.UTF-8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" \
  -o "-p $PORT -k $SOCK -c listen_addresses=''" \
  -l "$REPO/.shadow/log" start >/dev/null
for _ in $(seq 1 20); do
  "$PGBIN/pg_isready" -h "$SOCK" -p "$PORT" >/dev/null 2>&1 && break
  sleep 0.5
done

psql_() { "$PGBIN/psql" -h "$SOCK" -p "$PORT" -U postgres "$@"; }

psql_ -q -c "create database $DB;" >/dev/null

echo "==> bootstrapping the Supabase-shaped prerequisites the migrations assume"
# Supabase provides these; a bare Postgres does not. Keep this minimal and
# honest — every stub here is a thing the shadow does NOT verify.
psql_ -d "$DB" -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create extension if not exists pgcrypto;
create schema auth;
create schema app;
create schema storage;

do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon')
    then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated')
    then create role authenticated nologin; end if;
  -- bypassrls mirrors the service-role key the API uses
  if not exists (select 1 from pg_roles where rolname='service_role')
    then create role service_role nologin bypassrls; end if;
end $$;

grant usage on schema public, auth to anon, authenticated, service_role;
-- Supabase's default grant. 0026 deliberately narrows it for public.profiles;
-- without this line that migration would have nothing to revoke.
alter default privileges in schema public grant all on tables
  to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  phone text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The real auth.uid() reads the request JWT. This stub reads a GUC so tests can
-- impersonate: begin; set local request.jwt.claim.sub='<uuid>'; set local role
-- authenticated; ... commit;   (SET LOCAL outside a transaction is a no-op, and
-- as `postgres` you are superuser and bypass RLS entirely — both mistakes make
-- an RLS test silently pass.)
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

create table storage.buckets (
  id text primary key, name text not null,
  public boolean not null default false,
  created_at timestamptz not null default now()
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text, owner uuid,
  created_at timestamptz not null default now()
);
SQL

echo "==> applying migrations"
failed=""
for f in "$REPO"/supabase/migrations/*.sql; do
  name="$(basename "$f")"
  version="${name%%_*}"
  if [ -n "$MAX_VERSION" ] && [ "$version" -gt "$MAX_VERSION" ]; then
    break
  fi
  if out="$(psql_ -d "$DB" -v ON_ERROR_STOP=1 -q -f "$f" 2>&1)"; then
    notices="$(printf '%s' "$out" | grep -i 'NOTICE' || true)"
    printf '  ok   %s\n' "$name"
    [ -n "$notices" ] && printf '%s\n' "$notices" | sed 's/^/         /'
  else
    printf '  FAIL %s\n' "$name"
    printf '%s\n' "$out" | grep -E 'ERROR|DETAIL|HINT' | head -6 | sed 's/^/         /'
    failed="$name"
    break
  fi
done

if [ -n "$failed" ]; then
  echo
  echo "==> FAILED at $failed"
  exit 1
fi

if [ "$SKIP_SEED" -eq 0 ]; then
  echo "==> applying seed.sql"
  psql_ -d "$DB" -q -v ON_ERROR_STOP=1 -f "$REPO/supabase/seed.sql" >/dev/null
  echo "==> seed OK"
else
  echo "==> seed skipped (SHADOW_SKIP_SEED=1)"
fi

echo
echo "==> summary"
psql_ -d "$DB" -tAc "
  select '    tables:    ' || count(*) from information_schema.tables
   where table_schema='public' and table_type='BASE TABLE';"
psql_ -d "$DB" -tAc "
  select '    policies:  ' || count(*) from pg_policy;"
psql_ -d "$DB" -tAc "
  select '    functions: ' || count(*) from pg_proc p
   join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('app','public');"

# RLS enabled but zero policies == deny-all for end users. That is almost always
# a half-applied migration rather than an intentional API-only table, so name
# them explicitly. Known-intentional ones (0027 dropped these to API-only reads)
# are excluded so the list stays actionable.
echo
echo "==> tables with RLS enabled and NO policy (deny-all — check each is intentional)"
psql_ -d "$DB" -tAc "
  select '    ' || c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_policy p on p.polrelid = c.oid
  where n.nspname = 'public' and c.relrowsecurity
    and c.relname not in (
      -- 0027 dropped these to API-only reads
      'ai_tool_calls','ai_usage_records','clinic_visits',
      -- deny-all RLS by design (0028), API-only via POST/DELETE /devices
      'device_tokens',
      -- never exposed to end users (0001)
      'subscriptions','invitations','audit_logs','tenant_counters',
      -- platform-staff only, read through the service role
      'platform_audit_logs',
      -- salary data is API-only on purpose (payroll.view); the AI payroll
      -- tool returns aggregates only. See CLAUDE.md.
      'payroll_items','payroll_runs','payroll_settings','staff_salaries')
  group by c.relname having count(p.polname) = 0
  order by 1;" | grep . || echo "    (none)"

echo
echo "==> shadow OK — all migrations applied cleanly"

if [ "$OPEN_PSQL" -eq 1 ]; then
  echo "==> opening psql (\\q to exit; cluster stays up)"
  psql_ -d "$DB"
fi

if [ "$KEEP" -eq 1 ]; then
  cat <<EOF

Cluster left running:
  $PGBIN/psql -h $SOCK -p $PORT -U postgres -d $DB
Stop it with:
  $PGBIN/pg_ctl -D $DATA stop -m fast && rm -rf $REPO/.shadow $SOCK
EOF
fi
