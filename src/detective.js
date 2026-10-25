// Orchestrator: rerun → collect → analyse → classify → (Claude) diagnose → fix → verify → PR.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveVariations } from './variations.js';
import { runVariations } from './runner.js';
import { collectAttempts, groupByTest } from './collect.js';
import { analyzeTest, fisherExact } from './stats.js';
import { classify } from './classify.js';
import { diagnose } from './claude.js';
import { applyFix, restoreBackup, openPullRequest, prBody } from './patch.js';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function readSource(absFile, file, cwd, testDir) {
  for (const candidate of [absFile, path.join(cwd, testDir || '', file), path.join(cwd, file)].filter(Boolean)) {
    try {
      return { path: candidate, source: await readFile(candidate, 'utf8') };
    } catch {
      /* try next */
    }
  }
  return { path: null, source: '' };
}

/** Decide whether a re-run after a fix is good enough to keep the fix. */
export function judgeVerification(before, after) {
  if (after.overall.failures === 0) return 'verified';
  const p = fisherExact(after.overall.failures, after.overall.runs - after.overall.failures, before.overall.failures, before.overall.runs - before.overall.failures);
  if (after.overall.rate < before.overall.rate && p < 0.05) return 'improved';
  return 'rejected';
}

/**
 * @param {object} o
 * @param {string} o.target               test file or directory
 * @param {string} [o.grep]
 * @param {number} [o.runs=8]
 * @param {string|string[]} [o.variations]
 * @param {string} [o.outDir='ftd-report']
 * @param {string} [o.cwd]
 * @param {string} [o.testDir='examples']  Playwright testDir (to resolve report-relative files)
 * @param {object|null} [o.client]       Anthropic client (null → heuristic only)
 * @param {boolean} [o.fix]  apply Claude's fix
 * @param {boolean} [o.verify] re-run after fixing (implied by fix)
 * @param {boolean} [o.pr]   open a PR for verified fixes
 */
export async function investigate(o) {
  const {
    target,
    grep,
    runs = 8,
    outDir = 'ftd-report',
    cwd = process.cwd(),
    testDir = 'examples',
    client = null,
    fix = false,
    pr = false,
    exec,
    prExec,
    onProgress = () => {},
    appContext,
    model,
    config,
  } = o;
  const variations = resolveVariations(o.variations);
  const started = Date.now();

  const raw = await runVariations({ target, grep, runs, variations, outDir, cwd, exec, onProgress, config });
  const attempts = collectAttempts(raw);
  const tests = groupByTest(attempts);
  if (!tests.length) throw new Error(`No tests were executed for "${target}"${grep ? ` matching "${grep}"` : ''}`);

  const results = [];
  for (const t of tests) {
    const analysis = analyzeTest(t);
    const { path: sourcePath, source } = await readSource(t.absFile, t.file, cwd, testDir);
    const heuristic = classify(analysis, source);
    const entry = { analysis, heuristic, sourcePath, diagnosis: null, fix: null, traces: t.attempts.filter((a) => a.trace).slice(0, 3).map((a) => a.trace) };

    if (analysis.verdict === 'flaky' && client) {
      onProgress({ phase: 'diagnose', test: t.title });
      try {
        entry.diagnosis = await diagnose({ client, model, analysis, heuristic, source, attempts: t.attempts, appContext });
      } catch (e) {
        entry.diagnosisError = e.message;
      }
    }

    if (fix && entry.diagnosis && sourcePath && entry.diagnosis.fixed_source.trim() !== source.trim()) {
      onProgress({ phase: 'fix', test: t.title });
      const applied = await applyFix(sourcePath, entry.diagnosis.fixed_source);
      entry.fix = { diff: applied.diff, status: 'applied' };

      onProgress({ phase: 'verify', test: t.title });
      const reRaw = await runVariations({
        target: path.relative(cwd, sourcePath),
        grep: `^.*${escapeRegex(t.title.split(' › ').pop())}$`,
        runs,
        variations,
        outDir: path.join(outDir, 'verify'),
        cwd,
        exec,
        onProgress,
        config,
      });
      const reTests = groupByTest(collectAttempts(reRaw));
      const after = reTests.length ? analyzeTest(reTests[0]) : null;
      entry.fix.verification = after;
      entry.fix.status = after ? judgeVerification(analysis, after) : 'rejected';
      if (entry.fix.status === 'rejected') {
        await restoreBackup(sourcePath, applied.backup);
        entry.fix.restored = true;
      } else if (pr) {
        onProgress({ phase: 'pr', test: t.title });
        entry.fix.pr = await openPullRequest({
          cwd,
          file: sourcePath,
          title: t.title,
          body: prBody({ analysis, heuristic, diagnosis: entry.diagnosis, verification: after }),
          exec: prExec,
        });
      }
    }
    results.push(entry);
  }

  return {
    tool: 'flaky-test-detective',
    version: '0.1.0',
    target,
    runsPerVariation: runs,
    variations: variations.map((v) => ({ name: v.name, description: v.description, dimension: v.dimension })),
    claude: client ? { enabled: true, model: model || undefined } : { enabled: false },
    durationMs: Date.now() - started,
    generatedAt: new Date().toISOString(),
    results,
  };
}
