# Command

Command is the one place Andrew runs BRP from. It lives at
https://andrewjvalkenburg1-alt.github.io/BRP/backend/hq/ and installs to an iPhone home screen from Safari
(Share, Add to Home Screen). The folder is still called `hq`.

It has these sections:

| Section | What it shows |
|---|---|
| Home | "Needs you": open decisions, your tasks due soon or at risk, agent proposals waiting. Key numbers. |
| Tasks | Every task by owner (Andrew, Claude, Rynoc, Attorney, CPA). Mark done, add a note. |
| Decisions | Questions for Andrew with a recommended answer. One tap to decide. Agent proposals show here too. |
| Agents | Each agent's level on the readiness ladder, its mode, and its proposals to approve or reject. |
| Purchasing | The admin console's purchase orders, purchase list, stock, parts and work orders, embedded. |
| Rooms | The admin console's rooms and sites, embedded. A site lead sees only their own installation. |
| Systems | What is live, what is blocked and why. |
| Documents | Links to the plans, guides and apps. |
| Claude | "Claude (BRP Command thread)". Also on every page from the Claude button. |

Until the backend is connected it runs in **demo mode**: sample data in the browser, nothing sent anywhere.
Every record in demo mode is sample data.

## Signing in

One sign-in for BRP One and Command. In demo mode both read the same session key
(`sessionStorage['brp-one:user']`), so signing in to BRP One as `owner@brp.demo` opens Command already signed in,
in the same tab. Signing out of Command signs out of BRP One too.

Demo accounts (password `BRPdemo2026!`, shown on the sign-in screen):

| Account | Sees |
|---|---|
| owner@brp.demo | Everything (owner). |
| admin@brp.demo | Everything (admin). |
| partner@brp.demo | Rynoc tasks and anything marked shared. No decisions, Purchasing or Rooms. |
| sitelead@brp.demo | Tasks, decisions, rooms and documents for Fort Stewart only. |

With the backend on, row-level security enforces the same rules in the database (migration
`backend/supabase/migrations/20261015000100_brp_hq.sql`). Demo accounts only ever see and write sample rows.
Real rows are hidden from them, because their password is published.

## Talking to Claude

The Claude panel has two buttons.

**Send to Claude** (the default). The message is saved as an `hq_messages` row (role user) and an `hq_requests`
row (RQ-0001 and up). The `hq-chat` Edge Function then starts a Claude Code routine with the message text, the
request id, the message id and the thread owner. The panel shows "Sent to Claude. Replies appear here." Claude
answers by writing an assistant row into `hq_messages` with the Supabase connector. Command checks for new
replies every 15 seconds.

To write a reply, Claude runs:

```
node backend/hq/tools/post-reply.mjs --owner <thread_owner> --request RQ-0001 [--done] < reply.txt
```

It runs the reply checker rules (the same rules the agents use), lists any sentence it removed, and prints the
SQL to run with the connector. Or the routine can POST to the `hq-result` function (see below).

Important: a routine fire **always starts a new Claude Code session**. It cannot post into an existing
conversation. "The BRP Command thread" is therefore the routine itself: its saved prompt says who it is and
tells it to read the recent `hq_messages` rows for that thread before answering, so each new session picks up
where the last one left off. The thread history lives in the database, not in one session.

**Quick answer** (optional). A short reply right away, from the records, through the Messages API
(model `claude-opus-5-5`). It can read records the person is allowed to see, and can draft a task, a decision
or a request for the person to save with one tap. It cannot change anything by itself. Every answer passes the
reply checker rules before it is stored or shown.

## Going live

Nothing here costs money until the last step.

1. **Supabase connector.** Make a free Supabase project, then Settings > Connectors > Supabase. Claude then:
   - applies the migrations in `backend/supabase/migrations/` (including `20261015000100_brp_hq.sql`),
   - loads `seed/seed.sql`, `seed/hq-seed.sql` and `seed/hq-seed-data.sql` for the demo accounts,
   - deploys the functions `hq-chat` (JWT checked) and `hq-result` (token checked), as set in `config.toml`,
   - fills in `backend/client/brp-config.js` (project URL and anon key only; both are public by design).
