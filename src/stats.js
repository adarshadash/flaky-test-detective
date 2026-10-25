// Statistics that turn "it fails sometimes" into evidence:
//   • Wilson score intervals for failure rates (honest with small samples)
//   • Fisher's exact test: is a variation's failure rate *really* different from baseline?
//   • error clustering and duration comparison between passing and failing runs

/** Wilson score 95% interval for k successes out of n. */
export function wilson(k, n, z = 1.96) {
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, round12((centre - margin) / denom)), high: Math.min(1, round12((centre + margin) / denom)) };
}

const round12 = (x) => Math.round(x * 1e12) / 1e12;

const logFact = (() => {
  const cache = [0];
  return (n) => {
    for (let i = cache.length; i <= n; i++) cache[i] = cache[i - 1] + Math.log(i);
    return cache[n];
  };
})();

/** Two-sided Fisher exact test p-value for the 2×2 table [[a,b],[c,d]]. */
export function fisherExact(a, b, c, d) {
  const n = a + b + c + d;
  const row1 = a + b;
  const col1 = a + c;
  const logP = (x) => {
    const y = row1 - x;
    const z = col1 - x;
    const w = n - row1 - z;
    if (y < 0 || z < 0 || w < 0) return -Infinity;
    return logFact(row1) + logFact(n - row1) + logFact(col1) + logFact(n - col1) - logFact(n) - logFact(x) - logFact(y) - logFact(z) - logFact(w);
  };
  const pObs = logP(a);
  let p = 0;
  const lo = Math.max(0, col1 - (n - row1));
  const hi = Math.min(row1, col1);
  for (let x = lo; x <= hi; x++) {
    const lp = logP(x);
    if (lp <= pObs + 1e-9) p += Math.exp(lp);
  }
  return Math.min(1, round12(p));
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function rateOf(attempts) {
  const runs = attempts.length;
  const failures = attempts.filter((a) => a.status === 'failed').length;
  return { runs, failures, rate: runs ? failures / runs : 0, ci: wilson(failures, runs) };
}

/** Full statistical profile of one test's attempts. */
export function analyzeTest(test, { alpha = 0.05 } = {}) {
  const { attempts } = test;
  const overall = rateOf(attempts);
  const byVar = new Map();
  for (const a of attempts) {
    if (!byVar.has(a.variation)) byVar.set(a.variation, []);
    byVar.get(a.variation).push(a);
  }
  const base = rateOf(byVar.get('baseline') || []);

  const variations = [...byVar.entries()].map(([name, list]) => {
    const r = rateOf(list);
    const p = name === 'baseline' ? 1 : fisherExact(r.failures, r.runs - r.failures, base.failures, base.runs - base.failures);
    return {
      name,
      dimension: list[0].dimension,
      ...r,
      lift: r.rate - base.rate,
      pValue: p,
      significant: name !== 'baseline' && p < alpha && r.rate !== base.rate,
    };
  });

  // Error clusters
  const clusters = new Map();
  for (const a of attempts.filter((x) => x.error)) {
    const sig = a.error.signature;
    if (!clusters.has(sig)) clusters.set(sig, { signature: sig, kind: a.error.kind, count: 0, variations: new Set(), received: new Set(), sample: a.error.message, location: a.error.location });
    const c = clusters.get(sig);
    c.count++;
    c.variations.add(a.variation);
    if (a.error.received) c.received.add(a.error.received);
  }
  const errorClusters = [...clusters.values()]
    .map((c) => ({ ...c, variations: [...c.variations], received: [...c.received] }))
    .sort((x, y) => y.count - x.count);

  // Duration: do failures take longer (timeouts) or shorter (early assertion)?
  const passDur = attempts.filter((a) => a.status === 'passed').map((a) => a.durationMs);
  const failDur = attempts.filter((a) => a.status === 'failed').map((a) => a.durationMs);

  // Sequence pattern within each variation: pass first, fail after → leaked state
  const sequenceLeak = [...byVar.values()].some((list) => {
    const ordered = [...list].sort((x, y) => x.index - y.index);
    return ordered.length >= 3 && ordered[0].status === 'passed' && ordered.slice(1).every((a) => a.status === 'failed');
  });

  let verdict = 'flaky';
  if (overall.failures === 0) verdict = 'stable';
  else if (overall.failures === overall.runs) verdict = 'broken';

  return {
    key: test.key,
    file: test.file,
    title: test.title,
    line: test.line,
    verdict,
    overall,
    baseline: base,
    variations,
    errorClusters,
    durations: { passMedianMs: median(passDur), failMedianMs: median(failDur) },
    sequenceLeak,
  };
}
