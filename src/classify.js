// Rule-based root-cause classifier. Combines two independent kinds of evidence:
//   1. dynamic — which controlled variation significantly changed the failure rate
//   2. static  — anti-patterns ("smells") found in the test source
// Claude later refines this, but the detective is useful even without an API key.

export const CAUSES = {
  ASYNC_WAIT: {
    label: 'Race with asynchronous loading',
    fix: 'Replace fixed sleeps / one-shot reads with web-first assertions that auto-retry, e.g. `await expect(locator).toHaveCount(n)` or `toBeVisible()`.',
  },
  TIMING: {
    label: 'Timing / animation sensitivity',
    fix: 'Wait for the UI state itself (class, visibility, text) with an auto-retrying assertion instead of assuming how long rendering or animation takes.',
  },
  SHARED_STATE: {
    label: 'Shared state between tests (isolation leak)',
    fix: 'Give each test its own data (unique session/user/cart id from testInfo) and never reset global resources other tests may be using.',
  },
  TIME_DEPENDENT: {
    label: 'Depends on wall-clock time or timezone',
    fix: 'Control time in the test with `page.clock.setFixedTime()` / `timezoneId`, then assert the expected value for that controlled time.',
  },
  NONDETERMINISTIC_DATA: {
    label: 'Assumes a data order the app does not guarantee',
    fix: 'Request a deterministic order (e.g. a sort parameter) or assert on the set of items instead of their position.',
  },
  UNKNOWN: {
    label: 'Unclassified intermittent failure',
    fix: 'Open the attached traces for failing runs and compare them with a passing run; enable Claude diagnosis for a deeper analysis.',
  },
};

const DIMENSION_TO_CAUSE = { network: 'ASYNC_WAIT', cpu: 'TIMING', isolation: 'SHARED_STATE', time: 'TIME_DEPENDENT' };

