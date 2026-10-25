# 🔎 Flaky Test Detective

**Stop rerunning flaky tests. Find out *why* they flake — with evidence — and get a verified fix.**

Most "flaky test" tools stop at *detection*: they rerun a test, notice it sometimes fails, and quarantine it.
Flaky Test Detective does the part engineers actually spend their time on — **root-cause analysis**:

1. **Reruns** a Playwright test many times under **controlled variations**, changing one thing at a time:
   network latency, CPU throttling, parallel workers, frozen clocks and timezones.
2. **Measures** the failure rate per variation and uses **Fisher's exact test** to decide which variation
   *really* changes the outcome (Wilson intervals keep small samples honest).
3. **Collects evidence** from every run: error clusters, expected-vs-received values, network timings,
   DOM at failure, Playwright traces, and static anti-patterns in the test code.
4. **Diagnoses** the root cause — with a rule-based classifier out of the box, and with **Claude**
   when `ANTHROPIC_API_KEY` is set.
5. **Fixes and proves it**: Claude rewrites the test, the detective re-runs it under *the same variations*,
   keeps the fix only if the flakiness is gone (otherwise rolls back), and can **open a pull request**
   with the evidence in the description.

```
🔎 Investigating examples/flaky — 6 runs per variation, Claude OFF (rule-based)
  ▸ baseline       done in 49.7s
  ▸ slow-network   done in 138.8s
  ▸ cpu-throttle   done in 56.6s
  ▸ parallel       done in 29.8s
  ▸ clock-morning  done in 55.2s
  ▸ clock-evening  done in 45.7s

🟠 first product in the catalog is Arduino Uno
   FLAKY 42% (15/36) → Assumes a data order the app does not guarantee
🟠 adding a product shows a confirmation toast
   FLAKY 28% (10/36) → Race with asynchronous loading
🟠 header greets the engineer
   FLAKY 17% (6/36) → Depends on wall-clock time or timezone
🟠 catalog shows all 5 products
   FLAKY 17% (6/36) → Race with asynchronous loading
🟠 cart keeps one item after reload
   FLAKY 11% (4/36) → Shared state between tests (isolation leak)
🟠 cart keeps two items after reload
   FLAKY 11% (4/36) → Shared state between tests (isolation leak)
🟢 search filters the catalog
   STABLE 0% (0/36) → Stable — no failures observed
```

## Root causes it can tell apart

| Cause | Evidence that convicts it | Typical fix |
|---|---|---|
| `ASYNC_WAIT` | failure rate jumps under **slow-network**; hard sleeps / one-shot reads in code | web-first assertions (`toHaveCount`, `toBeVisible`) |
| `TIMING` | failure rate jumps under **cpu-throttle** | wait for the UI state, not a duration |
| `SHARED_STATE` | fails only with **parallel** workers, or passes once then fails on every repeat | per-test data (ids from `testInfo`) |
| `TIME_DEPENDENT` | **clock-morning** and **clock-evening** disagree | `page.clock.setFixedTime()` |
| `NONDETERMINISTIC_DATA` | fails at the same rate everywhere, assertion *receives* different values | deterministic ordering / set assertions |
| `BROKEN` | fails every time — not flaky, a real bug | fix the app or the test |

## Quick start

```bash
npm install
npx playwright install chromium

# investigate the bundled demo suite (starts the FlakyMart demo shop automatically)
npm run demo
open ftd-report/index.html

# with Claude: diagnosis + automatic fix + verification
export ANTHROPIC_API_KEY=sk-ant-...
npx ftd investigate examples/flaky/race.spec.js --fix

# open a PR for verified fixes (needs git remote + GitHub CLI)
npx ftd investigate tests/checkout.spec.ts --pr
```

### Using it on your own suite

Swap one import so the detective can inject variations and record signals (it behaves exactly like
Playwright when the detective is not running):

```diff
- import { test, expect } from '@playwright/test';
+ import { test, expect } from 'flaky-test-detective/fixture';
```

Then:

```bash
npx ftd investigate tests/ -g "checkout" -n 10 -v slow-network,parallel,clock-morning
```

### Against a real public website

`examples/external/saucedemo.spec.js` targets [saucedemo.com](https://www.saucedemo.com), whose
`performance_glitch_user` logs in slowly — a real-world source of flakiness:

```bash
BASE_URL=https://www.saucedemo.com npx ftd investigate examples/external -n 5
```

## CLI

```
ftd investigate <test-file-or-dir> [options]
  -g, --grep <regex>        only tests whose title matches
  -c, --config <file>       Playwright config file
  -n, --runs <n>            runs per variation (default 8)
  -v, --variations <list>   baseline,slow-network,fast-network,cpu-throttle,parallel,
                            clock-morning,clock-evening,tz-far-west
  -o, --out <dir>           report directory (default ftd-report)
      --fix                 let Claude rewrite the test, then re-run to verify
      --pr                  commit verified fixes on a branch and open a PR (gh)
      --model <id>          Claude model (default $FTD_MODEL or claude-sonnet-5-5)
      --context <text>      extra application context for Claude
      --max-diagnoses <n>   at most n Claude calls (worst tests first) — caps API cost
      --fail-on-flaky       exit 1 if any flaky test is found (for CI)
ftd variations              list variations
```

Outputs: `index.html` (heatmap report), `report.md` (CI summary / PR comment), `report.json` (machine-readable).

## Architecture

```
bin/ftd.js          CLI
src/variations.js   variation catalog → Playwright CLI args + env
src/fixture.js      Playwright fixture: applies latency (route), CPU throttle (CDP),
                    clock/timezone; records network timings, console errors, DOM at failure
src/runner.js       runs each variation (injectable process spawner)
src/collect.js      Playwright JSON → attempts; error kind/signature/expected/received
src/stats.js        Wilson CI, Fisher exact test, error clustering, sequence-leak detection
src/classify.js     dynamic evidence + static code smells → ranked root causes
src/claude.js       evidence-rich prompt, strict JSON parsing, retry on malformed output
src/patch.js        apply fix with backup, unified diff, git branch/commit, gh PR
src/detective.js    orchestrator: rerun → analyse → diagnose → fix → verify → PR
src/report.js       HTML / Markdown / JSON reports
demo-site/          FlakyMart: a demo shop with planted flakiness
examples/flaky      flaky tests (one per root cause) + a stable control
examples/fixed      reference fixes
```

## Tests

```bash
npm test                  # 84 unit tests — deterministic, no browser
npm run test:integration  # 14 real-browser tests against the demo site
```

The integration suite proves that each variation really perturbs the browser (latency ≥600 ms,
CPU work measurably slower, frozen clock, timezone), that every planted flaky test is attributed
to the right root cause while the stable test is never accused, and that the fix loop keeps a
correct fix and rolls back a fake one.

## CI and token cost

The GitHub workflow is built to spend almost no Claude tokens:

| Job | When | Claude calls |
|---|---|---|
| Unit tests | every push to main and every PR | 0 |
| Integration tests (real browser) | pushes to main and manual runs | 0 (scripted Claude stand-in) |
| Detective demo | **manual only** (Actions → CI → Run workflow) | 0 by default; **1** Haiku call if you tick *use_claude* |

To enable the optional Claude call, add `ANTHROPIC_API_KEY` under Settings → Secrets and variables → Actions.
Locally you can cap spend the same way: `--max-diagnoses 1` and `FTD_MODEL=claude-haiku-5-5`.

## License

MIT
