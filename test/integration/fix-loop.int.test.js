// Real browser: the detect → fix → verify loop. Claude is replaced by a scripted
// client (so this runs offline and in CI), but everything else is real: the fix is
// written to disk and re-run under the same variations before it is accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { investigate } from '../../src/detective.js';
import { fakeClient, goodDiagnosis } from '../helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const work = path.join(root, 'examples', '.ftd-it'); // same depth as examples/flaky, so imports resolve
const target = path.join(work, 'race.spec.js');
const flakySrc = () => readFile(path.join(root, 'examples/flaky/race.spec.js'), 'utf8');
const fixedSrc = () => readFile(path.join(root, 'examples/fixed/race.spec.js'), 'utf8');

test.beforeEach(async () => {
  await mkdir(work, { recursive: true });
  await writeFile(target, await flakySrc());
});
test.after(() => rm(work, { recursive: true, force: true }));

test('a correct fix is applied, re-verified under every variation, and kept', async () => {
  const client = fakeClient(goodDiagnosis(await fixedSrc()));
  const inv = await investigate({ target: 'examples/.ftd-it/race.spec.js', variations: 'slow-network', runs: 5, outDir: '.ftd-it/fix-ok', cwd: root, client, fix: true });
  const [r] = inv.results;
  assert.equal(r.analysis.verdict, 'flaky');
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].messages[0].content, /\| slow-network \| network \| 5\/5 \| 100%/, 'Claude saw the real evidence');
  assert.equal(r.fix.status, 'verified', JSON.stringify(r.fix.verification?.variations));
  assert.equal(r.fix.verification.overall.failures, 0);
  assert.equal(r.fix.verification.overall.runs, 10);
  assert.equal(await readFile(target, 'utf8'), await fixedSrc());
  await access(`${target}.ftd-backup`);
});

test('a fix that does not cure the flakiness is rejected and the original is restored', async () => {
  const notAFix = (await flakySrc()).replace('waitForTimeout(500)', 'waitForTimeout(550)');
  const inv = await investigate({ target: 'examples/.ftd-it/race.spec.js', variations: 'slow-network', runs: 5, outDir: '.ftd-it/fix-bad', cwd: root, client: fakeClient(goodDiagnosis(notAFix)), fix: true });
  const [r] = inv.results;
  assert.equal(r.fix.status, 'rejected');
  assert.ok(r.fix.verification.overall.failures > 0);
  assert.equal(await readFile(target, 'utf8'), await flakySrc(), 'original restored');
});
