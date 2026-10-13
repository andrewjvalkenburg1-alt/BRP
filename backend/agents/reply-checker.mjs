// BRP reply checker. Every agent that talks to people runs its draft reply through this before it is sent.
//
// It removes or rewrites any sentence that:
//   capability    states what another person, office, line or system can do, when, or how fast
//   authority     states who decides something (unless the knowledge pack says so)
//   safety        gives safety advice beyond the pack's script (core/02)
//   action_claim  says an action happened, or will happen, with no action record in the conversation
// Two passes: fixed rules (reply-checker.config.json), then a separate, cheaper model call that sees the draft, the
// conversation, the pack and the records. The rules win when they disagree: a sentence the rules flag is removed
// unless the model offers a rewrite that itself passes the rules. If a removed sentence carried a 911 or 988 line,
// the pack's script line is put back. The result is the cleaned reply plus a list of removed claims, which is logged
// to agent_runs (event reply_check) through public.agent_log_reply_check.
//
//   import { checkReply, anthropicCaller } from './reply-checker.mjs';
//   const out = await checkReply({ agent, draft, conversation, actions, pack, records, runId },
//                                { callModel: anthropicCaller(process.env.ANTHROPIC_API_KEY), logRun });
//   send(out.reply); // never the draft
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONFIG = JSON.parse(readFileSync(join(HERE, 'reply-checker.config.json'), 'utf8'));
const rx = (s) => new RegExp(s, 'i');

