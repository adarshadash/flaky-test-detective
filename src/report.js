// Writes the investigation as JSON (machine), Markdown (CI summary / PR comment)
// and a single self-contained HTML page (humans).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const pct = (x) => `${Math.round((x || 0) * 100)}%`;
export const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const VERDICT_ORDER = { flaky: 0, broken: 1, stable: 2 };
export const sortResults = (results) => [...results].sort((a, b) => VERDICT_ORDER[a.analysis.verdict] - VERDICT_ORDER[b.analysis.verdict] || b.analysis.overall.rate - a.analysis.overall.rate);

export function toMarkdown(inv) {
  const lines = [`# 🔎 Flaky Test Detective report`, '', `Target \`${inv.target}\` · ${inv.runsPerVariation} runs × ${inv.variations.length} variations · Claude ${inv.claude.enabled ? 'on' : 'off'}`, ''];
  lines.push('| Test | Verdict | Failure rate | Root cause | Confidence |', '|---|---|---|---|---|');
  for (const r of sortResults(inv.results)) {
    const cause = r.diagnosis ? `${r.diagnosis.category} — ${r.diagnosis.title}` : r.heuristic.label;
    const conf = r.diagnosis ? r.diagnosis.confidence : r.heuristic.confidence;
    lines.push(`| ${r.analysis.title} | ${r.analysis.verdict} | ${pct(r.analysis.overall.rate)} (${r.analysis.overall.failures}/${r.analysis.overall.runs}) | ${cause} | ${pct(conf)} |`);
  }
  for (const r of sortResults(inv.results).filter((x) => x.analysis.verdict !== 'stable')) {
    lines.push('', `## ${r.analysis.title}`, '', `**${r.heuristic.label}** — ${r.heuristic.fix || ''}`, '');
    for (const e of r.heuristic.evidence) lines.push(`- ${e}`);
    if (r.diagnosis) lines.push('', `**Claude:** ${r.diagnosis.explanation}`);
    if (r.fix) lines.push('', `Fix: **${r.fix.status}**${r.fix.verification ? ` (after fix: ${r.fix.verification.overall.failures}/${r.fix.verification.overall.runs} failures)` : ''}`, '', '```diff', r.fix.diff.trimEnd(), '```');
  }
  return lines.join('\n') + '\n';
}

function heatCell(v) {
  // failure rate → colour intensity; significant cells get an outline
  const alpha = (0.08 + v.rate * 0.85).toFixed(2);
  const sig = v.significant ? ' sig' : '';
  return `<td class="cell${sig}" style="--a:${alpha}" title="${esc(`${v.failures}/${v.runs} failed · p=${v.name === 'baseline' ? '—' : v.pValue.toFixed(3)}`)}">${pct(v.rate)}<small>${v.failures}/${v.runs}</small></td>`;
}

