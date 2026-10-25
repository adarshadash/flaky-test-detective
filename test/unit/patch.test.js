import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { unifiedDiff, applyFix, restoreBackup, branchName, prBody, openPullRequest } from '../../src/patch.js';
import { spawnProcess } from '../../src/runner.js';
import { analyzeTest } from '../../src/stats.js';
import { classify } from '../../src/classify.js';
import { makeAttempts, goodDiagnosis } from '../helpers.js';

const tmp = () => mkdtemp(path.join(tmpdir(), 'ftd-'));
const hasGit = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

test('unifiedDiff returns empty string for identical input', () => {
  assert.equal(unifiedDiff('a\nb\n', 'a\nb\n'), '');
});

test('unifiedDiff produces a correct single-hunk diff', () => {
  const d = unifiedDiff('1\n2\n3\n4\n5', '1\n2\nTHREE\n4\n5', { fromFile: 'a/x', toFile: 'b/x', context: 1 });
  assert.equal(d, '--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\n 2\n-3\n+THREE\n 4\n');
});

test('unifiedDiff splits distant changes into separate hunks and merges close ones', () => {
  const old = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
  const far = old.replace('l2\n', 'X\n').replace('l25', 'Y');
  assert.equal((unifiedDiff(old, far).match(/^@@/gm) || []).length, 2);
  const near = old.replace('l2\n', 'X\n').replace('l5\n', 'Z\n');
  assert.equal((unifiedDiff(old, near).match(/^@@/gm) || []).length, 1);
});

test('unifiedDiff output applies cleanly with `git apply`', { skip: !hasGit }, async () => {
  const dir = await tmp();
  const before = "import { test } from 'x';\n\ntest('a', async () => {\n  await page.waitForTimeout(300);\n  expect(await n()).toBe(5);\n});\n";
  const after = "import { test } from 'x';\n\ntest('a', async () => {\n  await expect(loc).toHaveCount(5);\n});\n";
  await writeFile(path.join(dir, 'f.js'), before);
  await writeFile(path.join(dir, 'p.diff'), unifiedDiff(before, after, { fromFile: 'a/f.js', toFile: 'b/f.js' }));
  execFileSync('git', ['apply', 'p.diff'], { cwd: dir });
  assert.equal(await readFile(path.join(dir, 'f.js'), 'utf8'), after);
  await rm(dir, { recursive: true, force: true });
});

test('applyFix writes the new source, keeps a backup, and restoreBackup reverts', async () => {
  const dir = await tmp();
  const file = path.join(dir, 't.spec.js');
  await writeFile(file, 'old();\n');
  const res = await applyFix(file, 'new();');
  assert.equal(res.changed, true);
  assert.equal(await readFile(file, 'utf8'), 'new();\n', 'trailing newline added');
  assert.equal(await readFile(res.backup, 'utf8'), 'old();\n');
  assert.match(res.diff, /-old\(\);\n\+new\(\);/);
  await restoreBackup(file, res.backup);
  assert.equal(await readFile(file, 'utf8'), 'old();\n');
  await rm(dir, { recursive: true, force: true });
});

test('applyFix is a no-op when the source is unchanged', async () => {
  const dir = await tmp();
  const file = path.join(dir, 't.spec.js');
  await writeFile(file, 'same();\n');
  const res = await applyFix(file, 'same();\n');
  assert.deepEqual(res, { changed: false, diff: '', backup: null });
  await assert.rejects(access(`${file}.ftd-backup`));
  await rm(dir, { recursive: true, force: true });
});

test('branchName is a safe, bounded git ref', () => {
  assert.equal(branchName('Cart › keeps ONE item after reload!'), 'ftd/fix-cart-keeps-one-item-after-reload');
  assert.ok(branchName('x'.repeat(200)).length <= 'ftd/fix-'.length + 48);
});

