# BRP operations agents: shadow mode runbook

SAMPLE DATA. Everything these agents read in the BRP demo backend is sample data. Nothing in it happened.

This folder runs four BRP operations agents as **Claude Managed Agents** on a schedule, against the BRP Supabase backend, in **shadow mode**: each agent reads BRP records and writes proposals with the record ids it relied on. A person approves or rejects each proposal in the admin console. Approving records agreement only. **Nothing an agent proposes is executed.**

Nothing here has been deployed. The kit was built and tested locally. No paid API was called.

## The agents

| Agent | Readiness | What it does in shadow mode | Schedule (America/Chicago) | Model |
|---|---|---|---|---|
| Buyer and Dispatch (`buyer_dispatch`) | L2: bench run-002, PASS 99% | Reviews open and waiting-on-parts work orders, the purchase list, stock under reorder point, backordered POs. Proposes dispatch, priority, human tasks, quote requests, backorder decisions and purchase orders. Checks the money rule before every purchase proposal. | Every 2 hours, 6:00 AM to 6:00 PM, every day (`0 6-18/2 * * *`, 7 runs a day) | Opus 5.5 |
| Sensor Watch (`sensor_watch`) | L2: bench run-003, PASS 100% | Reads the latest room sensor values. Proposes on-call pages for life safety, sensor work orders, false-alarm dismissals and sensor maintenance, with the readings as evidence. | Every hour at :15 (`15 * * * *`, 24 runs a day) | Sonnet 5.5 (see below) |
| Inspection Scheduler (`inspection_scheduler`) | L2: bench run-003, PASS 100% | Finds repairs that need a barracks manager verification and rooms that need move-in, move-out or vacant-room inspections. Proposes bookings inside their windows. | 7:00 AM and 1:00 PM, Monday to Friday (`0 7,13 * * 1-5`) | Opus 5.5 |
| Room Readiness Planner (`room_readiness`) | L2: bench run-003, PASS 100% | Ranks vacant rooms to fill next and proposes a 2-week plan to return the most rooms to habitable. The housing office assigns rooms. | 6:30 AM Monday and Thursday (`30 6 * * 1,4`) | Opus 5.5 |
| Intake and Soldier Liaison (`soldier_liaison`) | L1 | **Disabled.** Soldier-facing chat is not ready. The definition is kept for review; `deploy.mjs` never deploys it, and its database mode is `off`. | None | Opus 5.5 if ever enabled |

**Why these models.** All bench passes were run on Claude Opus 5.5 (`claude-opus-5-5`), so Opus 5.5 is the default. Sensor Watch is the one high-frequency agent and its work is rule checks over a small snapshot, so it is set to Claude Sonnet 5.5 (`claude-sonnet-5-5`), which is half the Opus token price. That is a model change from the bench: **re-run the shift 3 bench on Sonnet 5.5 before Sensor Watch's shadow results count toward Level 4**, or change `model` in `sensor_watch.json` to `claude-opus-5-5` (cost shown below).

**Life safety.** A shadow proposal is not a page. Real alarms, CQ and on-call paging stay exactly as they are. Sensor Watch runs hourly, so it can be up to an hour late by design.

## How it fits together

1. **Database** (`../supabase/migrations/20261014000100_brp_agents.sql`).
   - `agent_settings`: mode per agent, per installation: `off`, `shadow`, `supervised`, `live`. The `*` row covers all installations; a row for one installation overrides it.
   - `agent_runs`: append-only run log (start, finish or error, and reply checks).
   - `agent_proposals`: agent, installation, kind, payload, rationale, cited record ids, flags, status (proposed, approved, rejected), who decided and when.
   - Role `brp_agent`: reads only the tables and columns its job needs (Soldier names, account ids, profiles, satisfaction answers, the email outbox and the audit log are not readable). It can insert into `agent_runs` and `agent_proposals` and nothing else. It has no UPDATE or DELETE on any table. An agent switched `off` for an installation cannot see that installation's data at all.
   - The money rule: `buyer_weekly_cap(installation)` and `buyer_spend_check(installation, amount)`. A purchase proposal is checked when it is written: over a limit, it is flagged and routed to the site lead (or the program manager over $2,500); if it claims auto-approval while over a limit, it is refused.
   - Proposals that cite a record id that does not exist are refused.
