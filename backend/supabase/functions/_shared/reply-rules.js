// BRP reply checker, rules pass only, for the Edge Functions (Deno) and Node. A faithful port of splitDraft, ruleCheck
// and the rule half of checkReply in backend/agents/reply-checker.mjs, without the file read and without the model call.
// The config is a copy of backend/agents/reply-checker.config.json (the HQ tests fail if the two drift apart).
//
//   import { checkRules } from '../_shared/reply-rules.js';
//   const out = checkRules({ draft, conversation, actions }, CONFIG);   // out.reply is what may be shown
//
// Every sentence the rules flag is removed. With no model pass there is no rewrite, so this is the stricter half.
const rx = (s) => new RegExp(s, 'i');

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

export function ruleCheck(sentence, ctx, cfg) {
  const s = sentence.trim();
  const C = cfg.categories;
  const safetyCtx = rx(cfg.safety_context).test(s) || ctx.safetyConversation;
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

/** Same result as checkReply(input, {}) in reply-checker.mjs with on_model_error 'rules_only': flagged sentences removed. */
export function checkRules(input, cfg) {
  const conversation = input.conversation || [];
  const { paras, actionLines } = splitDraft(input.draft);
  const draftActions = (input.draftActions && input.draftActions.length ? input.draftActions : parseActions(actionLines)).map((a, k) => ({ _id: a._id || `DRAFT-${k + 1}`, ...a }));
  const actions = [...(input.actions || []), ...draftActions];
  const safetyConversation = rx(cfg.safety_context).test(conversation.filter((t) => t.from !== 'system').map((t) => t.text).join(' ') + ' ' + input.draft);
  const ctx = { actions, safetyConversation };
  const numbered = [];
  paras.forEach((items, p) => items.forEach((it, l) => it.sentences.forEach((text, k) => numbered.push({ i: numbered.length + 1, p, l, k, text }))));
  const removed = [];
  const keep = {};
  for (const x of numbered) {
    const f = ruleCheck(x.text, ctx, cfg);
    if (f) { removed.push({ sentence: x.text, category: f.category, reason: f.reason, by: 'rules (model unavailable)', replacement: null }); continue; }
    keep[x.i] = x.text;
  }
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
  for (const r of removed) {
    if (!/\b(911|988|838255)\b/.test(r.sentence)) continue;
    const rule = cfg.categories.safety.restore.find((x) => rx(x.when).test(r.sentence + ' ' + conversation.map((t) => t.text).join(' ')));
    if (rule && !prose.includes(rule.line)) { prose = (rule.line + (prose ? '\n\n' + prose : '')).trim(); r.restored = rule.line; }
  }
  if (!prose.trim()) prose = cfg.fallback_reply;
  const reply = removed.length ? [prose, ...actionLines].join('\n\n') : String(input.draft);
  return { reply, changed: removed.length > 0, removed, checked_sentences: numbered.length };
}
