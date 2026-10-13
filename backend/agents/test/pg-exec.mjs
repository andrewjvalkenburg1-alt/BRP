// Test helper: run one agent tool call on the local Postgres the same way the agent-mcp Edge Function does
// (one transaction: set local role brp_agent, set the agent claim, call one SQL function). Uses psql, no npm packages.
// PSQL: command prefix, default `psql -X -q -t -A -v ON_ERROR_STOP=1` run as the postgres OS user (local peer auth).
import { spawnSync } from 'node:child_process';

const DB = process.env.BRP_TEST_DB || 'brptest';
const lit = (v) => (v === null || v === undefined ? 'null' : "'" + String(v).replace(/'/g, "''") + "'");

export function psql(script) {
  const cmd = `psql -X -q -t -A -v ON_ERROR_STOP=1 -d ${DB}`;
  const asRoot = process.getuid && process.getuid() === 0;
  const r = asRoot ? spawnSync('su', ['postgres', '-c', cmd], { input: script, encoding: 'utf8' })
                   : spawnSync('sh', ['-c', cmd], { input: script, encoding: 'utf8' });
  if (r.status !== 0) {
    const m = (r.stderr || '').split('\n').find((l) => /ERROR:/.test(l)) || r.stderr || 'psql failed';
    throw new Error(m.replace(/^.*ERROR:\s*/, ''));
  }
  return r.stdout.trim();
}

export function agentExec(agent) {
  return async (sql, params) => {
    const text = sql.replace(/\$(\d+)/g, (_, n) => lit(params[+n - 1]));
    const out = psql(`begin;\nset local role brp_agent;\nselect set_config('request.jwt.claims', ${lit(JSON.stringify({ brp_agent: agent }))}, true) \\g /dev/null\n${text.replace(/ as r$/, '')};\ncommit;\n`);
    return out ? JSON.parse(out) : null;
  };
}