/** Static anti-pattern detection on the test source. */
export function detectSmells(source = '') {
  const smells = [];
  const add = (id, cause, message, re) => {
    const lines = [];
    source.split('\n').forEach((l, i) => re.test(l) && lines.push(i + 1));
    if (lines.length) smells.push({ id, cause, message, lines });
  };
  add('hard-wait', 'ASYNC_WAIT', 'Fixed sleep (waitForTimeout / setTimeout) used for synchronisation', /waitForTimeout\(|new Promise\(.*setTimeout/);
  add('one-shot-read', 'ASYNC_WAIT', 'Value read once (count/textContent/isVisible/evaluate) then asserted without retry', /await [^;]*\.(count|textContent|innerText|isVisible|isChecked|evaluate|getAttribute)\(/);
  add('positional-locator', 'NONDETERMINISTIC_DATA', 'Asserts on an item by position (.first/.nth/.last)', /\.(first|last|nth)\(/);
  // a constant URL (no ${…} interpolation) means every test hits the same resource
  add('global-reset', 'SHARED_STATE', 'Mutates a shared server resource with a constant URL', /request\.(delete|post|put)\(\s*(['"][^'"]*['"]|`[^`$]*`)\s*\)/);
  add('time-literal', 'TIME_DEPENDENT', 'Asserts on time-of-day / date-dependent text', /(good (morning|afternoon|evening)|today|tomorrow|yesterday|new Date\(\))/i);
  return smells;
}

/**
 * @param {object} analysis  output of analyzeTest()
 * @param {string} source    test file source (optional)
 * @returns {{cause, label, confidence, evidence[], fix, ranked[]}}
 */
export function classify(analysis, source = '') {
  const smells = detectSmells(source);
  if (analysis.verdict === 'stable') {
    return { cause: 'STABLE', label: 'Stable — no failures observed', confidence: 1, evidence: [`0 failures in ${analysis.overall.runs} runs`], fix: null, smells, ranked: [] };
  }
  if (analysis.verdict === 'broken') {
    const top = analysis.errorClusters[0];
    return {
      cause: 'BROKEN',
      label: 'Consistently failing — a real bug or outdated test, not flakiness',
      confidence: 0.95,
      evidence: [`Failed ${analysis.overall.runs}/${analysis.overall.runs} runs`, top ? `Error: ${top.signature}` : 'No error message'],
      fix: 'Fix the test or the application; reruns will not help.',
      smells,
      ranked: [],
    };
  }

  const scores = Object.fromEntries(Object.keys(CAUSES).map((k) => [k, { score: 0, evidence: [] }]));
  const pct = (x) => `${Math.round(x * 100)}%`;

  // 1. dynamic evidence
  for (const v of analysis.variations) {
    const cause = DIMENSION_TO_CAUSE[v.dimension];
    if (!cause) continue;
    if (!v.significant) {
      // A clear but not-yet-significant increase is weak evidence (a "trend"): it can
      // corroborate a code smell, but never wins on its own against significant evidence.
      if (v.lift >= 0.2) {
        scores[cause].score += v.lift;
        scores[cause].evidence.push(`Trend: ${v.name} ${pct(v.rate)} vs ${pct(analysis.baseline.rate)} baseline (p=${v.pValue.toFixed(2)}, more runs would confirm)`);
      }
      continue;
    }
    const weight = Math.abs(v.lift) * 3;
    scores[cause].score += weight;
    scores[cause].evidence.push(`${v.name}: ${pct(v.rate)} failure vs ${pct(analysis.baseline.rate)} baseline (p=${v.pValue.toFixed(3)})`);
  }
  // time variations that disagree *with each other* are strong evidence even if baseline matches one
  const timeVars = analysis.variations.filter((v) => v.dimension === 'time');
  if (timeVars.length >= 2) {
    const max = Math.max(...timeVars.map((v) => v.rate));
    const min = Math.min(...timeVars.map((v) => v.rate));
    if (max - min >= 0.5) {
      scores.TIME_DEPENDENT.score += (max - min) * 3;
      scores.TIME_DEPENDENT.evidence.push(`Time variations disagree: ${timeVars.map((v) => `${v.name} ${pct(v.rate)}`).join(', ')}`);
    }
  }
  if (analysis.sequenceLeak) {
    scores.SHARED_STATE.score += 2;
    scores.SHARED_STATE.evidence.push('Passes on the first run, then fails on every repeat — state leaks between runs');
  }

  // 2. failures spread evenly across all variations + varying "Received" → data nondeterminism
  const anySignificant = analysis.variations.some((v) => v.significant);
  const failingVars = analysis.variations.filter((v) => v.failures > 0).length;
  const received = new Set(analysis.errorClusters.flatMap((c) => c.received));
  if (!anySignificant && failingVars >= Math.ceil(analysis.variations.length * 0.6)) {
    scores.NONDETERMINISTIC_DATA.score += 1;
    scores.NONDETERMINISTIC_DATA.evidence.push(`Fails at a similar rate in ${failingVars}/${analysis.variations.length} variations — not caused by the environment`);
    if (received.size >= 2) {
      scores.NONDETERMINISTIC_DATA.score += 1;
      scores.NONDETERMINISTIC_DATA.evidence.push(`Assertion received ${received.size} different values: ${[...received].slice(0, 4).join(', ')}`);
    }
  }

  // 3. static evidence (smaller weight, but breaks ties and boosts matching dynamic evidence)
  for (const s of smells) {
    scores[s.cause].score += scores[s.cause].score > 0 ? 0.75 : 0.35;
    scores[s.cause].evidence.push(`Code smell (line ${s.lines.join(', ')}): ${s.message}`);
  }

  const ranked = Object.entries(scores)
    .filter(([k, v]) => k !== 'UNKNOWN' && v.score > 0)
    .sort((a, b) => b[1].score - a[1].score)
    .map(([cause, v]) => ({ cause, label: CAUSES[cause].label, score: +v.score.toFixed(2), evidence: v.evidence }));

  if (!ranked.length || ranked[0].score < 0.5) {
    return { cause: 'UNKNOWN', label: CAUSES.UNKNOWN.label, confidence: 0.2, evidence: ranked[0]?.evidence ?? [], fix: CAUSES.UNKNOWN.fix, smells, ranked };
  }
  const total = ranked.reduce((s, r) => s + r.score, 0);
  const top = ranked[0];
  return {
    cause: top.cause,
    label: top.label,
    confidence: +Math.min(0.95, (top.score / total) * Math.min(1, top.score / 2)).toFixed(2),
    evidence: top.evidence,
    fix: CAUSES[top.cause].fix,
    smells,
    ranked,
  };
}
