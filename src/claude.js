// Claude diagnosis: gives the model the *evidence* (variation matrix, error
// clusters, network timings from passing vs failing runs, DOM at failure, code
// smells, the rule-based hypothesis) plus the test source, and asks for a root
// cause and a corrected test file as strict JSON.

export const DEFAULT_MODEL = process.env.FTD_MODEL || 'claude-sonnet-5-5';

export const SYSTEM_PROMPT = `You are a senior SDET who specialises in diagnosing flaky end-to-end tests.
You receive statistical evidence from re-running ONE Playwright test many times under controlled variations
(network latency, CPU throttling, parallel workers, frozen clocks, timezones). Reason from that evidence,
not from guesses. Distinguish a flaky TEST from a flaky APPLICATION.

Rules for the fix:
- Fix the test, not the application, unless the evidence shows an app bug (then say so and still return the test unchanged).
- Prefer Playwright web-first assertions (expect(locator).toHaveCount/toHaveText/toBeVisible/toHaveClass) over sleeps or one-shot reads.
- Never "fix" flakiness with retries, longer timeouts or waitForTimeout.
- Keep the test's intent and imports exactly; change as little as possible.

Respond with ONLY a JSON object, no prose, matching:
{
  "category": "ASYNC_WAIT" | "TIMING" | "SHARED_STATE" | "TIME_DEPENDENT" | "NONDETERMINISTIC_DATA" | "APP_BUG" | "UNKNOWN",
  "title": string,                 // one line
  "explanation": string,           // 2-5 sentences, cite the evidence
  "evidence": string[],            // the specific numbers/signals you relied on
  "confidence": number,            // 0..1
  "fix_summary": string,           // one sentence
  "fixed_source": string           // the COMPLETE corrected test file
}`;

const pct = (x) => `${Math.round(x * 100)}%`;

function summariseSignals(attempts) {
  const pick = (status) => attempts.find((a) => a.status === status && a.signals);
  const fmt = (a) =>
    a
      ? {
          variation: a.variation,
          durationMs: a.durationMs,
          perturbations: a.signals.appliedPerturbations,
          requests: a.signals.requests.slice(0, 12),
          consoleErrors: a.signals.consoleErrors.slice(0, 5),
          pageErrors: a.signals.pageErrors.slice(0, 5),
          domAtFailure: a.signals.domAtFailure ?? undefined,
        }
      : null;
  return { samplePassingRun: fmt(pick('passed')), sampleFailingRun: fmt(pick('failed')) };
}

/** Build the user message. Pure function — unit tested. */
export function buildPrompt({ analysis, heuristic, source, attempts = [], appContext }) {
  const table = analysis.variations
    .map((v) => `| ${v.name} | ${v.dimension} | ${v.failures}/${v.runs} | ${pct(v.rate)} | ${v.name === 'baseline' ? '—' : v.pValue.toFixed(3)} | ${v.significant ? 'YES' : 'no'} |`)
    .join('\n');
  const clusters = analysis.errorClusters
    .slice(0, 4)
    .map((c) => `- [${c.kind}] x${c.count} in {${c.variations.join(', ')}}: ${c.signature}${c.received.length ? ` (received: ${c.received.slice(0, 5).join(', ')})` : ''}`)
    .join('\n');

  return `## Test under investigation
File: ${analysis.file}
Title: ${analysis.title}
Verdict: ${analysis.verdict} — ${analysis.overall.failures}/${analysis.overall.runs} runs failed (95% CI ${pct(analysis.overall.ci.low)}–${pct(analysis.overall.ci.high)})

## Variation matrix (Fisher exact test vs baseline)
| variation | dimension | failed | rate | p | significant |
|---|---|---|---|---|---|
${table}

## Error clusters
${clusters || '(none)'}

## Timing
Median duration — passing: ${analysis.durations.passMedianMs ?? 'n/a'} ms, failing: ${analysis.durations.failMedianMs ?? 'n/a'} ms
Pass-then-fail-on-repeat pattern: ${analysis.sequenceLeak ? 'YES' : 'no'}

## Runtime signals (network requests are ms from test start)
${JSON.stringify(summariseSignals(attempts), null, 2)}

## Static code smells
${heuristic.smells.map((s) => `- line ${s.lines.join(',')}: ${s.message}`).join('\n') || '(none)'}

## Rule-based hypothesis (may be wrong)
${heuristic.cause} (${heuristic.label}), confidence ${heuristic.confidence}
${heuristic.evidence.map((e) => `- ${e}`).join('\n')}
${appContext ? `\n## Application context\n${appContext}\n` : ''}
## Test source
\`\`\`js
${source}
\`\`\``;
}

/** Extract the JSON object from a model reply (tolerates code fences / stray prose). */
export function parseDiagnosis(text) {
  if (!text || typeof text !== 'string') throw new Error('Empty response from Claude');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  let candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON object in Claude response');
  candidate = candidate.slice(start, end + 1);
  let obj;
  try {
    obj = JSON.parse(candidate);
  } catch (e) {
    throw new Error(`Claude response is not valid JSON: ${e.message}`);
  }
  for (const field of ['category', 'title', 'explanation', 'fixed_source']) {
    if (typeof obj[field] !== 'string' || !obj[field].trim()) throw new Error(`Claude response missing "${field}"`);
  }
  obj.confidence = Math.max(0, Math.min(1, Number(obj.confidence) || 0));
  obj.evidence = Array.isArray(obj.evidence) ? obj.evidence.map(String) : [];
  obj.fix_summary = String(obj.fix_summary || '');
  return obj;
}

/** Create a Messages API client lazily (so the tool works without the SDK/key). */
export async function defaultClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic();
}

/**
 * Ask Claude for a diagnosis. `client` must expose messages.create (the Anthropic SDK shape).
 * Retries once with the parse error fed back if the first reply is malformed.
 */
export async function diagnose({ client, model = DEFAULT_MODEL, ...promptInput }) {
  if (!client) return null;
  const messages = [{ role: 'user', content: buildPrompt(promptInput) }];
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client.messages.create({ model, max_tokens: 4000, system: SYSTEM_PROMPT, messages });
    const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    try {
      return { ...parseDiagnosis(text), model, usage: res.usage ?? null };
    } catch (e) {
      lastError = e;
      messages.push({ role: 'assistant', content: text || '(empty)' });
      messages.push({ role: 'user', content: `That reply could not be parsed (${e.message}). Reply with ONLY the JSON object.` });
    }
  }
  throw lastError;
}
