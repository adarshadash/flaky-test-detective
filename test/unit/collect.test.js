import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, errorKind, expectedReceived, errorSignature, collectAttempts, groupByTest } from '../../src/collect.js';
import { fakeReport, variation } from '../helpers.js';

test('stripAnsi removes terminal colour codes', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[39m plain'), 'red plain');
});

test('errorKind recognises the common Playwright failure shapes', () => {
  assert.equal(errorKind('Test timeout of 15000ms exceeded.'), 'test-timeout');
  assert.equal(errorKind('Error: strict mode violation: getByRole resolved to 2 elements'), 'strict-locator');
  assert.equal(errorKind('Error: expect(locator).toHaveText(expected) failed\n\nLocator: x\nTimeout: 1000ms'), 'assertion-timeout');
  assert.equal(errorKind('locator.click: Timeout 5000ms exceeded.\nwaiting for getByTestId(\'x\')'), 'action-timeout');
  assert.equal(errorKind('page.goto: net::ERR_CONNECTION_REFUSED'), 'network-error');
  assert.equal(errorKind('Error: Execution context was destroyed, most likely because of a navigation'), 'detached-or-navigated');
  assert.equal(errorKind('Error: expect(received).toBe(expected)\nExpected: 5\nReceived: 0'), 'assertion');
  assert.equal(errorKind('TypeError: x is undefined'), 'other');
});

test('expectedReceived extracts values, including ANSI-coloured ones', () => {
  assert.deepEqual(expectedReceived('Expected: \u001b[32m5\u001b[39m\nReceived: \u001b[31m0\u001b[39m'), { expected: '5', received: '0' });
  assert.deepEqual(expectedReceived('Expected string: "a"\nReceived string: "b"'), { expected: '"a"', received: '"b"' });
  assert.deepEqual(expectedReceived('boom'), { expected: null, received: null });
});

test('errorSignature clusters identical failures even when timings differ', () => {
  const a = errorSignature('Timeout 1000ms exceeded\nExpected: 5\nReceived: 0');
  const b = errorSignature('Timeout 2500ms exceeded\nExpected: 5\nReceived: 3');
  assert.equal(a, b);
  assert.match(a, /expected 5/);
});

test('collectAttempts flattens reports, tags variation, counts repeats and reads signals/traces', () => {
  const signals = { variation: 'slow-network', requests: [{ url: '/api/products', ms: 900 }], consoleErrors: [], pageErrors: [], appliedPerturbations: ['latency 600-1200ms'] };
  const raw = [
    { variation: variation('baseline'), report: fakeReport([{ title: 't', status: 'passed' }, { title: 't', status: 'passed' }]) },
    { variation: variation('slow-network'), report: fakeReport([{ title: 't', status: 'failed' }, { title: 't', status: 'skipped' }, { title: 't', status: 'timedOut' }], { signals }) },
  ];
  const attempts = collectAttempts(raw);
  assert.equal(attempts.length, 4, 'skipped results are ignored');
  const slow = attempts.filter((a) => a.variation === 'slow-network');
  assert.deepEqual(slow.map((a) => a.index), [0, 1]);
  assert.deepEqual(slow.map((a) => a.rawStatus), ['failed', 'timedOut']);
  assert.ok(slow.every((a) => a.status === 'failed'), 'timedOut counts as failed');
  assert.equal(slow[0].dimension, 'network');
  assert.equal(slow[0].error.expected, '5');
  assert.equal(slow[0].error.received, '0');
  assert.equal(slow[0].trace, '/tmp/trace-0.zip');
  assert.deepEqual(slow[0].signals.appliedPerturbations, ['latency 600-1200ms']);
  assert.equal(slow[0].absFile, '/repo/examples/flaky/demo.spec.js');
  assert.equal(attempts[0].error, null);
});

test('collectAttempts walks nested describe blocks into a readable title path', () => {
  const report = {
    config: { rootDir: '/r' },
    suites: [{ title: 'a.spec.js', file: 'a.spec.js', suites: [{ title: 'Cart', file: 'a.spec.js', specs: [{ title: 'adds', line: 4, tests: [{ results: [{ status: 'passed', duration: 10, attachments: [] }] }] }] }] }],
  };
  const [a] = collectAttempts([{ variation: variation('baseline'), report }]);
  assert.equal(a.title, 'Cart › adds');
});

test('collectAttempts tolerates a corrupt signals attachment', () => {
  const report = fakeReport([{ title: 't', status: 'passed' }]);
  report.suites[0].specs[0].tests[0].results[0].attachments.push({ name: 'ftd-signals', body: Buffer.from('{bad').toString('base64') });
  const [a] = collectAttempts([{ variation: variation('baseline'), report }]);
  assert.equal(a.signals, null);
});

test('groupByTest groups attempts per test across variations', () => {
  const raw = [
    { variation: variation('baseline'), report: fakeReport([{ title: 'a', status: 'passed' }, { title: 'b', status: 'failed' }]) },
    { variation: variation('parallel'), report: fakeReport([{ title: 'a', status: 'failed' }, { title: 'b', status: 'passed' }]) },
  ];
  const groups = groupByTest(collectAttempts(raw));
  assert.deepEqual(groups.map((g) => [g.title, g.attempts.length]), [['a', 2], ['b', 2]]);
});
