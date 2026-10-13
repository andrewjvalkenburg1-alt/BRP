#!/usr/bin/env bash
# Run the migrations, seed, RLS tests, agent tests and HQ tests on a local Postgres 15+ (no Supabase needed).
# Usage: test/run-local.sh [database name]   (needs createdb/psql on PATH and a superuser connection)
set -euo pipefail
DB="${1:-brptest}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SEED="$HERE/../supabase/seed"
dropdb --if-exists "$DB"; createdb "$DB"
for f in "$HERE/supabase-shim.sql" "$HERE"/../supabase/migrations/*.sql "$SEED/seed.sql" "$HERE/rls-test.sql" "$HERE/agents-test.sql" \
         "$SEED/hq-seed.sql" "$SEED/hq-seed-data.sql" "$HERE/hq-test.sql"; do
  echo "== $(basename "$f")"
  psql -q -X -v ON_ERROR_STOP=1 -d "$DB" -f "$f"
done
