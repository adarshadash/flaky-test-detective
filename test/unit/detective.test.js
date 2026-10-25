// Pipeline tests with a fake Playwright process: deterministic, no browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runVariations } from '../../src/runner.js';
import { investigate, judgeVerification } from '../../src/detective.js';
import { resolveVariations } from '../../src/variations.js';
import { analyzeTest } from '../../src/stats.js';
import { fakeReport, makeAttempts, fakeClient, goodDiagnosis } from '../helpers.js';

const FLAKY_SRC = "import { test, expect } from '../src/fixture.js';\ntest('catalog', async ({ page }) => {\n  await page.goto('/');\n  await page.waitForTimeout(300);\n  expect(await page.getByTestId('p').count()).toBe(5);\n});\n";
const FIXED_SRC = "import { test, expect } from '../src/fixture.js';\ntest('catalog', async ({ page }) => {\n  await page.goto('/');\n  await expect(page.getByTestId('p')).toHaveCount(5);\n});\n";

/**
 * Fake `npx playwright test`: decides pass/fail per variation, and reads the test
 * file so a fix written to disk changes the outcome (just like a real re-run).
 */
function fakePlaywright({ dir, behaviour }) {
  const calls = [];
  const exec = async (cmd, args, { env }) => {
    calls.push({ cmd, args, env });
    const variation = JSON.parse(env.FTD_VARIATION).name;
    const runs = Number(args.find((a) => a.startsWith('--repeat-each=')).split('=')[1]);
    const source = await readFile(path.join(dir, 'tests', 'demo.spec.js'), 'utf8');
    const results = Array.from({ length: runs }, (_, i) => ({ title: 'catalog', status: behaviour(variation, source, i) ? 'failed' : 'passed' }));
    await writeFile(env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify(fakeReport(results, { file: 'demo.spec.js', rootDir: path.join(dir, 'tests') })));
    return { code: results.some((r) => r.status === 'failed') ? 1 : 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ftd-pipe-'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'tests', 'demo.spec.js'), FLAKY_SRC);
  return dir;
}

// slow-network breaks the sleep-based version; the fixed version never fails
const raceBehaviour = (variation, source) => source.includes('waitForTimeout') && variation === 'slow-network';

test('runVariations runs every variation once with its own args/env and returns parsed reports', async () => {
  const dir = await project();
  const { exec, calls } = fakePlaywright({ dir, behaviour: raceBehaviour });
  const res = await runVariations({ target: 'tests', runs: 3, variations: resolveVariations('slow-network,parallel'), outDir: 'out', cwd: dir, exec });
  assert.deepEqual(res.map((r) => r.variation.name), ['baseline', 'slow-network', 'parallel']);
  assert.deepEqual(calls.map((c) => c.cmd), ['npx', 'npx', 'npx']);
  assert.ok(calls[2].args.includes('--workers=4'));
  assert.equal(res[1].exitCode, 1);
  assert.equal(res[1].report.suites[0].specs[0].tests[0].results.length, 3);
  await rm(dir, { recursive: true, force: true });
});

test('runVariations fails loudly when Playwright produces no report (e.g. syntax error)', async () => {
  const exec = async () => ({ code: 1, stdout: '', stderr: 'SyntaxError: Unexpected token' });
  const dir = await project();
  await assert.rejects(
    runVariations({ target: 'x', runs: 1, variations: resolveVariations('baseline'), outDir: 'o', cwd: dir, exec }),
    /no JSON report for variation "baseline" \(exit 1\)[\s\S]*SyntaxError/,
  );
  await assert.rejects(runVariations({ target: 'x', runs: 0, variations: [], outDir: 'o', cwd: dir, exec }), /positive integer/);
  await rm(dir, { recursive: true, force: true });
});

test('judgeVerification: verified / improved / rejected', () => {
  const before = analyzeTest(makeAttempts({ baseline: [4, 4], 'slow-network': [0, 8] }));
  assert.equal(judgeVerification(before, analyzeTest(makeAttempts({ baseline: [8, 0], 'slow-network': [8, 0] }))), 'verified');
  assert.equal(judgeVerification(before, analyzeTest(makeAttempts({ baseline: [8, 0], 'slow-network': [7, 1] }))), 'improved');
  assert.equal(judgeVerification(before, analyzeTest(makeAttempts({ baseline: [4, 4], 'slow-network': [1, 7] }))), 'rejected');
});

test('investigate (rules only): finds the flaky test and classifies it without Claude', async () => {
  const dir = await project();
  const { exec } = fakePlaywright({ dir, behaviour: raceBehaviour });
  const inv = await investigate({ target: 'tests', runs: 6, variations: 'slow-network,parallel', cwd: dir, testDir: 'tests', exec });
  assert.equal(inv.claude.enabled, false);
  assert.equal(inv.results.length, 1);
  const [r] = inv.results;
  assert.equal(r.analysis.verdict, 'flaky');
  assert.equal(r.heuristic.cause, 'ASYNC_WAIT');
  assert.equal(r.diagnosis, null);
  assert.equal(r.fix, null);
  assert.ok(r.traces.length > 0);
  await rm(dir, { recursive: true, force: true });
});

test('investigate --fix: Claude fix is applied, re-run under all variations, and verified', async () => {
  const dir = await project();
  const { exec, calls } = fakePlaywright({ dir, behaviour: raceBehaviour });
  const client = fakeClient(goodDiagnosis(FIXED_SRC));
  const progress = [];
  const inv = await investigate({ target: 'tests', runs: 6, variations: 'slow-network', cwd: dir, testDir: 'tests', exec, client, fix: true, onProgress: (e) => progress.push(e.phase) });
  const [r] = inv.results;
  assert.equal(r.diagnosis.category, 'ASYNC_WAIT');
  assert.equal(r.fix.status, 'verified');
  assert.equal(r.fix.verification.overall.failures, 0);
  assert.match(r.fix.diff, /\+  await expect\(page.getByTestId\('p'\)\).toHaveCount\(5\);/);
  assert.equal(await readFile(path.join(dir, 'tests', 'demo.spec.js'), 'utf8'), FIXED_SRC);
  assert.equal(calls.length, 4, '2 variations before + 2 for verification');
  assert.ok(calls[2].args.includes('--grep'));
  assert.deepEqual([...new Set(progress)], ['start', 'done', 'diagnose', 'fix', 'verify']);
  await rm(dir, { recursive: true, force: true });
});

test('investigate --fix: a fix that does not remove the flakiness is rejected and rolled back', async () => {
  const dir = await project();
  const { exec } = fakePlaywright({ dir, behaviour: raceBehaviour });
  const stillFlaky = FLAKY_SRC.replace('await page.goto', '// cosmetic change\n  await page.goto');
  const inv = await investigate({ target: 'tests', runs: 6, variations: 'slow-network', cwd: dir, testDir: 'tests', exec, client: fakeClient(goodDiagnosis(stillFlaky)), fix: true });
  const [r] = inv.results;
  assert.equal(r.fix.status, 'rejected');
  assert.equal(r.fix.restored, true);
  assert.equal(await readFile(path.join(dir, 'tests', 'demo.spec.js'), 'utf8'), FLAKY_SRC, 'original restored');
  await rm(dir, { recursive: true, force: true });
});

test('investigate --pr: verified fixes are handed to the PR step', async () => {
  const dir = await project();
  const { exec } = fakePlaywright({ dir, behaviour: raceBehaviour });
  const prCalls = [];
  const prExec = async (cmd, args) => {
    prCalls.push(`${cmd} ${args[0]}`);
    if (args[0] === 'remote') return { code: 0, stdout: 'origin', stderr: '' };
    if (cmd === 'gh') return { code: 0, stdout: 'https://github.com/u/r/pull/1', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const inv = await investigate({ target: 'tests', runs: 4, variations: 'slow-network', cwd: dir, testDir: 'tests', exec, prExec, client: fakeClient(goodDiagnosis(FIXED_SRC)), fix: true, pr: true });
  assert.equal(inv.results[0].fix.pr.prUrl, 'https://github.com/u/r/pull/1');
  assert.ok(prCalls.includes('gh pr'));
  await rm(dir, { recursive: true, force: true });
});

test('investigate: Claude is not called for stable tests, and API failures do not abort the run', async () => {
  const dir = await project();
  const stable = fakePlaywright({ dir, behaviour: () => false });
  const client = fakeClient(goodDiagnosis());
  const inv = await investigate({ target: 'tests', runs: 3, variations: 'baseline', cwd: dir, testDir: 'tests', exec: stable.exec, client });
  assert.equal(inv.results[0].analysis.verdict, 'stable');
  assert.equal(client.calls.length, 0);

  const flaky = fakePlaywright({ dir, behaviour: raceBehaviour });
  const inv2 = await investigate({ target: 'tests', runs: 3, variations: 'slow-network', cwd: dir, testDir: 'tests', exec: flaky.exec, client: fakeClient(new Error('rate limited')) });
  assert.equal(inv2.results[0].diagnosis, null);
  assert.match(inv2.results[0].diagnosisError, /rate limited/);
  await rm(dir, { recursive: true, force: true });
});

test('investigate: errors clearly when nothing matched', async () => {
  const dir = await project();
  const exec = async (c, a, { env }) => {
    await writeFile(env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify({ suites: [] }));
    return { code: 1, stdout: '', stderr: '' };
  };
  await assert.rejects(investigate({ target: 'tests', grep: 'nope', runs: 1, variations: 'baseline', cwd: dir, exec }), /No tests were executed for "tests" matching "nope"/);
  await rm(dir, { recursive: true, force: true });
});