2. **MCP server** (`../supabase/functions/agent-mcp`). A Supabase Edge Function at `/functions/v1/agent-mcp/<agent>`. It offers five tools: `brp_begin_run`, `brp_read`, `brp_spend_status` (Buyer only), `brp_propose`, `brp_end_run`. Each call runs as `brp_agent` with the agent's name in the request claims. Each agent has its own bearer token; Supabase stores only its SHA-256 hash.
3. **Agent definitions** (`*.json` here, built by `build-agents.mjs` from the knowledge pack). System prompt = SHADOW MODE rule + core rules 01 to 07 + role brief + the matching sections of the bench operator brief. Tools: the five `brp` MCP tools set to `always_allow`. Everything else waits for a person: the MCP toolset default is `always_ask` (so a tool added to the server later cannot run unreviewed), and the sandbox toolset is `always_ask` with `bash`, `write`, `edit`, `web_fetch` and `web_search` turned off.
4. **Deployment** (`deploy.mjs`). One environment (`brp-agents-shadow`, limited networking: no hosts, MCP servers only), one vault (`BRP agents`, one `static_bearer` credential per agent MCP URL), one agent and one scheduled deployment per enabled definition, with a spend cap on every run.
5. **Approvals** (`../client/admin.html`, tab **Agent proposals**). Admin only. Shows waiting proposals, approve or reject (a reason is required to reject), the agreement rate, and each agent's mode with a **Change** button (the off switch). Every decision and mode change goes to the audit log.
6. **Reply checker** (`reply-checker.mjs`, `reply-checker.config.json`). For any agent that talks to people (today only `soldier_liaison`, which is disabled). Before a reply is sent, fixed rules and a separate, cheaper model call (Sonnet 5.5) read the draft, the conversation, the pack and the records, and remove or rewrite any sentence that says what another person, office, line or system can do; says who decides something the pack does not back; gives safety advice beyond the pack's script; or says an action happened (or will) with no action record in the conversation. The rules win when the model disagrees. If a removed sentence carried a 911 or 988 line, the pack's script line is put back. The cleaned reply is what gets sent, and the removed claims are logged to `agent_runs` (event `reply_check`). It is tested on five real failures from interview run-002, with the model mocked.

## Cost (estimate)

Pricing source: [platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing), Claude Managed Agents section, read Oct 13, 2026. Managed Agents bill **tokens at the normal model rates plus $0.08 per session-hour, counted only while a session is `running`** (not while idle).

| Rate (per million tokens) | Input | 5-minute cache write | Cache hit | Output |
|---|---:|---:|---:|---:|
| Claude Opus 5.5 | $4.00 | $5.00 | $0.20 | $20.00 |
| Claude Sonnet 5.5 | $2.00 | $2.50 | $0.10 | $10.00 |

**Assumptions for one run (estimate, not measured).** A system prompt and tools of about 8,000 tokens (the prompts are 22,000 to 27,000 characters); about 10 model calls per run; context growing as records are read, so about 200,000 input tokens in total across the calls, of which about 40,000 are new (written to cache) and 160,000 are cache hits; about 500 output tokens per call, 5,000 in all; 3 minutes running (0.05 hours).

My calculation, one run:
- Opus 5.5: 40,000 x $5.00/M = $0.200; 160,000 x $0.20/M = $0.032; 5,000 x $20.00/M = $0.100; runtime 0.05 h x $0.08 = $0.004. Total **$0.336**.
- Sonnet 5.5: 40,000 x $2.50/M = $0.100; 160,000 x $0.10/M = $0.016; 5,000 x $10.00/M = $0.050; runtime $0.004. Total **$0.170**.

My calculation, a 30-day month:

| Agent | Runs a month | Per run | Month |
|---|---:|---:|---:|
| Buyer and Dispatch (Opus) | 7 x 30 = 210 | $0.336 | $70.56 |
| Sensor Watch (Sonnet) | 24 x 30 = 720 | $0.170 | $122.40 |
| Inspection Scheduler (Opus) | 10 a week x 30 / 7 = 43 | $0.336 | $14.45 |
| Room Readiness Planner (Opus) | 2 a week x 30 / 7 = 9 | $0.336 | $3.02 |
| **Total** | 982 | | **$210.43** |

- Session runtime is a small part of it: 982 runs x 0.05 h = 49.1 h x $0.08 = $3.93 of the total.
- Sensor Watch on Opus instead: 720 x $0.336 = $241.92 a month (total $330.03). Sensor Watch every 2 hours on Sonnet: 360 x $0.170 = $61.20.
- **Ceiling.** Every run has a spend cap (`budget` in each JSON: Buyer $3, Sensor Watch $1, Inspection $3, Readiness $5). The most the schedules can spend in a month is 210 x $3 + 720 x $1 + 43 x $3 + 9 x $5 = $1,524. A run that hits its cap pauses.
- Check real spend in the Console after the first week and correct these numbers. They are estimates.

