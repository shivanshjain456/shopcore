/**
 * Repository audit — Bug #8 invariant.
 *
 *   npm run test:no-native-dialogs
 *
 * Walks every .ts / .tsx file in src/ and fails if any source file contains
 * a raw `window.alert(...)`, `window.confirm(...)`, `window.prompt(...)`,
 * or a bare `alert(`, `confirm(`, `prompt(` call that is NOT preceded by
 * `.` (i.e. NOT a method call like `dialog.alert(...)`).
 *
 * The dialog implementation file itself is excluded — it legitimately uses
 * `prompt` and `confirm` as mode strings + class members.
 *
 * Why we ban these:
 *   - Native dialogs are blocking, unstyled, suppressed in iframes/cross-origin
 *     /mobile contexts, and silently return null when blocked — a documented
 *     downstream-fault vector (see Bug #6: UTR rejection reason returning null
 *     and silently breaking the rejection flow).
 *
 * The grep is intentionally surgical to avoid false positives on
 *   - `someObj.alert(...)` / `dialog.alert(...)`
 *   - strings literally containing the word
 *   - comments
 *
 * If this test fails, the file:line offenders are printed and the migration
 * to <AppDialog> via the useDialog() hook (DialogProvider) is required.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', 'src');
const EXCLUDE_FILES = new Set([
  path.resolve(ROOT, 'components', 'dialog', 'AppDialog.tsx'),
  path.resolve(ROOT, 'components', 'dialog', 'DialogProvider.tsx'),
]);

// Match raw native dialog calls. The negative-lookbehind on . catches the
// "bare call" case while ignoring legitimate method calls like `x.alert(...)`.
// The forbid covers BOTH `window.alert(...)` and bare `alert(...)` forms.
const PATTERNS: { id: string; re: RegExp; description: string }[] = [
  { id: 'window.alert',   re: /\bwindow\.alert\s*\(/g,             description: 'window.alert(...)' },
  { id: 'window.confirm', re: /\bwindow\.confirm\s*\(/g,           description: 'window.confirm(...)' },
  { id: 'window.prompt',  re: /\bwindow\.prompt\s*\(/g,            description: 'window.prompt(...)' },
  { id: 'bare alert',     re: /(?<![.\w$])\balert\s*\(/g,          description: 'bare alert(...)' },
  { id: 'bare confirm',   re: /(?<![.\w$])\bconfirm\s*\(/g,        description: 'bare confirm(...)' },
  { id: 'bare prompt',    re: /(?<![.\w$])\bprompt\s*\(/g,         description: 'bare prompt(...)' },
];

interface Offender { file: string; line: number; column: number; match: string; rule: string; }

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.next', 'dist', 'build'].includes(e.name)) continue;
      yield* walk(p);
    } else if (e.isFile() && (p.endsWith('.ts') || p.endsWith('.tsx'))) {
      yield p;
    }
  }
}

/** Strip line comments + block comments so we don't flag examples in doc-comments. */
function stripComments(src: string): string {
  // Remove /* ... */ blocks
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  // Remove // line comments (but preserve newlines so line numbers stay correct)
  out = out.replace(/(^|[^:\\])\/\/[^\n]*/g, (m, prefix) => prefix + ' '.repeat(m.length - prefix.length));
  return out;
}

async function main() {
  let scanned = 0;
  const offenders: Offender[] = [];

  for await (const file of walk(ROOT)) {
    if (EXCLUDE_FILES.has(file)) continue;
    scanned += 1;
    const raw = await fs.readFile(file, 'utf8');
    const src = stripComments(raw);
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = p.re.exec(src))) {
        // Compute line + column
        const before = src.slice(0, m.index);
        const line = (before.match(/\n/g)?.length ?? 0) + 1;
        const lastNL = before.lastIndexOf('\n');
        const column = m.index - lastNL;
        offenders.push({ file, line, column, match: m[0], rule: p.description });
      }
    }
  }

  if (offenders.length === 0) {
    console.log(`\n✔ Audited ${scanned} source files — no native dialog calls found.\n`);
    process.exit(0);
  }
  console.error(`\n✘ Found ${offenders.length} native dialog call(s) in ${scanned} files:\n`);
  for (const o of offenders) {
    const rel = path.relative(path.resolve(__dirname, '..'), o.file);
    console.error(`   ${rel}:${o.line}:${o.column}   ${o.match}   — ${o.rule}`);
  }
  console.error(`\nReplace each with the useDialog() API:`);
  console.error(`    const dialog = useDialog();`);
  console.error(`    await dialog.alert({ title: '...', message: '...' });`);
  console.error(`    if (await dialog.confirm({ title: '...', ... })) { ... }`);
  console.error(`    const v = await dialog.promptUser({ title: '...', ... });`);
  console.error(``);
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
