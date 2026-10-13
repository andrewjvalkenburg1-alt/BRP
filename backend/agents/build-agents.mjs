#!/usr/bin/env node
// Builds the agent definitions (backend/agents/<agent>.json) from the BRP agent knowledge pack and the bench operator
// brief, plus the SHADOW MODE rule. Run it again whenever the pack changes, then re-run deploy.mjs (a changed system
// prompt becomes a new agent version). Reads only; writes only the JSON files next to this script.
//
//   node backend/agents/build-agents.mjs [/path/to/barracks/v1/agent-sim]
//
// The pack's records.json (bench sample records, with a restricted Soldier block) is NOT copied in. Deployed agents
// read live BRP records through the brp MCP server instead.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIM = process.argv[2] || process.env.BRP_AGENT_SIM || '/mnt/project-files/barracks/v1/agent-sim';
const KN = join(SIM, 'interview/knowledge');
const BRIEF = readFileSync(join(SIM, 'bench/OPERATOR-BRIEF.md'), 'utf8');
const TZ = 'America/Chicago';

const read = (p) => readFileSync(p, 'utf8').trim();
const coreFiles = readdirSync(join(KN, 'core')).filter((f) => f.endsWith('.md')).sort();
const core = coreFiles.map((f) => read(join(KN, 'core', f)));
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** One section of the operator brief, from its heading to the next heading of the same or higher level. */
function section(title) {
  const lines = BRIEF.split('\n');
  const i = lines.findIndex((l) => /^#{2,3} /.test(l) && l.replace(/^#+ /, '').startsWith(title));
  if (i < 0) throw new Error('Operator brief section not found: ' + title);
  const level = lines[i].match(/^#+/)[0].length;
  let j = i + 1;
  while (j < lines.length && !(new RegExp('^#{1,' + level + '} ').test(lines[j]))) j++;
  return lines.slice(i, j).join('\n').trim().replace(/^#{2,3} /, '### ');
}

const SHADOW = `# SHADOW MODE (this overrides every rule below)
You are running in shadow mode on the BRP backend. You never act. You read BRP records with brp_read and you write proposals with brp_propose. A person approves or rejects every proposal. An approval only records that the person agrees with you; the system executes nothing you propose.

1. Every proposal cites the BRP record ids it rests on (cited_ids): work orders, rooms, buildings, installations, purchase orders, parts, vendors, purchase list items. Cite only ids you saw in brp_read results in this run. The database refuses ids that do not exist.
2. Where the rules below say to write an ACTION line, page someone, open or update a work order, book or cancel an inspection, request a quote, place an order, cue a human, log, or submit a plan, call brp_propose with the matching kind instead. Never say or imply that anything was done, sent, paged, booked, ordered or approved.
3. If a fact you need is not in the BRP records you can read (for example quotes, vendor hours, manager calendars, sensor history), do not guess. Leave it out or write UNVERIFIED: in front of it, and list it under "could not check" in your end-of-run summary.
4. Life safety: a proposal is not a page. If the records show a life-safety condition, propose page_oncall at once and say in the rationale that a person must page now. People keep their own alarms and paging; shadow mode never replaces them.
5. You have only the brp tools. If any tool asks for approval, stop and end the run. Do not look for another way.
6. Money: you never approve money. For a purchase, call brp_spend_status first; set payload.approval_level to what it says. Never split one need into several orders.
7. Run steps, every run: (a) brp_begin_run. (b) brp_read what your role needs, with filters and limits of 100 or less. (c) brp_read agent_proposals with {"status": "proposed"} so you do not propose the same thing twice. (d) brp_propose, at most 15 proposals per run, most urgent first. (e) brp_end_run with a short summary: what you reviewed, how many proposals, what you could not check.
8. "records.json" in the rules below means the BRP records you read with brp_read in this run. Times in BRP records are UTC unless they say otherwise; the program works in ${TZ} and the installations keep their local time.`;

const SHADOW_END = `# Reminder
SHADOW MODE: read, then propose with cited record ids. You never act, and you never say that anything was done.`;

const KINDS = {
  purchase_order: '{vendor_id, lines: [{sku, qty, unit_cost}], shipping, total (USD incl. shipping), wo_id?, quote_ref?, approval_level: "auto" | "site_lead" | "program_manager" (from brp_spend_status)}',
  quote_request: '{vendor_id, sku?, mpn?, qty, wo_id?}',
  dispatch: '{wo_id, tech_name, due_at, reason}',
  priority: '{wo_id, from, to} (give the intake text you based it on in the rationale)',
  human_task: '{role, task_type, wo_id?, instructions}',
  backorder_decision: '{po_id, recommendation: "wait" | "alternate_vendor" | "temporary_fix", facts}',
  wo_note: '{wo_id, text}',
  sensor_work_order: '{room_id, priority, condition, evidence: [{room_id, field, value, read_at}]}',
  page_oncall: '{room_id, condition, evidence}',
  sensor_dismiss: '{room_id, reason, evidence}',
  sensor_maintenance: '{room_id, sensor_id, fault, evidence}',
  inspection_booking: '{type: "move_in" | "move_out" | "vacant_walk", room_ids or building_id, manager_name, start, end, requirement}',
  verification_booking: '{wo_id, manager_name, start, end}',
  inspection_cancel: '{booking_ref, reason}',
  readiness_plan: '{horizon_start, horizon_end, ready_now: [room_id], fill_next: [{rank, room_id, ready_now, ready_by}], rooms_returned: [room_id], schedule: [{date, wo_id, hours}], not_planned: [{room_id, reason}]}',
  room_status: '{room_id, from, to, reason}',
  intake: '{building, room, priority, reason, text}',
  reply_draft: '{conversation_ref, text}',
};

const AGENTS = [
  {
    key: 'buyer_dispatch',
    name: 'BRP Buyer and Dispatch (shadow)',
    description: 'Shadow mode. Reviews open work orders, parts, stock, the purchase list and purchase orders; proposes dispatch, priority, human tasks, quote requests and purchase orders under the money rule.',
    readiness: { level: 2, evidence: 'Action bench shift 2, run-002: PASS 99%, zero FAILs (audit Oct 9, 2026). Operator: claude-opus-5-5.', bench_model: 'claude-opus-5-5' },
    model: 'claude-opus-5-5',
    model_reason: 'Money and dispatch decisions; the bench pass was on Opus 5.5. Runs 7 times a day, so cost stays modest.',
    roles: ['buyer.md', 'dispatch.md'],
    brief: ['Priority and clocks', 'Money rules', 'Backorders', 'Parts', 'Orders and tracking'],
    reads: 'installations, buildings, rooms, work_orders, wo_events, vendors, catalog_items, parts, cabinets, stock, purchase_orders, po_lines, purchase_list, agent_proposals',
    schedule: { type: 'cron', expression: '0 6-18/2 * * *', timezone: TZ },
    schedule_text: 'Every 2 hours from 6:00 AM to 6:00 PM Central, every day (7 runs a day).',
    budget_cents: '300',
    task: 'Scheduled shadow run for Buyer and Dispatch. Review open and waiting-on-parts work orders, the purchase list, cabinet stock below reorder point, and purchase orders that are backordered or late. Propose what the back office should do next, each with cited record ids. Check brp_spend_status before any purchase proposal.',
  },
  {
    key: 'sensor_watch',
    name: 'BRP Sensor Watch (shadow)',
    description: 'Shadow mode. Reviews the latest room sensor readings and rooms on watch; proposes sensor work orders, on-call pages, false-alarm dismissals and sensor maintenance with the readings as evidence.',
    readiness: { level: 2, evidence: 'Action bench shift 3, run-003: PASS 100% (21 of 21 cells), audit Oct 2026. Operator: claude-opus-5-5.', bench_model: 'claude-opus-5-5' },
    model: 'claude-sonnet-5-5',
    model_reason: 'Highest-frequency agent (hourly). Its job is rule checks over a small snapshot, so Sonnet 5.5 at half the Opus token price fits. The shift 3 bench passed on Opus 5.5: re-run it on Sonnet 5.5 before shadow results count toward Level 4, or set model to claude-opus-5-5.',
    roles: ['sensor_watch.md'],
    brief: ['Sensor Watch rules'],
    reads: 'installations, buildings, rooms (latest sensor values), work_orders, wo_events, agent_proposals',
    schedule: { type: 'cron', expression: '15 * * * *', timezone: TZ },
    schedule_text: 'Every hour at quarter past, every day (24 runs a day).',
    budget_cents: '100',
    task: 'Scheduled shadow run for Sensor Watch. Read every room with a sensor (sensor_id not null) at your installations, and rooms in watch, action or offline status. Compare the latest readings with the Sensor Watch rules. Propose pages for life safety first, then sensor work orders, then sensor maintenance for rooms whose sensor is offline, low on battery or stale (sensor_read_at more than 1 hour old). The BRP backend holds the latest reading per room, not the 5-minute history: say so when a rule needs history.',
  },
  {
    key: 'inspection_scheduler',
    name: 'BRP Inspection Scheduler (shadow)',
    description: 'Shadow mode. Finds work orders that need a barracks manager verification after a repair, and rooms that need move-in, move-out or vacant-room inspections; proposes bookings inside the required windows.',
    readiness: { level: 2, evidence: 'Action bench shift 3, run-003: PASS 100% (inspection cells N to U). Operator: claude-opus-5-5.', bench_model: 'claude-opus-5-5' },
    model: 'claude-opus-5-5',
    model_reason: 'Calendar constraints (windows, duty hours, leave, no double booking) are where weaker runs fail; the bench pass was on Opus 5.5. Twice a weekday, so cost is small.',
    roles: ['dispatch.md'],
    brief: ['Inspection Scheduler rules'],
    reads: 'installations, buildings, rooms, work_orders, wo_events, agent_proposals',
    schedule: { type: 'cron', expression: '0 7,13 * * 1-5', timezone: TZ },
    schedule_text: '7:00 AM and 1:00 PM Central, Monday to Friday (10 runs a week).',
    budget_cents: '300',
    task: 'Scheduled shadow run for the Inspection Scheduler. Find work orders whose repair is reported complete and that have no passed verification, and rooms whose status or occupancy calls for an inspection. Propose one booking per need inside its window. The BRP backend does not yet hold manager calendars, duty hours or the leave roster: mark availability UNVERIFIED and name the barracks manager from the installation record.',
  },
  {
    key: 'room_readiness',
    name: 'BRP Room Readiness Planner (shadow)',
    description: 'Shadow mode. Ranks vacant rooms to fill next and proposes a 2-week plan that returns the most rooms to habitable within technician hours and parts on hand.',
    readiness: { level: 2, evidence: 'Action bench shift 3, run-003: PASS 100% (readiness cell V). Operator: claude-opus-5-5.', bench_model: 'claude-opus-5-5' },
    model: 'claude-opus-5-5',
    model_reason: 'Planning under hours and parts limits; the bench pass was on Opus 5.5. Twice a week.',
    roles: ['room_readiness.md'],
    brief: ['Room Readiness Planner rules'],
    reads: 'installations, buildings, rooms, work_orders, wo_events, parts, catalog_items, cabinets, stock, purchase_orders, po_lines, vendors, agent_proposals',
    schedule: { type: 'cron', expression: '30 6 * * 1,4', timezone: TZ },
    schedule_text: '6:30 AM Central on Monday and Thursday (2 runs a week).',
    budget_cents: '500',
    task: 'Scheduled shadow run for the Room Readiness Planner. For each installation you are on for, list vacant rooms, decide which are ready now (vacant, no open work order, nothing in the sensor values that makes them unfit), and propose one readiness_plan for the next 14 days. The BRP backend does not yet hold technician hours per day or work order hour estimates: state what you assumed as UNVERIFIED, or list the rooms as not_planned with that reason.',
  },
  {
    key: 'soldier_liaison',
    name: 'BRP Intake and Soldier Liaison (disabled)',
    description: 'DISABLED. Soldier-facing chat is not ready (readiness Level 1). Kept here so the definition is reviewed with the others; deploy.mjs never creates it.',
    readiness: { level: 1, evidence: 'Brief drafted. Interview bench dry run and run-001/run-002 only; no action bench.', bench_model: null },
    enabled: false,
    model: 'claude-opus-5-5',
    model_reason: 'Talks to people, including people in distress. If it is ever enabled it runs on the strongest model and every reply goes through the reply checker (reply-checker.mjs).',
    roles: ['soldier_liaison.md'],
    brief: [],
    reads: 'none while disabled',
    schedule: null,
    schedule_text: 'None. Not scheduled; a chat agent answers people, it does not run on a timer.',
    budget_cents: '100',
    task: null,
  },
];

function tools(key, enabled) {
  const mcpTools = ['brp_begin_run', 'brp_read', 'brp_propose', 'brp_end_run'].concat(key === 'buyer_dispatch' ? ['brp_spend_status'] : []);
  return [
    {
      type: 'agent_toolset_20260401',
      // Anything left on in the sandbox toolset waits for a person; tools that could act or reach out are off.
      default_config: { permission_policy: { type: 'always_ask' } },
      configs: ['bash', 'write', 'edit', 'web_fetch', 'web_search'].map((name) => ({ name, enabled: false })),
    },
    {
      type: 'mcp_toolset',
      mcp_server_name: 'brp',
      // Any tool the server adds later waits for a person until it is reviewed and listed here.
      default_config: { permission_policy: { type: 'always_ask' } },
      configs: mcpTools.map((name) => ({ name, enabled: enabled !== false, permission_policy: { type: 'always_allow' } })),
    },
  ];
}

const packHash = sha(core.join('\n') + BRIEF);
for (const a of AGENTS) {
  const roleText = a.roles.map((r) => read(join(KN, 'roles', r))).join('\n\n');
  const kinds = {
    buyer_dispatch: ['purchase_order', 'quote_request', 'dispatch', 'priority', 'human_task', 'backorder_decision', 'wo_note'],
    sensor_watch: ['sensor_work_order', 'page_oncall', 'sensor_dismiss', 'sensor_maintenance'],
    inspection_scheduler: ['inspection_booking', 'verification_booking', 'inspection_cancel'],
    room_readiness: ['readiness_plan', 'room_status'],
    soldier_liaison: ['intake', 'reply_draft'],
  }[a.key];
  const system = [
    `You are the ${a.name.replace(/ \((shadow|disabled)\)$/, '')} agent for the Barracks Readiness Program (BRP). SAMPLE DATA: every record in this BRP backend is sample data; nothing in it happened.`,
    SHADOW,
    '# What you can read and propose\n' +
      `- Tables you can read with brp_read: ${a.reads}. Soldier names, account ids and personal data are not readable, by design.\n` +
      `- Proposal kinds you can write with brp_propose, and their payloads:\n` + kinds.map((k) => `  - ${k}: ${KINDS[k]}`).join('\n'),
    '# Rules every BRP agent follows\n\n' + core.join('\n\n'),
    '# Your role brief\n\n' + roleText,
    a.brief.length ? '# Operating rules for this role (from the BRP agent bench operator brief; bench commands map to proposal kinds)\n\n' + a.brief.map(section).join('\n\n') : '',
    SHADOW_END,
  ].filter(Boolean).join('\n\n');
  if (/—/.test(system)) console.warn(`note: ${a.key} system prompt contains em dashes from the source pack`);

  const def = {
    key: a.key,
    enabled: a.enabled !== false,
    name: a.name,
    description: a.description,
    readiness: a.readiness,
    mode: a.enabled === false ? 'off' : 'shadow',
    model: a.model,
    model_reason: a.model_reason,
    system,
    mcp_server: { type: 'url', name: 'brp', url: '${SUPABASE_URL}/functions/v1/agent-mcp/' + a.key },
    tools: tools(a.key, a.enabled),
    schedule: a.schedule,
    schedule_text: a.schedule_text,
    budget: { type: 'limit', max_list_cost: { amount: a.budget_cents, currency: 'USD' } },
    initial_message: a.task,
    metadata: { brp_agent: a.key, brp_readiness: String(a.readiness.level), brp_mode: a.enabled === false ? 'off' : 'shadow', brp_pack: packHash },
    sources: {
      core: coreFiles.map((f) => 'agent-sim/interview/knowledge/core/' + f),
      roles: a.roles.map((r) => 'agent-sim/interview/knowledge/roles/' + r),
      operator_brief_sections: a.brief,
      pack_hash: packHash,
      built: new Date().toISOString().slice(0, 10),
    },
  };
  writeFileSync(join(HERE, a.key + '.json'), JSON.stringify(def, null, 2) + '\n');
  console.log(`${a.key}.json  model=${a.model}  system=${system.length} chars  schedule=${a.schedule ? a.schedule.expression : 'none'}`);
}
