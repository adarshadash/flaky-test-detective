import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VARIATIONS, DEFAULT_VARIATIONS, resolveVariations, toPlaywrightArgs, currentVariation, fixedTimeToDate } from '../../src/variations.js';

test('every variation declares a dimension, description, cli and env', () => {
  for (const [name, v] of Object.entries(VARIATIONS)) {
    assert.ok(v.description, `${name} description`);
    assert.ok(['control', 'network', 'cpu', 'isolation', 'time'].includes(v.dimension), `${name} dimension`);
    assert.equal(typeof v.cli, 'object');
    assert.equal(typeof v.env, 'object');
  }
});

test('the default set covers network, CPU, isolation and time — the four flakiness dimensions', () => {
  const dims = new Set(resolveVariations().map((v) => v.dimension));
  for (const d of ['control', 'network', 'cpu', 'isolation', 'time']) assert.ok(dims.has(d), d);
  assert.deepEqual(resolveVariations().map((v) => v.name), DEFAULT_VARIATIONS);
});

test('resolveVariations accepts a comma string, always adds baseline first and de-duplicates', () => {
  const list = resolveVariations('parallel, slow-network,parallel');
  assert.deepEqual(list.map((v) => v.name), ['baseline', 'parallel', 'slow-network']);
});

test('resolveVariations rejects unknown names and empty lists', () => {
  assert.throws(() => resolveVariations('baseline,warp-speed'), /Unknown variation\(s\): warp-speed/);
  assert.throws(() => resolveVariations(''), /At least one variation/);
});

test('toPlaywrightArgs: baseline runs serially with repeat, traces and JSON output', () => {
  const { args, env } = toPlaywrightArgs({ name: 'baseline', ...VARIATIONS.baseline }, { file: 'a.spec.js', runs: 7, reportFile: '/r.json' });
  assert.deepEqual(args.slice(0, 3), ['playwright', 'test', 'a.spec.js']);
  assert.ok(args.includes('--repeat-each=7'));
  assert.ok(args.includes('--workers=1'));
  assert.ok(args.includes('--retries=0'), 'retries must be off or flakiness is hidden');
  assert.ok(args.includes('--trace=retain-on-failure'));
  assert.ok(!args.includes('--fully-parallel'));
  assert.equal(env.PLAYWRIGHT_JSON_OUTPUT_NAME, '/r.json');
  assert.deepEqual(JSON.parse(env.FTD_VARIATION), { name: 'baseline' });
});

test('toPlaywrightArgs: parallel variation uses 4 workers and --fully-parallel; grep/config/project pass through', () => {
  const { args } = toPlaywrightArgs({ name: 'parallel', ...VARIATIONS.parallel }, { runs: 2, grep: 'cart', config: 'pw.config.js', project: 'chromium' });
  assert.ok(args.includes('--workers=4'));
  assert.ok(args.includes('--fully-parallel'));
  assert.deepEqual(args.slice(args.indexOf('--grep'), args.indexOf('--grep') + 2), ['--grep', 'cart']);
  assert.deepEqual(args.slice(args.indexOf('--config'), args.indexOf('--config') + 2), ['--config', 'pw.config.js']);
  assert.ok(args.includes('chromium'));
});

test('toPlaywrightArgs: runtime perturbations travel to the fixture through FTD_VARIATION', () => {
  const slow = JSON.parse(toPlaywrightArgs({ name: 'slow-network', ...VARIATIONS['slow-network'] }, { runs: 1 }).env.FTD_VARIATION);
  assert.deepEqual(slow.latencyMs, [600, 1200]);
  const cpu = JSON.parse(toPlaywrightArgs({ name: 'cpu-throttle', ...VARIATIONS['cpu-throttle'] }, { runs: 1 }).env.FTD_VARIATION);
  assert.equal(cpu.cpuThrottle, 6);
  const tz = JSON.parse(toPlaywrightArgs({ name: 'tz-far-west', ...VARIATIONS['tz-far-west'] }, { runs: 1 }).env.FTD_VARIATION);
  assert.equal(tz.timezoneId, 'Pacific/Honolulu');
});

test('currentVariation reads env, defaults to baseline, rejects malformed JSON', () => {
  assert.deepEqual(currentVariation({}), { name: 'baseline' });
  assert.deepEqual(currentVariation({ FTD_VARIATION: '{"name":"x","cpuThrottle":4}' }), { name: 'x', cpuThrottle: 4 });
  assert.throws(() => currentVariation({ FTD_VARIATION: '{oops' }), /not valid JSON/);
});

test('fixedTimeToDate sets the local hour/minute and validates input', () => {
  const d = fixedTimeToDate('21:05');
  assert.equal(d.getHours(), 21);
  assert.equal(d.getMinutes(), 5);
  assert.equal(fixedTimeToDate('9:00').getHours(), 9);
  assert.throws(() => fixedTimeToDate('25:00'), /out of range/);
  assert.throws(() => fixedTimeToDate('noon'), /HH:MM/);
});
