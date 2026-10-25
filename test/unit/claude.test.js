import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, parseDiagnosis, diagnose, SYSTEM_PROMPT, defaultClient } from '../../src/claude.js';
import { analyzeTest } from '../../src/stats.js';
import { classify } from '../../src/classify.js';
import { makeAttempts, fakeClient, goodDiagnosis } from '../helpers.js';

const source = "test('x', async ({ page }) => {\n  await page.waitForTimeout(300);\n});\n";
function evidence() {
  const t = makeAttempts({ baseline: [6, 0], 'slow-network': [0, 6] });
  t.attempts[0].signals = { appliedPerturbations: [], requests: [{ method: 'GET', url: '/api/products', ms: 120, at: 80 }], consoleErrors: [], pageErrors: [] };
  t.attempts[7].signals = { appliedPerturbations: ['latency 600-1200ms'], requests: [], consoleErrors: ['boom'], pageErrors: [], domAtFailure: 'Loading products…' };
  const analysis = analyzeTest(t);
  return { analysis, heuristic: classify(analysis, source), source, attempts: t.attempts };
}

test('system prompt forbids "fixing" flakiness with sleeps, retries or longer timeouts', () => {
  assert.match(SYSTEM_PROMPT, /Never "fix" flakiness with retries, longer timeouts or waitForTimeout/);
  assert.match(SYSTEM_PROMPT, /fixed_source/);
});

test('buildPrompt includes the variation matrix, error clusters, signals, smells, hypothesis and source', () => {
  const p = buildPrompt({ ...evidence(), appContext: 'Products load from /api/products' });
  assert.match(p, /\| slow-network \| network \| 6\/6 \| 100% \| 0\.\d+ \| YES \|/);
  assert.match(p, /\| baseline \| control \| 0\/6 \| 0% \| — \| no \|/);
  assert.match(p, /## Error clusters\n- \[assertion\] x6/);
  assert.match(p, /"url": "\/api\/products"/, 'passing-run network timings');
  assert.match(p, /Loading products…/, 'DOM at failure');
  assert.match(p, /line 2: Fixed sleep/);
  assert.match(p, /ASYNC_WAIT/);
  assert.match(p, /## Application context\nProducts load/);
  assert.ok(p.includes(source));
});

test('parseDiagnosis accepts plain JSON, fenced JSON and JSON with stray prose', () => {
  const d = goodDiagnosis();
  assert.equal(parseDiagnosis(JSON.stringify(d)).category, 'ASYNC_WAIT');
  assert.equal(parseDiagnosis('```json\n' + JSON.stringify(d) + '\n```').title, d.title);
  assert.equal(parseDiagnosis('Here you go:\n' + JSON.stringify(d) + '\nHope it helps').fixed_source, 'fixed();\n');
});

test('parseDiagnosis validates required fields and clamps confidence', () => {
  assert.throws(() => parseDiagnosis(''), /Empty response/);
  assert.throws(() => parseDiagnosis('no json here'), /No JSON object/);
  assert.throws(() => parseDiagnosis('{"category": "X",}'), /not valid JSON/);
  assert.throws(() => parseDiagnosis(JSON.stringify({ ...goodDiagnosis(), fixed_source: '' })), /missing "fixed_source"/);
  assert.equal(parseDiagnosis(JSON.stringify({ ...goodDiagnosis(), confidence: 7 })).confidence, 1);
  assert.equal(parseDiagnosis(JSON.stringify({ ...goodDiagnosis(), confidence: 'high' })).confidence, 0);
  assert.deepEqual(parseDiagnosis(JSON.stringify({ ...goodDiagnosis(), evidence: 'x' })).evidence, []);
});

test('diagnose sends system prompt + evidence to the model and returns the parsed result', async () => {
  const client = fakeClient(goodDiagnosis('better();\n'));
  const d = await diagnose({ client, model: 'claude-test', ...evidence() });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].model, 'claude-test');
  assert.equal(client.calls[0].system, SYSTEM_PROMPT);
  assert.match(client.calls[0].messages[0].content, /Variation matrix/);
  assert.equal(d.fixed_source, 'better();\n');
  assert.equal(d.model, 'claude-test');
  assert.deepEqual(d.usage, { input_tokens: 100, output_tokens: 50 });
});

test('diagnose retries once with the parse error when the first reply is malformed', async () => {
  const client = fakeClient('I think it is a race condition.', goodDiagnosis());
  const d = await diagnose({ client, ...evidence() });
  assert.equal(client.calls.length, 2);
  const followUp = client.calls[1].messages.at(-1).content;
  assert.match(followUp, /could not be parsed/);
  assert.equal(d.category, 'ASYNC_WAIT');
});

test('diagnose gives up after two malformed replies', async () => {
  const client = fakeClient('nope', 'still nope');
  await assert.rejects(diagnose({ client, ...evidence() }), /No JSON object/);
});

test('diagnose propagates API errors and returns null without a client', async () => {
  await assert.rejects(diagnose({ client: fakeClient(new Error('529 overloaded')), ...evidence() }), /overloaded/);
  assert.equal(await diagnose({ client: null, ...evidence() }), null);
});

test('defaultClient is null without ANTHROPIC_API_KEY (tool still works rule-based)', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(await defaultClient(), null);
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const c = await defaultClient();
  assert.equal(typeof c.messages.create, 'function');
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved;
});

test('diagnose respects a max_tokens budget', async () => {
  const client = fakeClient(goodDiagnosis());
  await diagnose({ client, maxTokens: 1500, ...evidence() });
  assert.equal(client.calls[0].max_tokens, 1500);
});
