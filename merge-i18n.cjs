const { execSync } = require('child_process');
const fs = require('fs');

const LANGS = ['zh-CN', 'en', 'in', 'vi'];

function stripComments(text) {
  let out = '';
  let i = 0, n = text.length, inStr = false, quote = '';
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += next; i += 2; continue; }
      if (c === quote) inStr = false;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = true; quote = c; out += c; i += 1; continue; }
    if (c === '/' && next === '/') { while (i < n && text[i] !== '\n') i += 1; continue; }
    if (c === '/' && next === '*') { i += 2; while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 2; continue; }
    out += c; i += 1;
  }
  return out;
}

function parseTs(text) {
  let s = stripComments(text).trim();
  s = s.replace(/^export\s+default\s*/, '');
  s = s.replace(/\s*as\s+const\s*;?\s*$/, '');
  s = s.replace(/;\s*$/, '');
  try { return JSON.parse(s); }
  catch (e) {
    s = s.replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(s);
  }
}

function deepMerge(base, extra) {
  for (const k of Object.keys(extra)) {
    if (!(k in base)) {
      base[k] = extra[k];
    } else if (base[k] && extra[k] && typeof base[k] === 'object' && typeof extra[k] === 'object' && !Array.isArray(base[k]) && !Array.isArray(extra[k])) {
      deepMerge(base[k], extra[k]);
    }
  }
  return base;
}

for (const lang of LANGS) {
  const work = `src/i18n/locales/${lang}.ts`;
  const workText = fs.readFileSync(work, 'utf8');
  let prText;
  try { prText = execSync(`git show pr-977:src/i18n/locales/${lang}.ts`, { encoding: 'utf8', maxBuffer: 64*1024*1024 }); }
  catch (e) { console.log(lang, 'pr-977 不可取，跳过'); continue; }
  const base = parseTs(workText);
  const extra = parseTs(prText);
  const missing = [];
  const collect = (b, e, path) => {
    for (const k of Object.keys(e)) {
      if (!(k in b)) missing.push([...path, k].join('.'));
      else if (b[k] && e[k] && typeof b[k] === 'object' && typeof e[k] === 'object' && !Array.isArray(b[k]) && !Array.isArray(e[k])) collect(b[k], e[k], [...path, k]);
    }
  };
  collect(base, extra, []);
  deepMerge(base, extra);
  const out = 'export default ' + JSON.stringify(base, null, 2) + ';\n';
  fs.writeFileSync(work, out);
  console.log(lang, '补入缺失 key 数:', missing.length);
}
