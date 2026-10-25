import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { toHtml, toMarkdown, writeReports, esc, sortResults } from '../../src/report.js';
import { analyzeTest } from '../../src/stats.js';
import { classify } from '../../src/classify.js';
import { resolveVariations } from '../../src/variations.js';
import { makeAttempts, goodDiagnosis } from '../helpers.js';

function investigation() {
  const flaky = analyzeTest(makeAttempts({ baseline: [6, 0], 'slow-network': [0, 6] }, { title: 'catalog <shows> all' }));
  const stable = analyzeTest(makeAttempts({ baseline: [6, 0], 'slow-network': [6, 0] }, { title: 'search works' }));
  return {
    target: 'examples/flaky',
    runsPerVariation: 6,
    variations: resolveVariations('slow-network').map(({ name, description, dimension }) => ({ name, description, dimension })),
    claude: { enabled: true },
    durationMs: 12_000,
    generatedAt: '2026-10-25T17:00:00.000Z',
    results: [
      { analysis: stable, heuristic: classify(stable), diagnosis: null, fix: null, traces: [] },
      {
        analysis: flaky,
        heuristic: classify(flaky),
        diagnosis: goodDiagnosis(),
        fix: { status: 'verified', diff: '--- a\n+++ b\n-old\n+new\n', verification: stable, pr: { prUrl: 'https://github.com/u/r/pull/9' } },
        traces: ['/tmp/trace.zip'],
      },
    ],
  };
}

test('esc escapes HTML special characters', () => {
  assert.equal(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('sortResults puts flaky first, stable last', () => {
  assert.deepEqual(sortResults(investigation().results).map((r) => r.analysis.verdict), ['flaky', 'stable']);
});

test('HTML report: summary counts, heatmap cells with significance, escaped titles, fix diff, PR link, trace command', () => {
  const html = toHtml(investigation());
  assert.match(html, /<b>2<\/b><span>tests investigated/);
  assert.match(html, /catalog &lt;shows&gt; all/);
  assert.ok(!html.includes('catalog <shows> all'), 'no HTML injection from test titles');
  assert.match(html, /class="cell sig"[^>]*>100%<small>6\/6/);
  assert.match(html, /Hard sleep races the products API/);
  assert.match(html, /<span class="badge verified">verified<\/span>/);
  assert.match(html, /<span class="add">\+new<\/span>/);
  assert.match(html, /https:\/\/github.com\/u\/r\/pull\/9/);
  assert.match(html, /npx playwright show-trace \/tmp\/trace.zip/);
  assert.match(html, /prefers-color-scheme:dark/);
});

test('Markdown report: summary table and per-test detail with diff block', () => {
  const md = toMarkdown(investigation());
  assert.match(md, /\| catalog <shows> all \| flaky \| 50% \(6\/12\) \| ASYNC_WAIT — Hard sleep races the products API \| 90% \|/);
  assert.match(md, /\| search works \| stable \| 0% \(0\/12\)/);
  assert.match(md, /Fix: \*\*verified\*\* \(after fix: 0\/12 failures\)/);
  assert.match(md, /```diff\n--- a/);
  assert.ok(!/## search works/.test(md), 'stable tests get no detail section');
});

test('writeReports writes JSON, Markdown and HTML', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ftd-rep-'));
  const files = await writeReports(investigation(), dir);
  const json = JSON.parse(await readFile(files.json, 'utf8'));
  assert.equal(json.results.length, 2);
  assert.match(await readFile(files.html, 'utf8'), /^<!doctype html>/);
  assert.match(await readFile(files.markdown, 'utf8'), /^# 🔎 Flaky Test Detective report/);
  await rm(dir, { recursive: true, force: true });
});

// ── CLI ───────────────────────────────────────────────────────────────────────
const run = promisify(execFile);
const CLI = new URL('../../bin/ftd.js', import.meta.url).pathname;
const cli = (args, env = {}) =>
  run(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } }).then(
    (r) => ({ code: 0, ...r }),
    (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
  );

test('CLI: --help and no command print usage', async () => {
  for (const args of [['--help'], []]) {
    const r = await cli(args);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /ftd investigate <test-file-or-dir>/);
  }
});

test('CLI: `variations` lists every variation with its dimension', async () => {
  const r = await cli(['variations']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /slow-network\s+network/);
  assert.match(r.stdout, /parallel\s+isolation/);
});

test('CLI: bad usage exits 2; --fix without an API key exits 2 with guidance', async () => {
  assert.equal((await cli(['frobnicate'])).code, 2);
  assert.equal((await cli(['investigate'])).code, 2);
  const r = await cli(['investigate', 'examples/flaky', '--fix'], { ANTHROPIC_API_KEY: '' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /set ANTHROPIC_API_KEY/);
});

test('CLI: unknown variation is reported as an error', async () => {
  const r = await cli(['investigate', 'x', '-v', 'turbo', '-n', '1'], { ANTHROPIC_API_KEY: '' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Unknown variation\(s\): turbo/);
});
