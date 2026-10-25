// Real browser: proves each controlled variation actually changes what the page experiences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVariations } from '../../src/runner.js';
import { collectAttempts } from '../../src/collect.js';
import { resolveVariations } from '../../src/variations.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let probes;

function probeOf(report) {
  const res = report.suites[0].specs[0].tests[0].results[0];
  const a = res.attachments.find((x) => x.name === 'probe');
  return JSON.parse(Buffer.from(a.body, 'base64').toString());
}

test.before(async () => {
  const variations = resolveVariations('slow-network,cpu-throttle,clock-morning,clock-evening,tz-far-west');
  const raw = await runVariations({ target: 'test/integration/probe', config: 'test/integration/probe/playwright.config.js', runs: 1, variations, outDir: '.ftd-it/probe', cwd: root });
  probes = Object.fromEntries(raw.map((r) => [r.variation.name, { probe: probeOf(r.report), attempt: collectAttempts([r])[0] }]));
});

test('baseline is unperturbed', () => {
  assert.deepEqual(probes.baseline.attempt.signals.appliedPerturbations, []);
  assert.equal(probes.baseline.attempt.status, 'passed');
});

test('slow-network adds 600ms+ to every API request', () => {
  const { attempt, probe } = probes['slow-network'];
  assert.deepEqual(attempt.signals.appliedPerturbations, ['latency 600-1200ms']);
  const api = attempt.signals.requests.filter((r) => r.url.startsWith('/api/'));
  assert.ok(api.length >= 1, 'API requests recorded');
  assert.ok(api.every((r) => r.ms >= 600), `all API requests ≥600ms: ${api.map((r) => r.ms)}`);
  assert.ok(probe.loadMs > probes.baseline.probe.loadMs, 'page became ready later');
});

test('cpu-throttle makes the same JS work measurably slower', () => {
  const { attempt, probe } = probes['cpu-throttle'];
  assert.deepEqual(attempt.signals.appliedPerturbations, ['cpu x6']);
  assert.ok(probe.workMs > probes.baseline.probe.workMs * 2, `${probe.workMs.toFixed(0)}ms vs ${probes.baseline.probe.workMs.toFixed(0)}ms`);
});

test('clock-morning / clock-evening freeze the browser clock and change time-dependent UI', () => {
  assert.equal(probes['clock-morning'].probe.hour, 9);
  assert.equal(probes['clock-morning'].probe.greeting, 'Good morning, engineer');
  assert.equal(probes['clock-evening'].probe.hour, 21);
  assert.equal(probes['clock-evening'].probe.greeting, 'Good evening, engineer');
});

test('tz-far-west changes the browser timezone', () => {
  assert.equal(probes['tz-far-west'].probe.tz, 'Pacific/Honolulu');
  assert.notEqual(probes.baseline.probe.tz, 'Pacific/Honolulu');
});

test('every run records network signals and a variation tag', () => {
  for (const [name, { attempt }] of Object.entries(probes)) {
    assert.equal(attempt.variation, name);
    assert.equal(attempt.signals.variation, name);
    assert.ok(attempt.signals.requests.some((r) => r.url === '/api/products'), name);
  }
});
