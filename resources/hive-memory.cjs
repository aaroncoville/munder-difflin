#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const unavailable = () => console.log('memory recall unavailable — continue without it');
const usage = () => console.error('usage: hive-memory search <query> [--results N] | wake-up');
const [verb, ...args] = process.argv.slice(2);
if (!((verb === 'search' && args[0]) || (verb === 'wake-up' && args.length === 0))) { usage(); process.exit(2); }
// --results is optional; when it is given it must be a whole number of at least 1.
const resultsAt = args.indexOf('--results');
if (resultsAt !== -1 && !/^[1-9][0-9]*$/.test(args[resultsAt + 1] ?? '')) {
  console.error('hive-memory: --results needs a whole number of at least 1');
  usage();
  process.exit(2);
}

const backend = process.env.HIVE_MEMORY_BACKEND;
if (backend === 'mempalace') {
  const forwarded = [...args];
  if (process.env.HIVE_MEMORY_AGENT) forwarded.push('--wing', process.env.HIVE_MEMORY_AGENT);
  const result = spawnSync('mempalace', [verb, ...forwarded], { stdio: 'inherit' });
  if (result.error) unavailable();
  process.exitCode = result.error ? 0 : (result.status ?? 0);
  process.exit(process.exitCode);
}

if (backend !== 'hindsight' || !process.env.HINDSIGHT_URL || !process.env.HINDSIGHT_BANK) { unavailable(); process.exit(0); }
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 10_000);
const query = verb === 'wake-up' ? 'recent important context' : args[0];
const results = verb === 'wake-up' ? 8 : resultsAt === -1 ? 5 : Number(args[resultsAt + 1]);
const tags = process.env.HIVE_MEMORY_AGENT ? [`owner:${process.env.HIVE_MEMORY_AGENT}`] : undefined;
fetch(`${process.env.HINDSIGHT_URL}/v1/default/banks/${process.env.HINDSIGHT_BANK}/memories/recall`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
  body: JSON.stringify({ query, max_tokens: Math.max(1, results) * 512, ...(tags ? { tags } : {}) })
}).then(async (response) => {
  if (!response.ok) {
    // The backend answered but refused: say so, so a bad request is not mistaken for an outage.
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    console.error(`hive-memory: recall refused by the memory backend: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
    process.exitCode = 1;
    return;
  }
  const body = await response.json();
  for (const hit of body.results || []) {
    // Recall ranks each result with a `scores` object; `final` is the value the
    // ordering is based on. Older/simpler responses carry a flat `score` instead.
    const score = hit.scores?.final ?? hit.score;
    console.log(`— ${hit.text || ''}${score == null ? '' : `  (score ${score})`}`);
  }
}).catch(unavailable).finally(() => clearTimeout(timer));
