#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { investigate } from '../src/detective.js';
import { defaultClient } from '../src/claude.js';
import { writeReports, sortResults } from '../src/report.js';
import { VARIATIONS, DEFAULT_VARIATIONS } from '../src/variations.js';

const HELP = `flaky-test-detective (ftd) — find out WHY a Playwright test is flaky

Usage:
  ftd investigate <test-file-or-dir> [options]
  ftd variations

Options:
  -g, --grep <regex>        only tests whose title matches
  -c, --config <file>       Playwright config file
  -n, --runs <n>            runs per variation (default 8)
  -v, --variations <list>   comma list (default ${DEFAULT_VARIATIONS.join(',')})
  -o, --out <dir>           report directory (default ftd-report)
      --fix                 let Claude rewrite the test, then re-run to verify
      --pr                  commit verified fixes on a branch and open a PR (gh)
      --model <id>          Claude model (default $FTD_MODEL or claude-sonnet-5-5)
      --context <text>      extra application context for Claude
      --fail-on-flaky       exit 1 if any flaky test is found (for CI)
  -h, --help

Claude diagnosis is enabled when ANTHROPIC_API_KEY is set; otherwise the
rule-based classifier still reports a root cause.`;

const ICON = { flaky: '🟠', broken: '🔴', stable: '🟢' };

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      grep: { type: 'string', short: 'g' },
      config: { type: 'string', short: 'c' },
      runs: { type: 'string', short: 'n', default: '8' },
      variations: { type: 'string', short: 'v' },
      out: { type: 'string', short: 'o', default: 'ftd-report' },
      fix: { type: 'boolean', default: false },
      pr: { type: 'boolean', default: false },
      model: { type: 'string' },
      context: { type: 'string' },
      'fail-on-flaky': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [cmd, target] = positionals;

  if (values.help || !cmd) return console.log(HELP), 0;
  if (cmd === 'variations') {
    for (const [name, v] of Object.entries(VARIATIONS)) console.log(`${name.padEnd(14)} ${v.dimension.padEnd(10)} ${v.description}`);
    return 0;
  }
  if (cmd !== 'investigate' || !target) {
    console.error(HELP);
    return 2;
  }

  const runs = Number(values.runs);
  const client = await defaultClient();
  if ((values.fix || values.pr) && !client) {
    console.error('--fix / --pr need Claude: set ANTHROPIC_API_KEY.');
    return 2;
  }
  console.log(`🔎 Investigating ${target} — ${runs} runs per variation, Claude ${client ? 'ON' : 'OFF (rule-based)'}`);

  const inv = await investigate({
    target,
    grep: values.grep,
    config: values.config,
    runs,
    variations: values.variations,
    outDir: values.out,
    client,
    fix: values.fix || values.pr,
    pr: values.pr,
    model: values.model,
    appContext: values.context,
    onProgress: (e) => {
      if (e.phase === 'start') process.stdout.write(`  ▸ ${e.variation.padEnd(14)} `);
      if (e.phase === 'done') console.log(`done in ${(e.wallMs / 1000).toFixed(1)}s`);
      if (e.phase === 'diagnose') console.log(`  🤖 Claude is diagnosing "${e.test}"`);
      if (e.phase === 'verify') console.log(`  🔁 Verifying fix for "${e.test}"`);
    },
  });

  const files = await writeReports(inv, values.out);
  console.log('');
  for (const r of sortResults(inv.results)) {
    const a = r.analysis;
    const cause = r.diagnosis ? r.diagnosis.title : r.heuristic.label;
    console.log(`${ICON[a.verdict]} ${a.title}`);
    console.log(`   ${a.verdict.toUpperCase()} ${Math.round(a.overall.rate * 100)}% (${a.overall.failures}/${a.overall.runs}) → ${cause}`);
    if (r.fix) console.log(`   fix: ${r.fix.status}${r.fix.pr?.prUrl ? ` · ${r.fix.pr.prUrl}` : ''}`);
  }
  console.log(`\nReport: ${path.resolve(files.html)}`);
  const flaky = inv.results.some((r) => r.analysis.verdict === 'flaky');
  return values['fail-on-flaky'] && flaky ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  },
);
