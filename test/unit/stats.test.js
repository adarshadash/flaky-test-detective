import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wilson, fisherExact, rateOf, analyzeTest } from '../../src/stats.js';
import { makeAttempts } from '../helpers.js';

const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('wilson interval matches reference values and stays within [0,1]', () => {
  const ci = wilson(5, 10);
  close(ci.low, 0.2366);
  close(ci.high, 0.7634);
  assert.deepEqual(wilson(0, 0), { low: 0, high: 1 });
  const zero = wilson(0, 20);
  assert.equal(zero.low, 0);
  assert.ok(zero.high > 0.1 && zero.high < 0.2, 'even 0/20 cannot rule out a ~16% failure rate');
  assert.equal(wilson(20, 20).high, 1);
});

test('fisherExact matches the textbook example and is symmetric', () => {
  // classic tea-tasting-style table [[1,9],[11,3]] → p ≈ 0.00276
  close(fisherExact(1, 9, 11, 3), 0.002759, 1e-5);
  close(fisherExact(11, 3, 1, 9), fisherExact(1, 9, 11, 3), 1e-12);
  assert.equal(fisherExact(3, 3, 3, 3), 1);
  assert.ok(fisherExact(6, 0, 0, 6) < 0.01);
  assert.ok(fisherExact(2, 4, 0, 6) > 0.05, '2/6 vs 0/6 is not enough evidence');
});

test('rateOf reports runs, failures, rate and CI', () => {
  const r = rateOf([{ status: 'failed' }, { status: 'passed' }, { status: 'passed' }, { status: 'failed' }]);
  assert.equal(r.runs, 4);
  assert.equal(r.failures, 2);
  assert.equal(r.rate, 0.5);
  assert.ok(r.ci.low < 0.5 && r.ci.high > 0.5);
});

test('analyzeTest: verdicts stable / broken / flaky', () => {
  assert.equal(analyzeTest(makeAttempts({ baseline: [8, 0], parallel: [8, 0] })).verdict, 'stable');
  assert.equal(analyzeTest(makeAttempts({ baseline: [0, 8], parallel: [0, 8] })).verdict, 'broken');
  assert.equal(analyzeTest(makeAttempts({ baseline: [7, 1], parallel: [8, 0] })).verdict, 'flaky');
});

test('analyzeTest marks only variations that differ significantly from baseline', () => {
  const a = analyzeTest(makeAttempts({ baseline: [8, 0], 'slow-network': [0, 8], 'cpu-throttle': [7, 1] }));
  const by = Object.fromEntries(a.variations.map((v) => [v.name, v]));
  assert.equal(by['slow-network'].significant, true);
  assert.equal(by['slow-network'].lift, 1);
  assert.ok(by['slow-network'].pValue < 0.001);
  assert.equal(by['cpu-throttle'].significant, false);
  assert.equal(by.baseline.significant, false);
  assert.equal(a.baseline.runs, 8);
});

test('analyzeTest clusters errors and keeps the distinct received values', () => {
  const names = ['B', 'C', 'D'];
  const a = analyzeTest(makeAttempts({ baseline: [2, 3], parallel: [2, 3] }, { received: (i) => names[i % 3], expected: 'A' }));
  assert.equal(a.errorClusters.length, 1);
  assert.equal(a.errorClusters[0].count, 6);
  assert.deepEqual(a.errorClusters[0].variations.sort(), ['baseline', 'parallel']);
  assert.ok(a.errorClusters[0].received.length >= 2);
});

test('analyzeTest compares pass vs fail durations', () => {
  const a = analyzeTest(makeAttempts({ baseline: [3, 3] }));
  assert.equal(a.durations.passMedianMs, 1000);
  assert.equal(a.durations.failMedianMs, 2000);
});

test('analyzeTest detects the pass-first-then-always-fail leak pattern', () => {
  assert.equal(analyzeTest(makeAttempts({ baseline: [1, 5] })).sequenceLeak, true);
  assert.equal(analyzeTest(makeAttempts({ baseline: [3, 3] })).sequenceLeak, false);
});