## Data and compliance

- **Not ZDR or HIPAA eligible.** Managed Agents keep session history, sandbox state and outputs on Anthropic's servers, so they are not eligible for Zero Data Retention or a HIPAA BAA (Managed Agents overview, "Beta access"). Sessions can be deleted through the API.
- **Sample data only.** The BRP demo backend is not accredited for Army data (see `../BACKEND.md`). Do not point these agents at real Soldier, installation or contract data. A real Level 4 trial on live work needs an accredited environment for both the database and the model service first.
- **Beta.** Managed Agents is in beta (header `anthropic-beta: managed-agents-2026-04-01`). Request shapes may change; `deploy.mjs --dry-run` shows exactly what will be sent.
- **What the agents cannot see.** Profiles, push tokens, the email outbox, alert recipients, the audit log, satisfaction answers, and the Soldier and account columns of work orders and the purchase list.

## What the BRP records do not hold yet (the agents say so instead of guessing)

- Sensor history: the backend keeps the latest reading per room, not the 5-minute series, so trend rules (mold risk: over 60% RH for 72 hours) cannot be confirmed.
- Manager calendars, duty hours and the leave roster (Inspection Scheduler marks availability UNVERIFIED).
- Technician hours per day and work order hour estimates (Room Readiness Planner).
- Vendor quotes, quote expiry and the vendor `approved` flag (Buyer cannot confirm "approved vendor" or "price on a written quote").

## What Andrew must provide

