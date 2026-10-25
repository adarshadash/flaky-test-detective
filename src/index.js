export { investigate, judgeVerification } from './detective.js';
export { VARIATIONS, DEFAULT_VARIATIONS, resolveVariations } from './variations.js';
export { analyzeTest, wilson, fisherExact } from './stats.js';
export { classify, detectSmells, CAUSES } from './classify.js';
export { diagnose, buildPrompt, parseDiagnosis } from './claude.js';
export { applyFix, unifiedDiff, openPullRequest } from './patch.js';
export { writeReports, toHtml, toMarkdown } from './report.js';