/** Splits prose into paragraphs of sentences. ACTION lines are kept apart (they are records, not prose). */
export function splitDraft(draft) {
  const actionLines = [];
  const paras = [];
  for (const block of String(draft || '').split(/\n{2,}/)) {
    const lines = [];
    for (const line of block.split('\n')) {
      if (/^\s*ACTION:\s*\{/.test(line)) { actionLines.push(line.trim()); continue; }
      lines.push(line);
    }
    const text = lines.join('\n').trim();
    if (!text) continue;
    // Keep list markers with their sentences; split after . ! ? followed by space and a capital, quote, digit or bracket,
    // but not after an initial (T. Hale) or a common abbreviation.
    const items = text.split(/\n/).map((l) => {
      const m = l.match(/^(\s*(?:[-*]|\d+[.)])\s+)(.*)$/);
      const lead = m ? m[1] : '';
      const body = m ? m[2] : l;
      return { lead, sentences: body.split(/(?<=[.!?])(?<!\b[A-Z]\.)(?<!\b(?:e\.g|i\.e|etc|Rm|Bldg|St|Dr|Mr|Ms|Mrs|No)\.)\s+(?=["'(\[A-Z0-9])/).filter((s) => s.trim()) };
    });
    paras.push(items);
  }
  return { paras, actionLines };
}

function parseActions(actionLines) {
  return actionLines.map((l) => { try { return JSON.parse(l.replace(/^\s*ACTION:\s*/, '')); } catch { return null; } }).filter(Boolean);
}

/** Rule pass on one sentence. Returns null (clean) or { category, reason }. */
export function ruleCheck(sentence, ctx, cfg = CONFIG) {
  const s = sentence.trim();
  const C = cfg.categories;
  const safetyCtx = rx(cfg.safety_context).test(s) || ctx.safetyConversation;

  // action claims first: they are checked against the action records, not just matched
  const ac = C.action_claim;
  if (!rx(ac.skip_if).test(s) && ac.patterns.some((p) => rx(p).test(s))) {
    const missing = actionGap(s, ctx.actions, ac);
    if (missing) return { category: 'action_claim', reason: missing };
  }
  for (const cat of ['capability', 'authority']) {
    const c = C[cat];
    const hit = c.patterns.find((p) => rx(p).test(s));
    if (hit && !(c.allowed || []).some((p) => rx(p).test(s))) return { category: cat, reason: `${c.label}: matches /${hit}/` };
  }
  if (safetyCtx) {
    let rest = s;
    for (const line of C.safety.script) rest = rest.replace(line, ' ');
    const hit = C.safety.patterns.find((p) => rx(p).test(rest));
    if (hit) return { category: 'safety', reason: `${C.safety.label}: matches /${hit}/` };
  }
  return null;
}

/** For an action claim: which role, record id or kind of action is not backed by an action record? null if backed. */
function actionGap(s, actions, ac) {
  const ids = new Set(actions.map((a) => a._id).filter(Boolean));
  const cited = s.match(/\b(?:ESC|TASK|INT|QR|NOTE|ORD|HT)-\d{3,}\b/g) || [];
  const unknownIds = cited.filter((id) => /^(ESC|TASK|INT|QR|NOTE)-/.test(id) && !ids.has(id));
  if (unknownIds.length) return `cites ${unknownIds.join(', ')}, which no action in this conversation created`;
  const covered = new Set();
  for (const a of actions) {
    if (a.type === 'escalate' && a.to) covered.add(a.to);
    if (a.type === 'human_task' && a.role) covered.add(a.role);
  }
  const roles = Object.entries(ac.roles).filter(([, p]) => rx(p).test(s)).map(([r]) => r);
  const missingRoles = roles.filter((r) => !covered.has(r) && !(r === 'on_call_human' && covered.has('on_call_human')));
  if (missingRoles.length) return `names ${missingRoles.join(', ')} but no escalation or task to ${missingRoles.length > 1 ? 'them' : 'that role'} exists in this conversation`;
  if (roles.length || cited.length) return null;
  const kinds = Object.entries(ac.verbs).filter(([, p]) => rx(p).test(s)).map(([k]) => k);
  if (kinds.length && !kinds.some((k) => actions.some((a) => a.type === k))) return `says ${kinds.join(' or ')} was done, but no such action exists in this conversation`;
  if (!kinds.length && !actions.length) return 'says something was done, but no action exists in this conversation';
  return null;
}

export function checkerPrompt({ agent, draft, conversation, actions, pack, records }, numbered, flags) {
  const system = `You check a draft reply from the BRP ${agent} agent before it is sent to a person. You do not write the reply; you judge each numbered sentence.
Remove or rewrite any sentence that:
1. capability: states what another person, office, phone line or system can do, when, or how fast (for example "They are there any time", "You can ask T. Hale directly"), unless the pack below says so;
2. authority: states who decides something, unless the pack below says so;
3. safety: gives safety advice beyond the pack's script in core/02 (for example where it is fine to wait, that something is safe, cleaning advice);
4. action_claim: says something was sent, logged, escalated, flagged, paged, or "is with" someone, or promises to do it, without a matching action record in the conversation (the action list below). An action to one role does not cover another role.
Keep everything else word for word. A rewrite must keep the useful part and drop only the claim; it must not add facts.
Answer with JSON only: {"verdicts":[{"i":<sentence number>,"verdict":"keep"|"remove"|"rewrite","category":"capability"|"authority"|"safety"|"action_claim"|null,"rewrite":"<text or null>","reason":"<short>"}]}`;
  const user = [
    '## Knowledge pack (what the agent may say)\n' + (pack || '(not provided)'),
    '## Records\n' + (records ? (typeof records === 'string' ? records : JSON.stringify(records)) : '(not provided)'),
    '## Conversation so far\n' + conversation.map((t) => `[${t.from}] ${t.text}`).join('\n\n'),
    '## Action records (the only actions that happened)\n' + JSON.stringify(actions),
    '## Draft reply, numbered sentences\n' + numbered.map((x) => `${x.i}. ${x.text}${flags[x.i] ? `   [rules flagged: ${flags[x.i].category}]` : ''}`).join('\n'),
    '## Full draft\n' + draft,
  ].join('\n\n');
  return { system, messages: [{ role: 'user', content: user }] };
}

function parseVerdicts(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('checker model returned no JSON');
  const j = JSON.parse(m[0]);
  if (!Array.isArray(j.verdicts)) throw new Error('checker model JSON has no verdicts');
  const by = {};
  for (const v of j.verdicts) if (v && Number.isInteger(v.i)) by[v.i] = v;
  return by;
}

/**
 * @param {object} input  { agent, draft, conversation: [{from, text}], actions: [prior action records with _id], pack, records, runId }
 * @param {object} deps   { callModel: async ({model, system, messages, max_tokens}) => text, logRun?: async (entry) => any, config? }
 */
export async function checkReply(input, deps = {}) {
  const cfg = deps.config || CONFIG;
  const conversation = input.conversation || [];
  const { paras, actionLines } = splitDraft(input.draft);
  const draftActions = (input.draftActions && input.draftActions.length ? input.draftActions : parseActions(actionLines)).map((a, k) => ({ _id: a._id || `DRAFT-${k + 1}`, ...a }));
  const actions = [...(input.actions || []), ...draftActions];
  const safetyConversation = rx(cfg.safety_context).test(conversation.filter((t) => t.from !== 'system').map((t) => t.text).join(' ') + ' ' + input.draft);
  const ctx = { actions, safetyConversation };

  const numbered = [];
  paras.forEach((items, p) => items.forEach((it, l) => it.sentences.forEach((text, k) => numbered.push({ i: numbered.length + 1, p, l, k, text }))));
  const flags = {};
  for (const x of numbered) { const f = ruleCheck(x.text, ctx, cfg); if (f) flags[x.i] = f; }

  let verdicts = {}, modelError = null;
  if (deps.callModel) {
    try {
      const pr = checkerPrompt({ ...input, conversation, actions }, numbered, flags);
      verdicts = parseVerdicts(await deps.callModel({ model: cfg.model, max_tokens: cfg.max_tokens, ...pr }));
    } catch (e) { modelError = e.message || String(e); }
  } else modelError = 'no model configured';
  if (modelError && cfg.on_model_error === 'block') {
    const out = { reply: cfg.fallback_reply, changed: true, removed: numbered.map((x) => ({ sentence: x.text, category: 'blocked', reason: 'checker model unavailable: ' + modelError, by: 'rules' })), model_error: modelError };
    if (deps.logRun) out.log = await deps.logRun(logEntry(input, out, cfg));
    return out;
  }

  const removed = [];
  const keep = {};
  for (const x of numbered) {
    const v = verdicts[x.i] || { verdict: 'keep' };
    const f = flags[x.i];
    if (v.verdict === 'rewrite' && v.rewrite && String(v.rewrite).trim()) {
      const rw = String(v.rewrite).trim();
      const again = ruleCheck(rw, ctx, cfg);
      if (!again) { keep[x.i] = rw; removed.push({ sentence: x.text, category: v.category || (f && f.category) || 'other', reason: v.reason || (f && f.reason) || '', by: 'model', replacement: rw }); continue; }
      removed.push({ sentence: x.text, category: v.category || again.category, reason: `model rewrite still failed the rules (${again.reason})`, by: 'rules', replacement: null });
      continue;
    }
    if (v.verdict === 'remove') { removed.push({ sentence: x.text, category: v.category || (f && f.category) || 'other', reason: v.reason || (f && f.reason) || '', by: f ? 'rules+model' : 'model', replacement: null }); continue; }
    if (f) { removed.push({ sentence: x.text, category: f.category, reason: f.reason, by: modelError ? 'rules (model unavailable)' : 'rules (model kept it)', replacement: null }); continue; }
    keep[x.i] = x.text;
  }

  // Rebuild paragraphs from kept sentences.
  const outParas = [];
  paras.forEach((items, p) => {
    const lines = [];
    items.forEach((it, l) => {
      const s = numbered.filter((x) => x.p === p && x.l === l && keep[x.i] !== undefined).map((x) => keep[x.i]);
      if (s.length) lines.push(it.lead + s.join(' '));
    });
    if (lines.length) outParas.push(lines.join('\n'));
  });
  let prose = outParas.join('\n\n');

  // Put back the pack's safety script if a removed sentence carried it and the cleaned reply lost it.
  for (const r of removed) {
    if (!/\b(911|988|838255)\b/.test(r.sentence) || /\b(911|988|838255)\b/.test(r.replacement || '')) continue;
    const rule = cfg.categories.safety.restore.find((x) => rx(x.when).test(r.sentence + ' ' + conversation.map((t) => t.text).join(' ')));
    if (rule && !prose.includes(rule.line)) { prose = (rule.line + (prose ? '\n\n' + prose : '')).trim(); r.restored = rule.line; }
  }
  if (!prose.trim()) prose = cfg.fallback_reply;
  // Nothing removed: send the draft exactly as written. Otherwise the ACTION lines go after the cleaned prose.
  const reply = removed.length ? [prose, ...actionLines].join('\n\n') : String(input.draft);
  const out = { reply, changed: removed.length > 0, removed, model_error: modelError, checked_sentences: numbered.length };
  if (deps.logRun) out.log = await deps.logRun(logEntry(input, out, cfg));
  return out;
}

function logEntry(input, out, cfg) {
  return {
    run_id: input.runId,
    agent: input.agent,
    summary: out.removed.length ? `Reply checker removed or rewrote ${out.removed.length} of ${out.checked_sentences ?? '?'} sentences.` : `Reply checker: ${out.checked_sentences ?? 0} sentences, nothing removed.`,
    removed: out.removed,
    counts: { checked: out.checked_sentences ?? null, removed: out.removed.length, model: cfg.model, model_error: out.model_error || null },
  };
}

/** Real model caller (Messages API). Not used by the tests. The key comes from the environment, never from a file. */
export function anthropicCaller(apiKey, base = 'https://api.anthropic.com') {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  return async ({ model, system, messages, max_tokens }) => {
    const r = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, system, messages, max_tokens }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || 'checker model call failed');
    return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  };
}

/** logRun for a server that holds a database connection: one transaction as brp_agent, like the agent-mcp function. */
export function sqlLogger(exec) {
  return (e) => exec('select public.agent_log_reply_check($1::uuid, $2::jsonb, $3::text, $4::jsonb) as r',
    [e.run_id, JSON.stringify(e.removed), e.summary, JSON.stringify(e.counts)]);
}