test('prBody contains the evidence table, Claude explanation and verification result', () => {
  const analysis = analyzeTest(makeAttempts({ baseline: [6, 0], 'slow-network': [0, 6] }, { title: 'catalog' }));
  const after = analyzeTest(makeAttempts({ baseline: [6, 0], 'slow-network': [6, 0] }, { title: 'catalog' }));
  const body = prBody({ analysis, heuristic: classify(analysis), diagnosis: goodDiagnosis(), verification: after });
  assert.match(body, /Hard sleep races the products API/);
  assert.match(body, /\| slow-network \| 6\/6 \| 100% \| ⚠️ significant/);
  assert.match(body, /\*\*0\/12 failures\*\* \(was 6\/12\)/);
});

test('openPullRequest: skips outside a git repository', { skip: !hasGit }, async () => {
  const dir = await tmp();
  const res = await openPullRequest({ cwd: dir, file: path.join(dir, 'x.js'), title: 't', body: 'b' });
  assert.equal(res.skipped, 'not a git repository');
  await rm(dir, { recursive: true, force: true });
});

test('openPullRequest: commits the fix on a new branch in a real repo; no remote → no PR', { skip: !hasGit }, async () => {
  const dir = await tmp();
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ftd@example.com');
  git('config', 'user.name', 'ftd');
  const file = path.join(dir, 'a.spec.js');
  await writeFile(file, 'old();\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  await writeFile(file, 'new();\n');

  const res = await openPullRequest({ cwd: dir, file, title: 'catalog shows all 5 products', body: 'b' });
  assert.equal(res.branch, 'ftd/fix-catalog-shows-all-5-products');
  assert.equal(res.committed, true);
  assert.equal(res.skipped, 'no git remote configured');
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), res.branch);
  assert.match(git('log', '-1', '--pretty=%s'), /fix flaky "catalog shows all 5 products"/);
  assert.equal(git('status', '--porcelain'), '');
  await rm(dir, { recursive: true, force: true });
});

test('openPullRequest: pushes and calls `gh pr create` when a remote exists', async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'git' && args[0] === 'remote') return { code: 0, stdout: 'origin\n', stderr: '' };
    if (cmd === 'gh') return { code: 0, stdout: 'Creating pull request...\nhttps://github.com/u/r/pull/7\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const res = await openPullRequest({ cwd: '/repo', file: '/repo/a.spec.js', title: 'flaky one', body: 'evidence', exec });
  assert.equal(res.prUrl, 'https://github.com/u/r/pull/7');
  assert.ok(calls.includes('git push -u origin ftd/fix-flaky-one'));
  assert.ok(calls.some((c) => c.startsWith('gh pr create --title Fix flaky test: flaky one --body evidence')));
});

test('openPullRequest: reports (does not throw) when push is rejected', async () => {
  const exec = async (cmd, args) => {
    if (args[0] === 'remote') return { code: 0, stdout: 'origin\n', stderr: '' };
    if (args[0] === 'push') return { code: 1, stdout: '', stderr: 'permission denied' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const res = await openPullRequest({ cwd: '/r', file: '/r/a.js', title: 't', body: 'b', exec });
  assert.match(res.skipped, /push failed: permission denied/);
});

test('openPullRequest: throws a clear error if commit fails', async () => {
  const exec = async (cmd, args) => (args[0] === 'commit' ? { code: 1, stdout: 'nothing to commit', stderr: '' } : { code: 0, stdout: '', stderr: '' });
  await assert.rejects(openPullRequest({ cwd: '/r', file: '/r/a.js', title: 't', body: 'b', exec }), /git commit failed: nothing to commit/);
});

test('spawnProcess captures output and exit code', async () => {
  const r = await spawnProcess(process.execPath, ['-e', 'console.log("hi"); console.error("err"); process.exit(3)']);
  assert.deepEqual([r.code, r.stdout.trim(), r.stderr.trim()], [3, 'hi', 'err']);
});

test('spawnProcess kills commands that exceed the timeout', async () => {
  await assert.rejects(spawnProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], { timeoutMs: 200 }), /Timed out after 200ms/);
});
