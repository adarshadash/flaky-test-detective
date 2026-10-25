// Controlled variations: each one perturbs exactly one dimension of the test
// environment, so a change in failure rate can be attributed to that dimension.
//
// A variation has two halves:
//   • `cli`  – extra Playwright CLI flags (workers, repeat, parallelism)
//   • `env`  – runtime perturbations applied *inside the browser* by the
//              detective fixture (network latency, CPU throttle, clock, tz)

export const VARIATIONS = {
  baseline: {
    description: 'Unmodified run, 1 worker. The control group.',
    dimension: 'control',
    cli: { workers: 1 },
    env: {},
  },
  'slow-network': {
    description: 'Adds 600–1200 ms latency to every network response.',
    dimension: 'network',
    cli: { workers: 1 },
    env: { latencyMs: [600, 1200] },
  },
  'fast-network': {
    description: 'Zero added latency but responses are released in a burst — exposes waits that assume slowness.',
    dimension: 'network',
    cli: { workers: 1 },
    env: { latencyMs: [0, 0] },
  },
  'cpu-throttle': {
    description: '6× CPU slowdown via Chrome DevTools Protocol — exposes animation and render timing.',
    dimension: 'cpu',
    cli: { workers: 1 },
    env: { cpuThrottle: 6 },
  },
  parallel: {
    description: '4 workers, fully parallel — exposes shared state between tests.',
    dimension: 'isolation',
    cli: { workers: 4, fullyParallel: true },
    env: {},
  },
  'clock-morning': {
    description: 'Browser clock frozen at 09:00 local time.',
    dimension: 'time',
    cli: { workers: 1 },
    env: { fixedTime: '09:00' },
  },
  'clock-evening': {
    description: 'Browser clock frozen at 21:00 local time.',
    dimension: 'time',
    cli: { workers: 1 },
    env: { fixedTime: '21:00' },
  },
  'tz-far-west': {
    description: 'Browser timezone set to Pacific/Honolulu (UTC−10).',
    dimension: 'time',
    cli: { workers: 1 },
    env: { timezoneId: 'Pacific/Honolulu' },
  },
};

export const DEFAULT_VARIATIONS = ['baseline', 'slow-network', 'cpu-throttle', 'parallel', 'clock-morning', 'clock-evening'];

/** Resolve a comma list / array of names into variation objects (with names). */
export function resolveVariations(names = DEFAULT_VARIATIONS) {
  const list = typeof names === 'string' ? names.split(',').map((s) => s.trim()).filter(Boolean) : names;
  if (!list.length) throw new Error('At least one variation is required');
  const unknown = list.filter((n) => !VARIATIONS[n]);
  if (unknown.length) {
    throw new Error(`Unknown variation(s): ${unknown.join(', ')}. Known: ${Object.keys(VARIATIONS).join(', ')}`);
  }
  if (!list.includes('baseline')) list.unshift('baseline'); // always keep a control group
  return [...new Set(list)].map((name) => ({ name, ...VARIATIONS[name] }));
}

/** Build the Playwright CLI args for one variation. */
export function toPlaywrightArgs(variation, { file, grep, runs, reportFile, project, config } = {}) {
  const args = ['playwright', 'test'];
  if (config) args.push('--config', config);
  if (file) args.push(file);
  if (grep) args.push('--grep', grep);
  if (project) args.push('--project', project);
  args.push(`--repeat-each=${runs}`);
  args.push(`--workers=${variation.cli.workers ?? 1}`);
  if (variation.cli.fullyParallel) args.push('--fully-parallel');
  args.push('--retries=0', '--trace=retain-on-failure', '--reporter=json');
  return { args, env: { FTD_VARIATION: JSON.stringify({ name: variation.name, ...variation.env }), PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile } };
}

/** Parse the variation the fixture should apply (from env). */
export function currentVariation(env = process.env) {
  if (!env.FTD_VARIATION) return { name: 'baseline' };
  try {
    return JSON.parse(env.FTD_VARIATION);
  } catch {
    throw new Error(`FTD_VARIATION is not valid JSON: ${env.FTD_VARIATION}`);
  }
}

/** Convert "HH:MM" into a Date today (local to the *browser* timezone is handled by Playwright clock). */
export function fixedTimeToDate(hhmm, base = new Date('2026-01-15T00:00:00')) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m) throw new Error(`fixedTime must be HH:MM, got ${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`fixedTime out of range: ${hhmm}`);
  const d = new Date(base);
  d.setHours(h, min, 0, 0);
  return d;
}