2. **Make Andrew the real owner.** Sign up with his real email, then as an admin run
   `select public.hq_set_member('<his email>', 'owner', 'Andrew');`.
   Do the same with `'partner', 'Rynoc'` for the Rynoc partner and use the site lead's normal BRP role.
3. **Import the Command Center.** Export the Command Center artifact's records, then:
   ```
   node backend/hq/tools/import-command-center.mjs <export.json> --sql /tmp/hq-import.sql
   ```
   Leave out `--sample` so they come in as real rows. Run the SQL with the connector. It upserts by id, so it is
   safe to run again.
4. **Routine for the Command thread.** Make a Claude Code routine with an API trigger. Its saved prompt says:
   you are the BRP Command thread; act on the fire text as a message from Andrew; read the last 30
   `hq_messages` rows for the thread first; reply with `post-reply.mjs`. Then add Edge Function secrets:
   - `CLAUDE_ROUTINE_FIRE_URL`: `https://api.anthropic.com/v1/claude_code/routines/<trigger id>/fire`
   - `CLAUDE_ROUTINE_TOKEN`: the trigger's token (shown once)
   - `HQ_RESULT_TOKEN`: a random string of 32 characters or more, only if the routine reports through `hq-result`
5. **Anthropic account (billing only).** Only for Quick answer. Make an Anthropic Console account, create an API
   key, and save it as the Edge Function secret `ANTHROPIC_API_KEY`. Never paste it in chat or in the repo.
   Without it, Send to Claude still works and Quick answer says it is not connected.

Secrets live only in Supabase (Edge Functions > Secrets). This repo is public: nothing secret goes in it.

## Retiring the Command Center artifact

1. Do step 3 above and check the counts it prints (today: 32 tasks, 6 decisions, 7 agents, 7 systems).
2. Use Command for a week alongside the artifact. Claude's daily check-in and Monday status write to the
   `hq_tasks` and `hq_decisions` tables instead of the artifact.
3. Run the import one last time to catch late edits, then add a line at the top of the artifact pointing to
   Command and stop updating it.

The snapshot in `backend/hq/seed/command-center-2026-10-13.json` is the Oct 13 export used for the demo.

## Changes needed in BRP One (repo root, not in this folder)

1. `index.html`, the `ACCTS` list: add
   `{ email: 'owner@brp.demo', role: 'Admin', name: 'HQ owner (demo)', inst: null }`
   so BRP One accepts the owner account and lists it on its sign-in screen.
2. `index.html`: add a "Command" link to `backend/hq/` for Admin accounts (for example next to Admin and
   Purchasing), opened in the same tab so the session carries over.
3. `sw.js`, the fetch handler: skip Command and the admin console so the root service worker does not serve old
   copies, e.g. `if (u.startsWith(sc + 'backend/')) return;` right after `const sc=...`.
4. With the backend on, BRP One should sign in through `backend/client/brp-backend.js` (it keeps the session in
   `localStorage['brp-backend-auth']`), so one sign-in covers both apps, including the installed app.

## Files

| Path | What |
|---|---|
| `backend/hq/index.html`, `hq.js`, `hq.css` | The app |
| `backend/hq/manifest.webmanifest`, `sw.js` | Install and offline shell, scoped to `/BRP/backend/hq/` |
| `backend/hq/hq-seed.js`, `seed/` | Demo data, made by the import tool |
| `backend/hq/tools/import-command-center.mjs` | Command Center export to SQL or demo data |
| `backend/hq/tools/post-reply.mjs` | Check a Claude reply and print the SQL that posts it |
| `backend/supabase/functions/hq-chat/` | Send to Claude (routine fire) and Quick answer |
| `backend/supabase/functions/hq-result/` | Routine reports progress and results |
| `backend/supabase/functions/_shared/reply-rules.js` | Reply checker rules for the functions (config copy kept equal by a test) |

## Tests

`bash backend/hq/test/run.sh` (also run by `bash backend/agents/test/run-all.sh`): chat core tests with a mocked
model and fetch, then the browser tests at 390 and 1280 pixels wide. The database rules are tested by
`backend/test/hq-test.sql` through `backend/test/run-local.sh`. No test calls a paid API.
