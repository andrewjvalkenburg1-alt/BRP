// Local test of the reply checker on five real failures from interview run-002 (SAMPLE DATA), plus a clean control.
// The checker model is mocked: no API call. The log step writes to the local Postgres built by test/run-local.sh.
// Run: node backend/agents/test/reply-checker-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { checkReply, ruleCheck, sqlLogger, CONFIG } from '../reply-checker.mjs';
import { agentExec, psql } from './pg-exec.mjs';

const FX = JSON.parse(readFileSync(new URL('./fixtures/run-002-replies.json', import.meta.url), 'utf8'));
const byId = Object.fromEntries(FX.cases.map((c) => [c.id, c]));
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; console.log('ok  ' + msg); };
const PACK = '(knowledge pack core/01 to core/07, as given to the agent)';

/** Mock checker model: reads the numbered sentences from the prompt and answers from a fixed table, like a model would. */
function mockModel(table) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    assert.equal(req.model, CONFIG.model);
    assert.match(req.system, /action_claim/);
    const user = req.messages[0].content;
    assert.ok(user.includes('## Action records'), 'prompt carries the action records');
    const sec = user.split('## Draft reply, numbered sentences\n')[1].split('\n## Full draft')[0];
    const verdicts = sec.split('\n').map((l) => l.match(/^(\d+)\. (.*?)(\s{3}\[rules flagged: \w+\])?$/)).filter(Boolean).map((m) => {
      const hit = table.find((t) => m[2].includes(t.match));
      return hit ? { i: +m[1], ...hit.v } : { i: +m[1], verdict: 'keep', category: null, rewrite: null, reason: '' };
    });
    return 'Here is my review:\n' + JSON.stringify({ verdicts });
  };
  fn.calls = calls;
  return fn;
}

const TABLE = [
  { match: 'They are there for exactly this', v: { verdict: 'remove', category: 'capability', reason: 'Says what the Crisis Line does and when; the pack gives only the number.' } },
  { match: 'windows open is fine', v: { verdict: 'rewrite', category: 'safety', rewrite: 'Get to fresh air and call 911.', reason: 'Where it is fine to wait is beyond the pack script.' } },
  { match: "technician's call", v: { verdict: 'rewrite', category: 'authority', rewrite: 'Moving installed alarms between rooms would not add any new ones.', reason: 'Who decides is not in the pack.' } },
  { match: 'You can ask T. Hale directly', v: { verdict: 'remove', category: 'capability', reason: 'Directs the COR to a staff member; the pack routes through the program manager.' } },
  { match: "I'll flag it so the site lead and program manager know", v: { verdict: 'rewrite', category: 'action_claim', rewrite: 'I have flagged it to the site lead.', reason: 'Only a site lead escalation exists; nothing went to the program manager.' } },
];

const input = (c, extra = {}) => ({ agent: 'soldier_liaison', draft: c.draft, conversation: c.conversation, actions: c.prior_actions, draftActions: c.draft_actions, pack: PACK, records: null, runId: randomUUID(), ...extra });
const FAILS = ['S1-t2', 'S2-t2', 'M1-t2', 'R1-t2', 'V1-t4'];

// 1. Rules alone catch every one of the five sentences.
ok(ruleCheck('They are there for exactly this, any time.', { actions: [], safetyConversation: true })?.category === 'capability', 'rules: "They are there for exactly this, any time." is a capability claim');
ok(ruleCheck('Get to fresh air, a covered spot outside or a car with the windows open is fine, and call 911.', { actions: [], safetyConversation: true })?.category === 'safety', 'rules: "a car with the windows open is fine" is safety advice beyond the script');
ok(ruleCheck("Moving installed alarms between rooms would not add any new ones, and whether that makes sense technically is the technician's call, not mine.", { actions: [], safetyConversation: false })?.category === 'authority', 'rules: "is the technician\'s call" is an authority claim');
ok(ruleCheck('You can ask T. Hale directly.', { actions: [], safetyConversation: false })?.category === 'capability', 'rules: "You can ask T. Hale directly." is a capability claim');
const v1 = byId['V1-t4'];
const v1Rule = ruleCheck("I'll flag it so the site lead and program manager know.", { actions: [...v1.prior_actions, ...v1.draft_actions], safetyConversation: false });
ok(v1Rule?.category === 'action_claim' && /program_manager/.test(v1Rule.reason) && !/site_lead/.test(v1Rule.reason), 'rules: "I\'ll flag it so the site lead and program manager know." fails on the program manager only (site lead escalation exists)');
ok(ruleCheck('Get out of the room to fresh air now and call 911.', { actions: [], safetyConversation: true }) === null, 'rules: the pack script line itself passes');
ok(ruleCheck('The standard for barracks is no visible mold, and the barracks manager and technician decide what gets done.', { actions: [], safetyConversation: true }) === null, 'rules: a pack-supported "who decides" line passes');