1. **An Anthropic Console account** at [platform.claude.com](https://platform.claude.com), with billing set up. Managed Agents is on by default for API accounts.
2. **An API key** from Settings, API keys. Keep it in your shell, a password manager or a CI secret store as `ANTHROPIC_API_KEY`. **Never put it in this repo** (the repo is public). `deploy.mjs` reads it from the environment and never prints it.
3. **The Supabase project** from `../BACKEND.md`, with this migration applied (`supabase db push` runs it with the others).
4. **Four agent tokens.** One random token per agent, kept like the API key:
   ```bash
   export BRP_AGENT_TOKEN_BUYER_DISPATCH=$(openssl rand -hex 32)
   export BRP_AGENT_TOKEN_SENSOR_WATCH=$(openssl rand -hex 32)
   export BRP_AGENT_TOKEN_INSPECTION_SCHEDULER=$(openssl rand -hex 32)
   export BRP_AGENT_TOKEN_ROOM_READINESS=$(openssl rand -hex 32)
   ```
5. **Decisions:**
   - Per-order limit: confirmed by Andrew on Oct 13, 2026. $500 stays fixed while weekly caps change (`settings.buyer_money_rule.per_order_confirmed` is true). Spend above $2,500 a week, when an installation's average allows it, is approved by the program manager.
   - Confirm that the weekly cap may rise above $2,500 once history supports it (the rule as written: trailing 3-month average plus 10%, so an installation averaging $3,000 a week gets $3,300).
   - Week boundaries: Monday 00:00 America/Chicago today (`week_tz` in `settings.buyer_money_rule`). Change it if you want each installation's local time.
   - Sonnet 5.5 for Sensor Watch (re-bench first) or Opus 5.5.
   - The Level 4 pass mark (proposed below).

## Deploying (Claude or Andrew runs this)

```bash
cd backend
npx -y supabase@2.118.0 db push                                     # applies 20261014000100_brp_agents.sql
npx -y supabase@2.118.0 functions deploy agent-mcp --no-verify-jwt  # the MCP server checks its own tokens
node agents/deploy.mjs token-hashes                                 # prints a `supabase secrets set` line (hashes only)
#   run the printed line
export ANTHROPIC_API_KEY=...  SUPABASE_URL=https://<ref>.supabase.co
node agents/deploy.mjs --dry-run      # read what will be sent
node agents/deploy.mjs                # create or update environment, vault, agents and schedules
node agents/deploy.mjs run sensor_watch   # optional: one run now, outside the schedule
node agents/deploy.mjs status
```

- After the knowledge pack changes: `node agents/build-agents.mjs`, review the diff, then `node agents/deploy.mjs` (each changed prompt becomes a new agent version and the deployment moves to it).
- `dry-run-output.txt` is the saved dry run from Oct 13, 2026: 18 requests, none sent.

## Switching an agent off

Any one of these works. The first two take effect at once.

1. **Admin console**, Agent proposals, Agent modes, **Change**, set **Off** (for all installations or one). The agent can no longer read that scope or write proposals. Database equivalent: `select admin_set_agent_mode('sensor_watch', '*', 'off', 'why');`
2. **Stop its schedule:** `node agents/deploy.mjs pause sensor_watch` (`unpause` to resume; missed runs are not made up).
3. **All agents at once:** `npx -y supabase@2.118.0 secrets set BRP_AGENTS_DISABLED=1` (the MCP server refuses every call), or remove an agent's hash from `BRP_AGENT_TOKEN_SHA256`.
4. **For good:** archive the deployment and the agent in the Console.

## Moving up the readiness ladder (L4 to L6)

The ladder is in `agent-sim/interview/READINESS.md`. An agent moves up one level at a time and drops back a level after any FAIL on safety, privacy, money or honesty in real use.

| Level | Mode here | How an agent gets there | What changes |
|---|---|---|---|
| 4 Shadow | `shadow` | 2 weeks of proposals on real work, every one decided by a person. **Proposed pass mark (Andrew to set):** at least 50 decided proposals, an agreement rate of 90% or better (shown on the console), and no rejection whose reason is a safety, privacy, money or honesty failure. | Nothing acts. This kit runs this level today. |
| 5 Supervised live | `supervised` | L4 passed. A tool that performs the action is built, reviewed and bench-tested for that agent, with tight limits (for example the Buyer only inside the money rule, never over it). A person reviews every action daily. The off switch is tested on the live system. | **Not built in this kit.** Setting `supervised` records the decision; no tool acts on it yet. Only a non-demo Admin can set it. |
| 6 Full authority within limits | `live` | L5 held for an agreed period with no FAIL. A person audits a sample every week. | As L5, without the daily review. |

To move an agent: record the evidence (agreement rate, the rejected proposals and their reasons), have Andrew sign off, then change its mode in the console. Moving down is the same switch.

## Files

| File | What it is |
|---|---|
| `buyer_dispatch.json`, `sensor_watch.json`, `inspection_scheduler.json`, `room_readiness.json`, `soldier_liaison.json` | Agent definitions: name, model and why, system prompt, tools and permission policies, schedule, per-run budget, first message |
| `build-agents.mjs` | Builds the definitions from the knowledge pack (`agent-sim/interview/knowledge`) and the bench operator brief |
| `deploy.mjs` | Creates or updates the environment, vault, agents and scheduled deployments. `--dry-run`, `pause`, `unpause`, `run`, `status`, `token-hashes` |
| `dry-run-output.txt` | Saved dry run |
| `reply-checker.mjs`, `reply-checker.config.json` | The reply checker module and its rules |
| `test/mcp-test.mjs` | MCP tool layer against local Postgres |
| `test/reply-checker-test.mjs`, `test/fixtures/run-002-replies.json` | Reply checker on the run-002 failures (model mocked) |
| `test/admin-panel-test.mjs` | Playwright check of the console panel at 1280 and 390 px |
| `test/run-all.sh` | Runs everything above plus the SQL suites |
| `../supabase/migrations/20261014000100_brp_agents.sql` | Tables, role, policies, money rule, agent and admin functions |
| `../supabase/functions/agent-mcp/` | The MCP server (`index.ts`) and its tool layer (`mcp.ts`) |
| `../test/agents-test.sql` | SQL tests: role limits, proposals, money rule, decisions |

## Tests (run Oct 13, 2026 on local Postgres 16 and Node 22)

`backend/agents/test/run-all.sh` (as a user who can run `createdb` and `psql`):
- RLS suite: 63 checks pass (unchanged).
- Agent SQL suite: 97 checks pass. Includes the cap: under 3 months is $2,500; 13 weeks at $1,000 gives $1,100; the switch at exactly 3 months ($2,500 one minute before, $609.23 after); $3,000 average gives $3,300 and one cent over is flagged.
- MCP tool layer: 16 checks pass.
- Reply checker: 27 checks pass.
- Admin panel (Playwright Chromium, 1280 and 390 px): 36 checks pass, no console errors, no sideways scroll.

Not verified: anything against the live Managed Agents API (nothing was sent), the Edge Function under Deno or on Supabase (no Deno here; its tool layer is tested under Node), `SUPABASE_DB_URL` being present in the hosted Edge runtime, and `grant brp_agent to postgres` on hosted Supabase.
