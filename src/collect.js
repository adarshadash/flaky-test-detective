// Turns raw Playwright JSON reports into flat "attempt" records, one per test
// execution, tagged with the variation that produced it.

const ANSI = /\u001b\[[0-9;]*m/g;
export const stripAnsi = (s = '') => String(s).replace(ANSI, '');

/** Classify the *shape* of an error message (independent of the test). */
export function errorKind(message = '') {
  const m = stripAnsi(message);
  if (/Test timeout of \d+ms exceeded/i.test(m)) return 'test-timeout';
  if (/strict mode violation/i.test(m)) return 'strict-locator';
  if (/Timed out \d+ms waiting for expect|waiting for expect/i.test(m) || (/expect\(locator\)/.test(m) && /Timeout:? \d+ms/i.test(m))) return 'assertion-timeout';
  if (/waiting for (locator|getBy|selector)|locator\.\w+: Timeout/i.test(m)) return 'action-timeout';
  if (/net::ERR_|ECONNREFUSED|ECONNRESET|socket hang up/i.test(m)) return 'network-error';
  if (/Target (page|closed)|has been closed|detached from the DOM|Execution context was destroyed/i.test(m)) return 'detached-or-navigated';
  if (/expect\(|Expected|toBe|toEqual|toHave/i.test(m)) return 'assertion';
  return 'other';
}

/** Extract `Expected:` / `Received:` values from a Playwright assertion message. */
export function expectedReceived(message = '') {
  const m = stripAnsi(message);
  const exp = /Expected(?: string| pattern| value)?:\s*(.+)/.exec(m);
  const rec = /Received(?: string| value)?:\s*(.+)/.exec(m);
  return { expected: exp ? exp[1].trim() : null, received: rec ? rec[1].trim() : null };
}

/** A stable fingerprint so identical failures cluster together across runs. */
export function errorSignature(message = '') {
  const m = stripAnsi(message).split('\n');
  const first = (m[0] || '').replace(/\d+ms/g, 'Nms').trim();
  const { expected } = expectedReceived(message);
  return expected ? `${first} | expected ${expected}` : first;
}

function* walkSpecs(suite, parents = []) {
  const titlePath = suite.title && !suite.file?.endsWith(suite.title) ? [...parents, suite.title] : parents;
  for (const spec of suite.specs || []) yield { spec, titlePath, file: suite.file || spec.file };
  for (const child of suite.suites || []) yield* walkSpecs(child, titlePath);
}

function readSignals(attachments = []) {
  const a = attachments.find((x) => x.name === 'ftd-signals' && x.body);
  if (!a) return null;
  try {
    return JSON.parse(Buffer.from(a.body, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** Flatten runVariations() output into attempt records. */
export function collectAttempts(variationResults) {
  const attempts = [];
  for (const { variation, report } of variationResults) {
    const rootDir = report.config?.rootDir || '';
    const indexByTest = new Map();
    for (const top of report.suites || []) {
      for (const { spec, titlePath, file } of walkSpecs(top)) {
        const title = [...titlePath, spec.title].join(' › ');
        const key = `${file}::${title}`;
        for (const t of spec.tests || []) {
          for (const r of t.results || []) {
            if (r.status === 'skipped') continue;
            const idx = indexByTest.get(key) ?? 0;
            indexByTest.set(key, idx + 1);
            const err = r.errors?.[0] || r.error || null;
            const trace = r.attachments?.find((x) => x.name === 'trace' && x.path)?.path ?? null;
            attempts.push({
              key,
              file,
              absFile: rootDir ? `${rootDir}/${file}`.replace(/\\/g, '/') : file,
              title,
              line: spec.line,
              variation: variation.name,
              dimension: variation.dimension,
              index: idx,
              status: r.status === 'passed' ? 'passed' : 'failed',
              rawStatus: r.status,
              durationMs: r.duration,
              workerIndex: r.workerIndex,
              startTime: r.startTime,
              error: err
                ? {
                    message: stripAnsi(err.message || '').slice(0, 4000),
                    kind: errorKind(err.message),
                    signature: errorSignature(err.message),
                    ...expectedReceived(err.message),
                    location: err.location || r.errorLocation || null,
                  }
                : null,
              trace,
              signals: readSignals(r.attachments),
            });
          }
        }
      }
    }
  }
  return attempts;
}

/** Group attempts by test key. */
export function groupByTest(attempts) {
  const map = new Map();
  for (const a of attempts) {
    if (!map.has(a.key)) map.set(a.key, { key: a.key, file: a.file, absFile: a.absFile, title: a.title, line: a.line, attempts: [] });
    map.get(a.key).attempts.push(a);
  }
  return [...map.values()];
}
