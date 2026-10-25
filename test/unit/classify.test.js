import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify, detectSmells, CAUSES } from '../../src/classify.js';
import { analyzeTest } from '../../src/stats.js';
import { makeAttempts } from '../helpers.js';

const src = (name, dir = 'flaky') => readFileSync(new URL(`../../examples/${dir}/${name}.spec.js`, import.meta.url), 'utf8');

test('detectSmells finds every anti-pattern planted in the demo tests', () => {
  const ids = (name) => detectSmells(src(name)).map((s) => s.id);
  assert.deepEqual(ids('race').sort(), ['hard-wait', 'one-shot-read']);
  assert.ok(ids('toast').includes('hard-wait'));
  assert.ok(ids('toast').includes('one-shot-read'));
  assert.ok(ids('order').includes('positional-locator'));
  assert.ok(ids('cart').includes('global-reset'));
  assert.ok(ids('greeting').includes('time-literal'));
  assert.deepEqual(ids('stable'), []);
});

test('detectSmells reports the line numbers', () => {
  const [s] = detectSmells('a\nawait page.waitForTimeout(500)\nb');
  assert.equal(s.id, 'hard-wait');
  assert.deepEqual(s.lines, [2]);
});

test('the reference fixes are free of the smells that made the originals flaky', () => {
  assert.deepEqual(detectSmells(src('race', 'fixed')), []);
  assert.ok(!detectSmells(src('toast', 'fixed')).some((s) => s.id === 'hard-wait'));
  assert.ok(!detectSmells(src('cart', 'fixed')).some((s) => s.id === 'global-reset'));
});

test('STABLE when nothing failed', () => {
  const r = classify(analyzeTest(makeAttempts({ baseline: [6, 0], parallel: [6, 0] })), src('stable'));
  assert.equal(r.cause, 'STABLE');
  assert.equal(r.fix, null);
});

test('BROKEN when every run failed — reruns will not help', () => {
  const r = classify(analyzeTest(makeAttempts({ baseline: [0, 6], parallel: [0, 6] })));
  assert.equal(r.cause, 'BROKEN');
  assert.match(r.fix, /reruns will not help/);
});

test('ASYNC_WAIT when slow network significantly raises failures (+ hard-wait smell)', () => {
  const r = classify(analyzeTest(makeAttempts({ baseline: [6, 0], 'slow-network': [0, 6], 'cpu-throttle': [6, 0], parallel: [6, 0] })), src('race'));
  assert.equal(r.cause, 'ASYNC_WAIT');
  assert.ok(r.confidence >= 0.7, `confidence ${r.confidence}`);
  assert.ok(r.evidence.some((e) => /slow-network: 100% failure vs 0% baseline/.test(e)));
  assert.ok(r.evidence.some((e) => /Code smell/.test(e)));
});

test('TIMING when CPU throttling significantly raises failures', () => {
  const r = classify(analyzeTest(makeAttempts({ baseline: [8, 0], 'cpu-throttle': [1, 7], 'slow-network': [8, 0] })));
  assert.equal(r.cause, 'TIMING');
});

test('SHARED_STATE when only parallel runs fail', () => {
  const r = classify(analyzeTest(makeAttempts({ baseline: [6, 0], 'slow-network': [6, 0], parallel: [0, 6] })), src('cart'));
  assert.equal(r.cause, 'SHARED_STATE');
  assert.match(r.fix, /own data/);
});

test('SHARED_STATE from the pass-once-then-fail pattern even without parallelism', () => {
  const r = classify(analyzeTest(makeAttempts({ baseline: [1, 5], 'slow-network': [1, 5] })));
  assert.equal(r.cause, 'SHARED_STATE');
  assert.ok(r.evidence.some((e) => /first run/.test(e)));
});

test('TIME_DEPENDENT when frozen-clock variations disagree with each other', () => {
  const r = classify(analyzeTest(makeAttempts({ baseline: [6, 0], 'clock-morning': [0, 6], 'clock-evening': [6, 0] })), src('greeting'));
  assert.equal(r.cause, 'TIME_DEPENDENT');
  assert.ok(r.evidence.some((e) => /Time variations disagree/.test(e)));
});

test('NONDETERMINISTIC_DATA when failures are spread everywhere with varying received values', () => {
  const names = ['"BACnet Gateway"', '"CO2 Sensor"', '"ESP32 Board"'];
  const r = classify(
    analyzeTest(makeAttempts({ baseline: [2, 4], 'slow-network': [1, 5], parallel: [2, 4], 'clock-morning': [2, 4] }, { received: (i) => names[i % 3] })),
    src('order'),
  );
  assert.equal(r.cause, 'NONDETERMINISTIC_DATA');
  assert.ok(r.evidence.some((e) => /different values/.test(e)));
});

test('UNKNOWN when there is no usable evidence', () => {
  const r = classify(analyzeTest(makeAttempts({ baseline: [7, 1], parallel: [8, 0] })), '');
  assert.equal(r.cause, 'UNKNOWN');
  assert.equal(r.fix, CAUSES.UNKNOWN.fix);
});

test('ranked alternatives are returned so a reviewer can see the runner-up hypothesis', () => {
  const r = classify(analyzeTest(makeAttempts({ baseline: [6, 0], 'slow-network': [0, 6], parallel: [0, 6] })), '');
  assert.equal(r.ranked.length, 2);
  assert.deepEqual(r.ranked.map((x) => x.cause).sort(), ['ASYNC_WAIT', 'SHARED_STATE']);
  assert.ok(r.confidence < 0.6, 'two equally strong causes lower the confidence');
});

test('a non-significant trend plus a matching code smell is enough to name the cause (with lower confidence)', () => {
  const cart = readFileSync(new URL('../../examples/flaky/cart.spec.js', import.meta.url), 'utf8');
  const r = classify(analyzeTest(makeAttempts({ baseline: [5, 0], parallel: [2, 3] })), cart);
  assert.equal(r.cause, 'SHARED_STATE');
  assert.ok(r.evidence.some((e) => /^Trend: parallel 60% vs 0% baseline/.test(e)));
  assert.ok(r.confidence < 0.9);
});

test('a trend alone, without any supporting smell, is not enough', () => {
  const r = classify(analyzeTest(makeAttempts({ baseline: [5, 0], parallel: [3, 2] })), '');
  assert.equal(r.cause, 'UNKNOWN');
});
