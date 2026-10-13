# BRP One backend

Server-side accounts, roles and data for BRP One, plus an admin console. It runs on **Supabase**: Postgres with row-level security, Auth and Edge Functions. Everything in it is sample data. Nothing in it happened.

The choice of Supabase can be reversed. The schema is plain Postgres. Only two things are Supabase-specific: `profiles.id` points at `auth.users`, and the user id comes from `auth.uid()`, which is read in one helper (`brp.uid()`).

> **Not for Army data.** This demo backend is not accredited for anything. Production with real Soldier, installation or contract data needs a FedRAMP or DoD IL4/IL5 environment, such as AWS GovCloud (US) or Azure Government, and an ATO. See [Production path](#production-path-govcloud).

## What Andrew does (about 10 minutes)

1. **Create the project.**
   - Sign up at [supabase.com](https://supabase.com), then select **New project**.
   - Name it `brp-one` and choose the region **East US (North Virginia)**.
   - Set a strong database password. Save it in your password manager.
   - The free plan is fine.
2. **Turn off public sign-up.** Go to **Authentication > Sign In / Providers** and switch off **Allow new users to sign up**. Leave the Email provider on.
3. **Paste two values into one file.**
   - In Supabase, go to **Project Settings > API** (or **Data API**). Copy the **Project URL** and the **anon public** key. If the project shows the newer keys, the publishable key `sb_publishable_...` is also fine.
   - Paste both into `backend/client/brp-config.js`:
     ```js
     window.BRP_BACKEND_CONFIG = { url: 'https://<ref>.supabase.co', anonKey: '<anon key>' };
     ```
   - The anon key is public by design and safe to commit.
   - Never paste the `service_role` key or an `sb_secret_...` key anywhere in this repo. The adapter refuses to start with one.
4. **Give Claude one of these, privately.** Do not use a public channel, and revoke it when the setup is done.
   - **Best:** a personal access token from **Account > Access Tokens**, plus the project ref (the `<ref>` in the URL). Claude can then run the migrations, load the seed and deploy both Edge Functions.
   - **Or:** the database password. That is enough for the migrations and the seed. The Edge Functions then wait for a token. Until they are deployed, the client falls back to the database functions, so alerts still fan out to the outbox and the admin reset still works.

That is all. The nine demo accounts exist after the seed. Each signs in with password `BRPdemo2026!`.

### What Claude runs

The CLI comes from npm. Nothing is installed globally.

```bash
cd backend
export SUPABASE_ACCESS_TOKEN=<token>                            # option A
npx -y supabase@2.118.0 link --project-ref <ref> -p '<db password>'
npx -y supabase@2.118.0 db push --include-seed                  # 4 migrations + seed
npx -y supabase@2.118.0 functions deploy notify admin-reset

# option B, database password only (the URI is under Project Settings > Database > Connection string, session pooler)
npx -y supabase@2.118.0 db push --include-seed \
  --db-url 'postgresql://postgres.<ref>:<db password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres'
```

- **If the seed warns that it could not write `auth.users`:** run `SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node supabase/seed/create-demo-users.mjs` with the key set only in the shell, then run the seed again with `psql "<db url>" -f supabase/seed/seed.sql`.
- **To rebuild the seed** after the sample files change: `node supabase/seed/build-seed.mjs /mnt/project-files/barracks/v1`. This rewrites both `supabase/seed/seed.sql` and `client/demo-data.js`.

## Using it

- **Admin console:** `backend/client/admin.html`.
  - Once pushed, GitHub Pages serves it at `https://<user>.github.io/<repo>/backend/client/admin.html`.
  - With `brp-config.js` empty, it runs in a clearly labeled **local demo mode**. That mode uses sample data in the browser and the same demo accounts, so it can be shown today with no server.
  - Only an Admin gets in. Every other role sees a refusal that names the account's role.
- **Apps:** load the config and adapter after the app's own scripts:
  ```html
  <script src="backend/client/brp-config.js"></script>
  <script src="backend/client/brp-backend.js"></script>
  ```
  When `BRPBackend.configured()` is false, every method resolves `null` and the app keeps its local demo mode.

## Files

| Path | What it is |
|---|---|
| `supabase/migrations/20261013000100_brp_schema.sql` | Tables, sequences, the `brp_role` domain, settings, and `brp_seed.*` snapshot tables |
| `supabase/migrations/20261013000200_brp_rls.sql` | Role helpers, row-level security on every table, grants (anon gets nothing) |
| `supabase/migrations/20261013000300_brp_functions.sql` | Triggers, audit log, and the RPCs: `whoami`, `raise_alert`, `mark_alert_read`, `register_push_token`, `unregister_push_token`, `admin_set_role`, `admin_reset_demo` |
| `supabase/migrations/20261014000100_brp_agents.sql` | Operations agents in shadow mode: `agent_runs`, `agent_proposals`, `agent_settings`, the `brp_agent` role (reads ops tables, inserts proposals only), `buyer_weekly_cap` and `buyer_spend_check`, and the admin RPCs `agent_proposal_decide` and `admin_set_agent_mode` |
| `supabase/seed/build-seed.mjs` | Builds the seed from `brp-data.js`, the ERP and satisfaction sample files and `parts-catalog.json` |
| `supabase/seed/seed.sql` | Generated. Loads `brp_seed.*`, creates the 9 demo accounts, copies everything live |
| `supabase/seed/create-demo-users.mjs` | Fallback that creates the demo accounts through the Auth Admin API |
| `supabase/functions/notify` | Alert fan-out, outbox, email (off by default), push through APNs or FCM when keys are set |
| `supabase/functions/admin-reset` | Admin-only demo reset. Also puts the demo accounts back on the demo password |
| `supabase/functions/agent-mcp` | MCP server the Managed Agents call. Bearer token per agent; each call runs as `brp_agent` with fixed SQL |
| `agents/` | Agent definitions, `deploy.mjs` (with `--dry-run`), the reply checker, tests, and the runbook `agents/AGENTS.md` |
| `supabase/config.toml` | CLI config. Seed path, sign-up off for local stacks, JWT required on functions |
| `client/brp-config.js` | The one file Andrew edits (URL and anon key) |
| `client/brp-backend.js` | `window.BRPBackend` adapter. Loads supabase-js 2.45.4 from jsDelivr |
| `client/admin.html` | Admin console, brand Package A (Bone and Ink, Signal Orange) |
| `client/demo-data.js` | Generated sample rows for the console's local demo mode |
| `test/` | Local Postgres shim, RLS test suite, runner |

## Schema

| Table | Rows in seed | Notes |
|---|---:|---|
| `profiles` | 9 demo | One per `auth.users` row. Holds role, installation (`inst`, null means all), home room, `active`, `demo` and alert preferences |
| `installations` | 20 | STW, BRG and BLS are the pilots (`pilot`). The other 17 are commander dashboard benchmarks |
| `buildings` | 18 | Setup and intake model: floors, rooms per floor, numbering scheme, sensor pod |
| `rooms` | 141 | Fort Stewart 412, 305 and 118 in full (with the Bldg 412 sensors), plus every room a work order names. Status is ok, watch, action or offline |
| `work_orders` | 53 | Back office, field tablet, dashboard and agent simulation orders. Status, step, source, origin, DoD due time, tech and Soldier links |
| `wo_events` | 106 | History lines |
| `vendors` | 7 | |
| `catalog_items` | 73 | The cited research catalog. Sources, price basis and its label, as-of date, NSN only where a public page shows one. Internal design documents are cited by title only, because the repo is public |
| `parts` | 55 | Sample SKUs, linked to `catalog_items` where it is the same item. The BRP-RS1 family is flagged design only |
| `cabinets`, `stock` | 4, 135 | One row per cabinet and SKU, with reorder point and reorder quantity |
| `purchase_orders`, `po_lines` | 26, 48 | Work order and replenishment POs |
| `purchase_list` | 32 | Open requisitions, technician part requests, and items under their reorder point. Also stores rows from the purchasing module (`id`, `status`, `note`, `po_id`, `updated_by`). Admin only |
| `satisfaction` | 1,211 | Anonymous answers store no name or account id |
| `alerts`, `alert_recipients`, `email_outbox` | 3, 9, 9 | Fan-out. Every outbox row is `logged`, which means it was not sent |
| `push_tokens` | 0 | APNs or FCM tokens for the native app. A token belongs to whoever registered it last |
| `audit_log` | | Written by triggers only |
| `settings` | 3 | `email_delivery` (off), `demo_mode` (on), `demo_clock` |

Times follow the demo clock: Oct 7, 2026, 8:00 AM Eastern. `BRPBackend.now()` runs from there.

## Row-level security

- Every table has RLS on. The anon key can read nothing.
- A signed-in person's access comes from their `profiles` row:
  - **Scope.** Admin sees every installation. Any other staff role with `inst` null sees every installation. A staff role with `inst` set sees that installation only.
  - **Soldier.** A Soldier never sees all installations. They see only their own requests, home room and named answers.
  - **Inactive profile.** It has no role and sees nothing. New sign-ups are inactive until an Admin sets a role.
- Policies call small `security definer` helpers (`brp.my_role()`, `brp.my_inst()`, `brp.sees_all()`) inside `(select ...)`, so each runs once per query.

| Role (demo account, scope) | Reads | Writes |
|---|---|---|
| Soldier (`soldier@`, STW, home 412 Rm 1K) | Own work orders and their history, own home room, own named answers | New request in own installation (forced to source Soldier, status open), own answers |
| Technician (`tech@`, STW) | Own assigned work orders and their POs, rooms, stock, parts | Own work orders: status, step, parts, notes. Not priority, installation or assignment. Stock in scope |
| Barracks manager (`manager@`, STW) | Work orders, rooms, POs, stock, satisfaction in scope | Work orders, buildings and rooms in scope, notes, satisfaction |
| Site lead (`sitelead@`, STW) | As manager, plus alerts and email outbox in scope | Work orders, rooms, POs, stock, parts, cabinets in scope |
| Program manager (`pm@`, all) | Everything except the audit log and the purchase list | Work orders, rooms, POs, stock, parts, vendors, installations |
| Buyer (`buyer@`, all) | Work orders (read), POs, stock, parts, vendors | POs and lines, stock, parts, vendors |
| Government COR (`cor@`, all) | Work orders, POs, stock, satisfaction, audit log | Nothing (read-only) |
| Garrison commander (`commander@`, all) | Work orders, rooms, POs, stock, satisfaction | Nothing (read-only) |
| Admin (`admin@`, all) | Everything | Everything, through the policies and the admin functions |

Server-enforced rules beyond the table above:

- **Role changes.** Role, installation and active status change only through `admin_set_role`. A trigger refuses a direct update, even from an Admin. Every change is audited as `role.change`.
- **Lockout guards.** No one can remove their own admin access, and the last active Admin cannot be demoted.
- **Demo admin limits.** The `admin@brp.demo` password is published, so that account can change demo accounts only. It cannot change settings, so it can never turn email on.
- **Alerts.** Alerts are written only by `raise_alert`. Only people with an active BRP profile can be tagged. An unknown email address is ignored, so an alert can never mail a stranger. A person can raise alerts only for an installation in their scope.
- **Demo reset.** `admin_reset_demo` is Admin only, and it is refused once `settings.demo_mode.enabled` is false.

## Alerts, email and push

- **Fan-out.** `raise_alert` stores the alert and adds the tagged people. It then adds the site lead and barracks manager for the installation, the assigned technician, and on critical alerts the program manager. It writes one `email_outbox` row per person with status `logged`.
- **Email has two switches, both off.** The `notify` function sends mail only when both are on:
  1. The `EMAIL_PROVIDER` secret is `resend` or `postmark`, with its key and `EMAIL_FROM` set.
  2. `settings.email_delivery.enabled` is true. Only an Admin who is not a demo account can change it.
- **Blocked addresses.** Addresses at `brp.demo`, `example.com` and `example.org` (`EMAIL_BLOCK_DOMAINS`) are never mailed. Their rows become `suppressed`.
- **The demo never emails anyone.**
- **Push.**
  - iOS needs `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID` and `APNS_BUNDLE_ID`. Android needs `FCM_SERVICE_ACCOUNT_JSON`.
  - Each recipient's `push_status` records `sent`, `failed`, `no_token`, `off` or `not_configured`.
  - When Apple or Google reports a dead token, the token is disabled.
- **Native app integration.** After sign-in, call `BRPBackend.registerPushToken(token, 'ios' | 'android', 'sandbox' | 'production', deviceName, appVersion)`. On sign-out, call `unregisterPushToken(token)`.
- **Setting secrets.** Use `npx supabase@2.118.0 secrets set NAME=value`. Never put secrets in a file in this repo.

## Cost

Figures are from Supabase's public pricing at the time of writing. Check supabase.com/pricing before relying on them.

- **Free plan, $0.** 500 MB database, 50,000 monthly active users and 500,000 Edge Function calls. The demo data is a few megabytes. A free project pauses after a week with no activity; restart it from the dashboard.
- **Pro, about $25 a month.** No pausing, daily backups and more headroom. This is worth it once people outside the team rely on the demo.
- **Email.** Resend and Postmark both have small free tiers. Email stays off until there is a reason to send.
- **Push.** APNs is free with the Apple Developer Program ($99 a year, which the native app already needs). FCM is free.

## Production path (GovCloud)

Supabase is a commercial cloud service. Nothing here claims it meets FedRAMP, DoD IL4/IL5, CMMC or any Army requirement. For real data:

- **Database.** Run the same schema on Amazon RDS or Aurora for PostgreSQL in AWS GovCloud (US). Azure Database for PostgreSQL in Azure Government is the alternative. The migrations are plain Postgres. Replace `auth.users` with a local users table and have `brp.uid()` read the user id from the verified JWT claim.
- **Sign-in.** Use CAC/PIV or Login.gov through an approved identity provider, for example Cognito in GovCloud federated to the DoD or agency IdP, in place of Supabase Auth. Keep the role and installation model and the RLS policies as they are.
- **Server functions.** Move `notify` and `admin-reset` to AWS Lambda or Azure Functions in the same boundary. Use GovCloud SES or an approved relay for email.
- **Push.** APNs and FCM payloads leave the boundary. Keep them to a title and a record tag with no CUI, which is how `notify` sends them now.
- **Paperwork.** An ATO, a System Security Plan and continuous monitoring come with any of these paths. The cloud region's authorization does not cover the application.

## Security notes

- **The repo is public.** Commit only the anon key. Never commit the `service_role` key, `sb_secret_` keys, database passwords, access tokens, APNs or FCM keys, or email API keys. Set server secrets with `supabase secrets set`. `.gitignore` excludes `.env` files and the CLI's `.temp` folder.
- **Service keys in the browser.** `brp-backend.js` refuses a service key and refuses a non-https URL.
- **Demo accounts.** Their password is published, so anyone with the URL can sign in as any demo role, including the demo Admin. The limits above keep that contained to sample data. Before any real person or record goes in:
  1. Create your own Admin (sign up once, then have the first Admin promote you, or set it with SQL).
  2. Set `settings.demo_mode` to `{"enabled": false}`.
  3. Deactivate the nine demo accounts with `admin_set_role(..., p_active => false)`, or delete them in Authentication > Users.
- **Sign-up is off.** If it is ever turned on, new accounts arrive inactive and see nothing until an Admin activates them.
- **Audit log.** It is append-only from the client's point of view. Triggers write it, and no role can insert, update or delete rows.
- **Anonymous satisfaction.** Anonymous answers keep no identity, so staff cannot re-identify them.
- **CORS.** The Edge Functions allow any origin unless the `BRP_ALLOWED_ORIGIN` secret is set. Set it to the GitHub Pages origin once the site URL is final.
- **No real data in the demo.** No CUI, no PII, no real Soldier names. The seed is notional sample data.

## Testing

- **RLS suite.** `test/run-local.sh` runs on any local Postgres 15+ with no Supabase needed. It loads a small shim (`test/supabase-shim.sql`: the `auth` schema, `auth.uid()` and the anon, authenticated and service_role roles), the four migrations and the seed, then `test/rls-test.sql` and `test/agents-test.sql`. That suite signs in as each demo account and checks 63 rules. They cover what each role can read, refused writes, alert fan-out and outbox rows, push tokens, role changes, the demo-admin limits, the reset, and the reset refusal once demo mode is off. `agents-test.sql` checks 97 more: the buyer weekly cap, what the agent role can read and write, proposal checks, the off switch and admin decisions.
- **Agents.** `agents/test/run-all.sh` runs the SQL suites, the MCP handler test, the reply checker test (mocked model, no API) and the Playwright test of the Agent proposals panel. See `agents/AGENTS.md`.
- **CLI path.** The same files pass `supabase db push --include-seed` (CLI 2.118.0) against a local database.
- **Edge Functions.** Both type-check with Deno 2.1.4.
- **Admin console.** It was tested in Playwright Chromium at 1280 and 390 px in local demo mode: no console errors, no sideways page scroll, and non-admin sign-ins refused.
