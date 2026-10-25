// Builders for synthetic Playwright JSON reports and attempts, so the analysis
// pipeline can be tested deterministically without a browser.
import { VARIATIONS } from '../src/variations.js';

export const variation = (name) => ({ name, ...VARIATIONS[name] });

/** Build a Playwright-JSON-shaped report from a list of {title, status, message?, received?} */
export function fakeReport(results, { file = 'flaky/demo.spec.js', rootDir = '/repo/examples', signals } = {}) {
  const byTitle = new Map();
  for (const r of results) {
    if (!byTitle.has(r.title)) byTitle.set(r.title, []);
    byTitle.get(r.title).push(r);
  }
  return {
    config: { rootDir },
    suites: [
      {
        title: file,
        file,
        specs: [...byTitle.entries()].map(([title, rs], i) => ({
          title,
          file,
          line: 3 + i * 10,
          tests: [
            {
              results: rs.map((r) => ({
                status: r.status,
                duration: r.duration ?? (r.status === 'passed' ? 900 : 1600),
                workerIndex: 0,
                startTime: '2026-10-25T10:00:00.000Z',
                errors: r.status === 'failed' ? [{ message: r.message ?? `Error: expect(received).toBe(expected)\n\nExpected: ${r.expected ?? 5}\nReceived: ${r.received ?? 0}`, location: { file, line: 8 } }] : [],
                attachments: [
                  ...(signals ? [{ name: 'ftd-signals', contentType: 'application/json', body: Buffer.from(JSON.stringify(signals)).toString('base64') }] : []),
                  ...(r.status === 'failed' ? [{ name: 'trace', contentType: 'application/zip', path: `/tmp/trace-${i}.zip` }] : []),
                ],
              })),
            },
          ],
        })),
      },
    ],
  };
}

/** Attempts for one test: spec = { variationName: [passes, failures] } */
export function makeAttempts(spec, { title = 'demo test', received = () => '0', expected = '5', kind } = {}) {
  const out = [];
  for (const [name, [passes, failures]] of Object.entries(spec)) {
    const v = VARIATIONS[name];
    let idx = 0;
    const push = (status) =>
      out.push({
        key: `demo.spec.js::${title}`,
        file: 'demo.spec.js',
        title,
        line: 3,
        variation: name,
        dimension: v.dimension,
        index: idx++,
        status,
        durationMs: status === 'passed' ? 1000 : 2000,
        error:
          status === 'failed'
            ? { message: `Expected: ${expected}\nReceived: ${received(idx)}`, kind: kind ?? 'assertion', signature: `toBe | expected ${expected}`, expected, received: received(idx), location: null }
            : null,
        signals: null,
      });
    for (let i = 0; i < passes; i++) push('passed');
    for (let i = 0; i < failures; i++) push('failed');
  }
  return { key: `demo.spec.js::${title}`, file: 'demo.spec.js', title, line: 3, attempts: out };
}

/** A fake Anthropic client: replies are returned in order. */
export function fakeClient(...replies) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(req) {
        calls.push(req);
        const r = replies[Math.min(calls.length - 1, replies.length - 1)];
        if (r instanceof Error) throw r;
        return { content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }], usage: { input_tokens: 100, output_tokens: 50 } };
      },
    },
  };
}

export const goodDiagnosis = (fixed_source = 'fixed();\n') => ({
  category: 'ASYNC_WAIT',
  title: 'Hard sleep races the products API',
  explanation: 'Fails 100% under slow-network vs 0% baseline.',
  evidence: ['slow-network 6/6 vs baseline 0/6'],
  confidence: 0.9,
  fix_summary: 'Use toHaveCount',
  fixed_source,
});
