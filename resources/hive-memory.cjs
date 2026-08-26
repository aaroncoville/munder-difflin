#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const unavailable = () => console.log('memory recall unavailable — continue without it');
const usage = () => console.error('usage: hive-memory search <query> [--results N] | wake-up');
const [verb, ...args] = process.argv.slice(2);
if (!((verb === 'search' && args[0]) || (verb === 'wake-up' && args.length === 0))) { usage(); process.exit(2); }

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
const results = verb === 'wake-up' ? 8 : Number(args[args.indexOf('--results') + 1] || 5);
const tags = process.env.HIVE_MEMORY_AGENT ? [`owner:${process.env.HIVE_MEMORY_AGENT}`] : undefined;
fetch(`${process.env.HINDSIGHT_URL}/v1/default/banks/${process.env.HINDSIGHT_BANK}/memories/recall`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
  body: JSON.stringify({ query, max_tokens: Math.max(1, results) * 512, ...(tags ? { tags } : {}) })
}).then(async (response) => {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  for (const hit of body.results || []) {
    // Recall ranks each result with a `scores` object; `final` is the value the
    // ordering is based on. Older/simpler responses carry a flat `score` instead.
    const score = hit.scores?.final ?? hit.score;
    console.log(`— ${hit.text || ''}${score == null ? '' : `  (score ${score})`}`);
  }
}).catch(unavailable).finally(() => clearTimeout(timer));
