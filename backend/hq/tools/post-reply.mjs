#!/usr/bin/env node
// For Claude in the BRP Command thread: check a reply with the reply checker rules, then print the SQL that posts it.
// Usage: node backend/hq/tools/post-reply.mjs --owner <thread_owner uuid> --request RQ-0001 [--thread main] [--done] [--sample] < reply.txt
// Run the printed SQL with the Supabase connector (execute_sql). Only the checked text is posted; removed sentences are listed
// on stderr so you can rewrite them with a record behind them. Nothing here talks to the network.
import { readFileSync } from 'node:fs';
import { checkRules } from '../../supabase/functions/_shared/reply-rules.js';
import { FALLBACK } from '../../supabase/functions/hq-chat/core.js';

const CONFIG = JSON.parse(readFileSync(new URL('../../supabase/functions/_shared/reply-checker.config.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const owner = opt('--owner'), rq = opt('--request'), thread = opt('--thread', 'main');
if (!/^[0-9a-f-]{36}$/i.test(owner || '')) { console.error('--owner must be the thread_owner uuid from the fire text'); process.exit(2); }
if (rq && !/^RQ-\d{4,}$/.test(rq)) { console.error('--request must look like RQ-0001'); process.exit(2); }
const draft = readFileSync(0, 'utf8').trim();
if (!draft) { console.error('Give the reply on stdin'); process.exit(2); }
const out = checkRules({ draft, conversation: [], actions: [] }, { ...CONFIG, fallback_reply: FALLBACK });
for (const r of out.removed) console.error(`removed (${r.category}): ${r.sentence}`);
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
console.log(`insert into public.hq_messages (thread, thread_owner, role, author, content, checked, sample) values (${q(thread)}, ${q(owner)}, 'assistant', 'Claude', ${q(out.reply)}, ${q(JSON.stringify({ changed: out.changed, removed: out.removed, checked_sentences: out.checked_sentences }))}::jsonb, ${args.includes('--sample')});`);
if (rq) console.log(`update public.hq_requests set status = ${args.includes('--done') ? "'done'" : "'working'"}${args.includes('--done') ? ', result = ' + q(out.reply.slice(0, 2000)) : ''} where id = ${q(rq)};`);
