# Sourced by the HQ snapshot and restore workflows: points psql/pg_dump/pg_restore
# at HQ's database (DigitalOcean cluster products-hq-db) as the database user that
# owns HQ's tables. HQ keeps them in its own "app" schema (src/db/index.ts), which
# the cluster's admin user can't read, so the owner's login is fetched from the
# DigitalOcean API. Passwords are masked in the log and never printed.
# Needs DO_TOKEN. Sets PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE, PGOPTIONS, HQ_PG_VERSION.
set -euo pipefail
curl -sf -H "Authorization: Bearer $DO_TOKEN" "https://api.digitalocean.com/v2/databases" \
  | jq -e '.databases[] | select(.name == "products-hq-db")' > cluster.json \
  || { echo "No products-hq-db cluster on DigitalOcean (run the Deploy workflow first)."; exit 1; }
echo "::add-mask::$(jq -r .connection.password cluster.json)"
echo "Cluster products-hq-db: Postgres $(jq -r .version cluster.json), $(jq -r .status cluster.json)"
[ "$(jq -r .status cluster.json)" = online ] || { echo "The database isn't online yet; try again in a few minutes."; exit 1; }
HQ_CLUSTER_ID=$(jq -r .id cluster.json)
export HQ_PG_VERSION=$(jq -r .version cluster.json)
export PGHOST=$(jq -r .connection.host cluster.json)
export PGPORT=$(jq -r .connection.port cluster.json)
export PGUSER=$(jq -r .connection.user cluster.json)
export PGPASSWORD=$(jq -r .connection.password cluster.json)
export PGDATABASE=$(jq -r .connection.database cluster.json)
export PGSSLMODE=require
rm -f cluster.json

owner=$(psql -Atc "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'app'")
if [ -z "$owner" ]; then
  echo "HQ's tables aren't in $PGDATABASE (no app schema). What is there:"
  echo "  schemas: $(psql -Atc "SELECT string_agg(nspname || ' (' || pg_get_userbyid(nspowner) || ')', ', ') FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema'")"
  echo "  connected as: $(psql -Atc "SELECT current_user || ' to ' || current_database() || ', server ' || version()")"
  echo "  tables per schema: $(psql -Atc "SELECT string_agg(schemaname || '=' || n, ', ') FROM (SELECT schemaname, count(*) n FROM pg_tables GROUP BY 1) t")"
  echo "  other connections: $(psql -Atc "SELECT string_agg(coalesce(usename,'?') || '@' || coalesce(datname,'?') || ' ' || coalesce(application_name,'') || ' ' || coalesce(state,''), '; ') FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'")"
  echo "  schema_migrations tables: $(psql -Atc "SELECT string_agg(n.nspname, ', ') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'schema_migrations'")"
  echo "  databases (DO API): $(curl -sf -H "Authorization: Bearer $DO_TOKEN" "https://api.digitalocean.com/v2/databases/$HQ_CLUSTER_ID/dbs" | jq -r '[.dbs[].name] | join(", ")')"
  echo "  users (DO API): $(curl -sf -H "Authorization: Bearer $DO_TOKEN" "https://api.digitalocean.com/v2/databases/$HQ_CLUSTER_ID/users" | jq -r '[.users[].name] | join(", ")')"
  echo "  app's database settings (DO API): $(curl -sf -H "Authorization: Bearer $DO_TOKEN" "https://api.digitalocean.com/v2/apps?per_page=200" | jq -c '.apps[] | select(.spec.name == "products-hq") | .spec.databases')"
  echo "  app's database env names: $(curl -sf -H "Authorization: Bearer $DO_TOKEN" "https://api.digitalocean.com/v2/apps?per_page=200" | jq -r '.apps[] | select(.spec.name == "products-hq") | [.spec.services[0].envs[] | select(.key | test("DATABASE")) | .key + "=" + (if .type == "SECRET" then "(secret)" else (.value // "") end)] | join(", ")' | sed 's#://[^@ ]*@#://(hidden)@#g')"
  echo "Let HQ start once first, or check the above."
  exit 1
fi
echo "HQ's tables belong to database user $owner."
if [ "$owner" != "$PGUSER" ]; then
  curl -sf -H "Authorization: Bearer $DO_TOKEN" "https://api.digitalocean.com/v2/databases/$HQ_CLUSTER_ID/users/$owner" > dbuser.json
  pw=$(jq -r '.user.password // empty' dbuser.json)
  rm -f dbuser.json
  [ -n "$pw" ] || { echo "DigitalOcean didn't give the password for $owner."; exit 1; }
  echo "::add-mask::$pw"
  export PGUSER="$owner" PGPASSWORD="$pw"
fi
export PGOPTIONS='-c search_path=app,public'
psql -Atc "SELECT 1 FROM settings LIMIT 1" > /dev/null
echo "Connected to HQ's tables."
