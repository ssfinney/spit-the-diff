const assert = require('node:assert/strict');
const { buildCompressedDiffPayload, isTinyPullRequest } = require('../dist/diffCompression.js');

const small = [
  {
    filename: 'src/index.ts',
    status: 'modified',
    additions: 12,
    deletions: 2,
    patch: '@@ -1,2 +1,5 @@\n-function oldName() {}\n+function parsePullRequest() {}\n+export const roastMode = true;\n+it("builds payload", () => {})',
  },
];

const noisy = [
  { filename: 'package-lock.json', status: 'modified', additions: 50, deletions: 20, patch: '@@ -1 +1 @@' },
  { filename: 'src/feature.ts', status: 'modified', additions: 10, deletions: 5, patch: '@@ -1 +1 @@\n+export function shipFeature() {}' },
];

const tiny = buildCompressedDiffPayload(small, { promptCharBudget: 5000 });
assert.equal(tiny.filesSummary.includes('src/index.ts (+12 / -2) modified'), true);
assert.equal(tiny.symbolSummary.includes('parsePullRequest'), true);
assert.equal(tiny.isTinyPullRequest, true);

const filtered = buildCompressedDiffPayload(noisy, { promptCharBudget: 5000 });
assert.equal(filtered.filesSummary.includes('package-lock.json'), false);
assert.equal(filtered.filesSummary.includes('src/feature.ts'), true);

const hugePatch = '@@ -1,1 +1,200 @@\n' + Array.from({ length: 200 }, (_, i) => `+const x${i} = ${i};`).join('\n');
const large = buildCompressedDiffPayload(
  [{ filename: 'src/huge.ts', status: 'modified', additions: 200, deletions: 1, patch: hugePatch }],
  { promptCharBudget: 300 }
);
assert.equal(large.diffExcerpt, '');
assert.equal(isTinyPullRequest([
  { filename: 'a.ts', status: 'modified', additions: 100, deletions: 100 },
  { filename: 'b.ts', status: 'modified', additions: 100, deletions: 100 },
  { filename: 'c.ts', status: 'modified', additions: 100, deletions: 100 },
]), false);

console.log('diffCompression tests passed');
