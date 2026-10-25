// Runs the target test(s) once per variation, `runs` times each, and returns the
// raw Playwright JSON reports. The process spawner is injectable so the pipeline
// can be unit-tested without launching browsers.
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { toPlaywrightArgs } from './variations.js';

export function spawnProcess(cmd, args, { cwd, env, timeoutMs = 15 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out after ${timeoutMs}ms: ${cmd} ${args.join(' ')}`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * @param {object} opts
 * @param {string} opts.target     test file or directory
 * @param {string} [opts.grep]     title filter
 * @param {number} opts.runs       repetitions per variation
 * @param {Array}  opts.variations resolved variation objects
 * @param {string} opts.outDir     where JSON reports go
 * @param {string} [opts.cwd]
 * @param {Function} [opts.exec]   (cmd, args, {cwd, env}) => {code, stdout, stderr}
 * @param {Function} [opts.onProgress]
 */
export async function runVariations({ target, grep, runs, variations, outDir, cwd = process.cwd(), exec = spawnProcess, onProgress = () => {}, project, config }) {
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`runs must be a positive integer, got ${runs}`);
  const reportsDir = path.resolve(cwd, outDir, 'raw');
  await rm(reportsDir, { recursive: true, force: true });
  await mkdir(reportsDir, { recursive: true });

  const results = [];
  for (const variation of variations) {
    const reportFile = path.join(reportsDir, `${variation.name}.json`);
    const { args, env } = toPlaywrightArgs(variation, { file: target, grep, runs, reportFile, project, config });
    onProgress({ phase: 'start', variation: variation.name });
    const t0 = Date.now();
    const proc = await exec('npx', args, { cwd, env });
    let report;
    try {
      report = JSON.parse(await readFile(reportFile, 'utf8'));
    } catch (e) {
      throw new Error(
        `Playwright produced no JSON report for variation "${variation.name}" (exit ${proc.code}).\n${(proc.stderr || proc.stdout || '').slice(-2000)}`,
      );
    }
    results.push({ variation, report, exitCode: proc.code, wallMs: Date.now() - t0 });
    onProgress({ phase: 'done', variation: variation.name, wallMs: Date.now() - t0 });
  }
  return results;
}
