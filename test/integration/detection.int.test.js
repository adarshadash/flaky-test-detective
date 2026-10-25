// Real browser, real flaky tests against the FlakyMart demo site: the detective must
// name the right root cause for each planted bug, and must NOT accuse the stable test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { investigate } from '../../src/detective.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = (file, variations, runs) => investigate({ target: `examples/flaky/${file}`, variations, runs, outDir: `.ftd-it/${file}`, cwd: root });
const summary = (r) => `${r.analysis.title}: ${r.analysis.verdict} ${r.heuristic.cause} — ${r.analysis.variations.map((v) => `${v.name} ${v.failures}/${v.runs}`).join(', ')}`;

test('race.spec.js → ASYNC_WAIT (slow network significantly worse than baseline)', async () => {
  const [r] = (await run('race.spec.js', 'slow-network', 8)).results;
  assert.equal(r.analysis.verdict, 'flaky', summary(r));
  assert.equal(r.heuristic.cause, 'ASYNC_WAIT', summary(r));
  const slow = r.analysis.variations.find((v) => v.name === 'slow-network');
  assert.equal(slow.rate, 1, summary(r));
  assert.ok(slow.significant);
  assert.ok(r.heuristic.smells.some((s) => s.id === 'hard-wait'));
  assert.ok(r.traces.length > 0, 'failing runs keep a Playwright trace');
});

test('cart.spec.js → SHARED_STATE for both tests (only parallel runs fail)', async () => {
  const inv = await run('cart.spec.js', 'parallel', 8);
  assert.equal(inv.results.length, 2);
  for (const r of inv.results) {
    assert.equal(r.analysis.verdict, 'flaky', summary(r));
    assert.equal(r.heuristic.cause, 'SHARED_STATE', summary(r));
    assert.equal(r.analysis.baseline.failures, 0, summary(r));
  }
});

test('greeting.spec.js → TIME_DEPENDENT (morning clock fails, evening clock passes)', async () => {
  const [r] = (await run('greeting.spec.js', 'clock-morning,clock-evening', 3)).results;
  assert.equal(r.heuristic.cause, 'TIME_DEPENDENT', summary(r));
  const by = Object.fromEntries(r.analysis.variations.map((v) => [v.name, v]));
  assert.equal(by['clock-morning'].rate, 1);
  assert.equal(by['clock-evening'].rate, 0);
  assert.match(r.analysis.errorClusters[0].received[0], /Good morning/);
});

test('order.spec.js → NONDETERMINISTIC_DATA (fails everywhere, assertion receives different products)', async () => {
  const [r] = (await run('order.spec.js', 'slow-network,parallel', 6)).results;
  assert.equal(r.analysis.verdict, 'flaky', summary(r));
  assert.equal(r.heuristic.cause, 'NONDETERMINISTIC_DATA', summary(r));
  assert.ok(r.analysis.errorClusters[0].received.length >= 2, 'several different first products observed');
});

test('toast.spec.js → flaky, attributed to waiting/timing', async () => {
  const [r] = (await run('toast.spec.js', 'slow-network', 6)).results;
  assert.equal(r.analysis.verdict, 'flaky', summary(r));
  assert.ok(['ASYNC_WAIT', 'TIMING'].includes(r.heuristic.cause), summary(r));
});

test('stable.spec.js → STABLE under every default variation (no false accusation)', async () => {
  const [r] = (await run('stable.spec.js', undefined, 2)).results;
  assert.equal(r.analysis.verdict, 'stable', summary(r));
  assert.equal(r.analysis.variations.length, 6);
  assert.equal(r.heuristic.cause, 'STABLE');
});