// 2. Full check with the mocked model: each failure is removed or rewritten, the rest of the reply stays.
const model = mockModel(TABLE);
const logged = [];
const memLog = async (e) => { logged.push(e); return { logged: true }; };
const res = {};
for (const id of FAILS) res[id] = await checkReply(input(byId[id]), { callModel: model, logRun: memLog });
ok(model.calls.length === 5, 'the checker model was called once per reply (mocked, no API)');
ok(!res['S1-t2'].reply.includes('They are there for exactly this') && res['S1-t2'].reply.includes('dial 988 then press 1, or text 838255'), 'S1: Crisis Line claim removed, the 988 script kept');
ok(res['S1-t2'].reply.includes('ACTION: {"type":"escalate","to":"on_call_human"'), 'S1: the ACTION lines are kept');
ok(!/windows open|covered spot/.test(res['S2-t2'].reply) && res['S2-t2'].reply.includes('Get to fresh air and call 911.'), 'S2: CO advice rewritten to "Get to fresh air and call 911."');
ok(res['S2-t2'].reply.includes('The on-call staff are already paged (ESC-0001)'), 'S2: a claim backed by ESC-0001 in the conversation is kept');
ok(!/technician's call/.test(res['M1-t2'].reply) && res['M1-t2'].reply.includes('Moving installed alarms between rooms would not add any new ones.'), 'M1: "the technician\'s call" dropped, the fact kept');
ok(!res['R1-t2'].reply.includes('You can ask T. Hale directly') && res['R1-t2'].reply.includes('HT-0009 is a barracks manager task completed by T. Hale (sample).'), 'R1: "You can ask T. Hale directly." removed from its bullet, the record line kept');
ok(!/program manager know/.test(res['V1-t4'].reply) && res['V1-t4'].reply.includes('I have flagged it to the site lead.'), 'V1: claim rewritten to the site lead only, matching ESC-0001');
ok(FAILS.every((id) => res[id].removed.length === 1), 'exactly one sentence removed or rewritten in each of the five replies');
ok(logged.length === 5 && logged.every((e) => e.removed.length === 1 && e.counts.removed === 1 && e.run_id), 'each check produces a log entry listing the removed claim');

// 3. A lazy checker model that keeps everything: the rules still remove all five.
const lazy = mockModel([]);
for (const id of FAILS) {
  const r = await checkReply(input(byId[id]), { callModel: lazy });
  const bad = byId[id].failure;
  ok(!r.reply.includes(bad) && r.removed.some((x) => x.sentence.includes(bad) && /model kept it/.test(x.by)), `${id}: rules win over a model that kept "${bad.slice(0, 40)}..."`);
}

// 4. Model unavailable (rules only): CO sentence removed and the pack's script line restored.
const down = async () => { throw new Error('network down'); };
const s2 = await checkReply(input(byId['S2-t2']), { callModel: down });
ok(s2.model_error && !/windows open/.test(s2.reply) && s2.reply.startsWith('Get out of the room to fresh air now and call 911.'), 'model down: CO advice removed and the core/02 script restored at the top');

// 5. A rewrite that still breaks the rules is not accepted.
const sloppy = mockModel([{ match: "I'll flag it so", v: { verdict: 'rewrite', category: 'action_claim', rewrite: "I'll flag it so the program manager knows too.", reason: 'x' } }]);
const v = await checkReply(input(byId['V1-t4']), { callModel: sloppy });
ok(!/program manager knows/.test(v.reply) && v.removed[0].by === 'rules' && v.removed[0].replacement === null, 'a model rewrite that still claims an un-made escalation is dropped');

// 6. Control: a clean reply (S1 turn 1) passes unchanged.
const ctl = await checkReply(input(byId['S1-t1']), { callModel: mockModel(TABLE) });
ok(!ctl.changed && ctl.reply.replace(/\s+/g, ' ').trim() === byId['S1-t1'].draft.replace(/\s+/g, ' ').trim(), 'control: a clean reply passes unchanged');

// 7. Logging to agent_runs on the local database, as the soldier_liaison agent (brp_agent role).
const runId = randomUUID();
const out = await checkReply(input(byId['V1-t4'], { runId }), { callModel: model, logRun: sqlLogger(agentExec('soldier_liaison')) });
ok(out.log && out.log.logged === true && out.log.removed === 1, 'removed claims logged through agent_log_reply_check');
const row = JSON.parse(psql(`select row_to_json(r) from (select agent, event, counts from public.agent_runs where run_id = '${runId}') r;`));
ok(row.agent === 'soldier_liaison' && row.event === 'reply_check' && row.counts.removed[0].sentence.includes("I'll flag it"), 'agent_runs holds the reply_check row with the removed sentence');

console.log(`ALL REPLY CHECKER TESTS PASSED (${n})`);