function card(r, variationNames) {
  const a = r.analysis;
  const h = r.heuristic;
  const d = r.diagnosis;
  const byName = Object.fromEntries(a.variations.map((v) => [v.name, v]));
  const cause = d ? d.title : h.label;
  const conf = d ? d.confidence : h.confidence;
  const evidence = (d?.evidence?.length ? d.evidence : h.evidence) || [];
  return `<article class="card ${a.verdict}">
  <header>
    <span class="badge ${a.verdict}">${a.verdict}</span>
    <h2>${esc(a.title)}</h2>
    <code class="file">${esc(a.file)}:${a.line ?? ''}</code>
  </header>
  <div class="summary">
    <div><span class="k">Failure rate</span><span class="v">${pct(a.overall.rate)}</span><span class="s">${a.overall.failures}/${a.overall.runs} · 95% CI ${pct(a.overall.ci.low)}–${pct(a.overall.ci.high)}</span></div>
    <div class="wide"><span class="k">Root cause${d ? ' · Claude' : ' · rules'}</span><span class="v cause">${esc(cause)}</span><span class="s">confidence ${pct(conf)}${d ? ` · ${esc(d.category)}` : ''}</span></div>
  </div>
  <table class="heat"><thead><tr>${variationNames.map((n) => `<th>${esc(n)}</th>`).join('')}</tr></thead>
  <tbody><tr>${variationNames.map((n) => (byName[n] ? heatCell(byName[n]) : '<td class="cell na">—</td>')).join('')}</tr></tbody></table>
  ${d ? `<p class="explain">${esc(d.explanation)}</p>` : h.fix ? `<p class="explain">${esc(h.fix)}</p>` : ''}
  ${evidence.length ? `<h3>Evidence</h3><ul>${evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
  ${h.smells?.length ? `<h3>Code smells</h3><ul>${h.smells.map((s) => `<li><b>line ${s.lines.join(', ')}</b> — ${esc(s.message)}</li>`).join('')}</ul>` : ''}
  ${a.errorClusters.length ? `<h3>Error clusters</h3><ul class="errs">${a.errorClusters.slice(0, 3).map((c) => `<li><span class="pill">${esc(c.kind)}</span> ×${c.count} <code>${esc(c.signature)}</code>${c.received.length > 1 ? `<br><small>received: ${c.received.slice(0, 5).map(esc).join(' · ')}</small>` : ''}</li>`).join('')}</ul>` : ''}
  ${r.fix ? `<h3>Fix <span class="badge ${r.fix.status}">${r.fix.status}</span>${r.fix.verification ? ` <small>after: ${r.fix.verification.overall.failures}/${r.fix.verification.overall.runs} failures</small>` : ''}</h3><pre class="diff">${esc(r.fix.diff).split('\n').map((l) => `<span class="${l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}">${l}</span>`).join('\n')}</pre>${r.fix.pr?.prUrl ? `<p>Pull request: <a href="${esc(r.fix.pr.prUrl)}">${esc(r.fix.pr.prUrl)}</a></p>` : r.fix.pr?.skipped ? `<p class="muted">PR not opened: ${esc(r.fix.pr.skipped)}</p>` : ''}` : ''}
  ${r.traces?.length ? `<details><summary>Traces of failing runs</summary>${r.traces.map((t) => `<code class="trace">npx playwright show-trace ${esc(t)}</code>`).join('')}</details>` : ''}
</article>`;
}

export function toHtml(inv) {
  const names = inv.variations.map((v) => v.name);
  const results = sortResults(inv.results);
  const counts = { flaky: 0, broken: 0, stable: 0 };
  results.forEach((r) => counts[r.analysis.verdict]++);
  const totalRuns = results.reduce((s, r) => s + r.analysis.overall.runs, 0);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flaky Test Detective</title>
<style>
:root{--bg:#f6f5f1;--paper:#fff;--ink:#1c1b19;--muted:#6d6a62;--line:#e4e1d8;--flaky:#c2410c;--broken:#b91c1c;--stable:#15803d;--heat:194,65,12;--accent:#0f766e}
@media (prefers-color-scheme:dark){:root{--bg:#141412;--paper:#1d1c1a;--ink:#ecebe6;--muted:#a19d93;--line:#34322e;--heat:251,146,60}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:28px 16px 60px}
h1{font:600 26px/1.2 ui-serif,Georgia,serif;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 22px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:26px}
.stat{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.stat b{display:block;font-size:24px}.stat span{color:var(--muted);font-size:13px}
.card{background:var(--paper);border:1px solid var(--line);border-left:4px solid var(--muted);border-radius:12px;padding:18px;margin-bottom:16px}
.card.flaky{border-left-color:var(--flaky)}.card.broken{border-left-color:var(--broken)}.card.stable{border-left-color:var(--stable)}
.card header{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:baseline}.card h2{font-size:17px;margin:0}.file{color:var(--muted);font-size:12px}
.badge{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:2px 8px;border-radius:99px;color:#fff;background:var(--muted)}
.badge.flaky{background:var(--flaky)}.badge.broken,.badge.rejected{background:var(--broken)}.badge.stable,.badge.verified{background:var(--stable)}.badge.improved{background:var(--accent)}
.summary{display:grid;grid-template-columns:1fr 2fr;gap:10px;margin:14px 0}.summary>div{display:flex;flex-direction:column}
.k{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}.v{font-size:20px;font-weight:600}.v.cause{font-size:16px}.s{font-size:12px;color:var(--muted)}
.heat{width:100%;border-collapse:separate;border-spacing:4px;table-layout:fixed;margin:6px 0 10px}.heat th{font-size:11px;font-weight:500;color:var(--muted);word-break:break-word}
.cell{text-align:center;border-radius:8px;padding:8px 2px;font-weight:600;background:rgba(var(--heat),var(--a))}.cell small{display:block;font-weight:400;font-size:11px;opacity:.8}
.cell.sig{outline:2px solid rgb(var(--heat));outline-offset:-2px}.cell.na{background:transparent;color:var(--muted)}
h3{font-size:13px;margin:14px 0 6px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}ul{margin:0;padding-left:20px}li{margin:2px 0}
.explain{background:color-mix(in srgb,var(--accent) 8%,transparent);border-radius:8px;padding:10px 12px;margin:8px 0}
.pill{font-size:11px;border:1px solid var(--line);border-radius:99px;padding:0 6px}.errs code{font-size:12px;word-break:break-word}
pre.diff{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;font-size:12.5px}.add{color:var(--stable)}.del{color:var(--broken)}
code.trace{display:block;font-size:12px;margin:4px 0;word-break:break-all}.muted{color:var(--muted)}details{margin-top:10px}summary{cursor:pointer;color:var(--muted)}
.legend{font-size:12px;color:var(--muted);margin:-14px 0 20px}
@media (max-width:640px){.summary{grid-template-columns:1fr}.heat{font-size:12px}.heat{border-spacing:2px}.heat th{font-size:9px;line-height:1.2}.cell{padding:6px 0;font-size:12px}.cell small{font-size:9px}}
</style></head><body><div class="wrap">
<h1>🔎 Flaky Test Detective</h1>
<p class="sub">${esc(inv.target)} · ${inv.runsPerVariation} runs × ${inv.variations.length} variations · Claude diagnosis ${inv.claude.enabled ? 'on' : 'off (rule-based)'} · ${new Date(inv.generatedAt).toLocaleString()}</p>
<div class="stats">
<div class="stat"><b>${results.length}</b><span>tests investigated</span></div>
<div class="stat"><b style="color:var(--flaky)">${counts.flaky}</b><span>flaky</span></div>
<div class="stat"><b style="color:var(--broken)">${counts.broken}</b><span>broken</span></div>
<div class="stat"><b style="color:var(--stable)">${counts.stable}</b><span>stable</span></div>
<div class="stat"><b>${totalRuns}</b><span>test executions · ${(inv.durationMs / 1000).toFixed(0)}s</span></div>
</div>
<p class="legend">Heatmap = failure rate per variation. Outlined cells differ significantly from baseline (Fisher exact, p&lt;0.05).</p>
${results.map((r) => card(r, names)).join('\n')}
</div></body></html>`;
}

export async function writeReports(inv, outDir) {
  await mkdir(outDir, { recursive: true });
  const files = {
    json: path.join(outDir, 'report.json'),
    markdown: path.join(outDir, 'report.md'),
    html: path.join(outDir, 'index.html'),
  };
  await writeFile(files.json, JSON.stringify(inv, null, 2));
  await writeFile(files.markdown, toMarkdown(inv));
  await writeFile(files.html, toHtml(inv));
  return files;
}
