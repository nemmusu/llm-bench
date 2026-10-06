// Every coverage-ignore hint in src/ must be listed, with a reason, in coverage-exceptions.json,
// and the total stays within a small budget. This keeps "100%" honest.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET = 10;
const HINT = /\/\*\s*(?:istanbul|v8|c8|node:coverage)\s+ignore\b[^*]*\*\//g;

const { exceptions } = JSON.parse(readFileSync(path.join(root, 'coverage-exceptions.json'), 'utf8'));
const allowed = new Map(exceptions.map((e) => [`${e.file}#${e.hint}`, e]));

const found = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) {
      const text = readFileSync(p, 'utf8');
      for (const m of text.matchAll(HINT)) found.push({ file: path.relative(root, p).replaceAll('\\', '/'), hint: m[0] });
    }
  }
};
walk(path.join(root, 'src'));

const problems = [];
for (const f of found) {
  const e = allowed.get(`${f.file}#${f.hint}`);
  if (!e) problems.push(`unlisted coverage ignore in ${f.file}: ${f.hint}`);
  else if (!e.reason || e.reason.length < 15) problems.push(`missing reason for ${f.file}: ${f.hint}`);
}
if (found.length > BUDGET) problems.push(`${found.length} coverage ignores exceed the budget of ${BUDGET}`);

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`coverage ignores: ${found.length}/${BUDGET}, all justified`);
