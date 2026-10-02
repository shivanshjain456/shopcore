/**
 * One-shot codemod: wrap every route handler in `src/app/api/**` with
 * `withErrorHandling(...)` from `@/lib/api`.
 *
 * Strategy:
 *
 *   For each exported HTTP-method handler (GET/POST/PUT/PATCH/DELETE):
 *     - If already wrapped → skip
 *     - Else: transform
 *           export async function METHOD(req, ctx) {
 *             try { ... body ... } catch (e) { return handleError(e); }
 *           }
 *       into
 *           export const METHOD = withErrorHandling(async (req, ctx) => {
 *             ... body ...
 *           });
 *
 *   If the handler has no try/catch, just wrap the whole body unchanged.
 *
 * Run ONCE:    `npx tsx scripts/migrate-routes-to-with-error-handling.ts`
 * Idempotent:  re-running on an already-wrapped file is a no-op.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'src/app/api';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/route\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

interface Transform {
  changed: boolean;
  src: string;
  modifiedHandlers: string[];
}

function balancedBlock(src: string, openIdx: number): number {
  // openIdx points at `{`. Return index of the matching `}`.
  if (src[openIdx] !== '{') return -1;
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
    else if (ch === '"' || ch === "'" || ch === '`') {
      // skip string literal
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
    } else if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
    }
  }
  return -1;
}

/** Strip an outer `try { ... } catch (e) { return handleError(e); }` if
 *  it's the sole top-level statement of `body`. Returns the unwrapped
 *  inner body, or the original body if not the pattern. */
function maybeStripTryHandleError(body: string): string {
  const trimmed = body.trim();
  // Must start with `try` keyword followed by `{`.
  const tryMatch = trimmed.match(/^try\s*\{/);
  if (!tryMatch) return body;
  const tryOpen = trimmed.indexOf('{', tryMatch.index ?? 0);
  const tryClose = balancedBlock(trimmed, tryOpen);
  if (tryClose < 0) return body;
  // Look for a catch clause immediately after.
  const afterTry = trimmed.slice(tryClose + 1).trimStart();
  const catchMatch = afterTry.match(/^catch\s*\([^)]*\)\s*\{/);
  if (!catchMatch) return body;
  const catchAbsoluteStart = tryClose + 1 + (trimmed.slice(tryClose + 1).length - afterTry.length);
  const catchOpen = trimmed.indexOf('{', catchAbsoluteStart);
  const catchClose = balancedBlock(trimmed, catchOpen);
  if (catchClose < 0) return body;
  // The catch body must contain `handleError(` to qualify for stripping.
  const catchBody = trimmed.slice(catchOpen + 1, catchClose);
  if (!/handleError\s*\(/.test(catchBody)) return body;
  // Nothing else may follow the catch block (otherwise we'd be dropping code).
  const tail = trimmed.slice(catchClose + 1).trim();
  if (tail.length > 0) return body;

  // Return the try-block body, preserving its inner indentation (caller
  // re-indents).
  const innerBody = trimmed.slice(tryOpen + 1, tryClose);
  return innerBody;
}

/** Re-indent a multi-line block by removing a uniform leading-spaces
 *  prefix (the minimum across non-empty lines). */
function dedent(s: string): string {
  const lines = s.split('\n');
  const indents = lines.filter((l) => l.trim().length > 0).map((l) => l.match(/^ */)?.[0].length ?? 0);
  if (indents.length === 0) return s;
  const minIndent = Math.min(...indents);
  return lines.map((l) => l.slice(minIndent)).join('\n');
}

/** Re-indent every line by prepending `spaces`. */
function indent(s: string, spaces: string): string {
  return s.split('\n').map((l) => (l.length > 0 ? spaces + l : l)).join('\n');
}

function transformFile(src: string): Transform {
  const modifiedHandlers: string[] = [];
  // Already wrapped? Check for the canonical pattern.
  // We still walk per-method below so a partially-migrated file is finished.
  let working = src;

  for (const method of METHODS) {
    // Pattern: `export async function METHOD(<params>) { <body> }`
    const re = new RegExp(
      String.raw`export\s+async\s+function\s+${method}\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\s*\{`,
      'm',
    );
    const m = working.match(re);
    if (!m || m.index === undefined) continue;
    // Confirm this method isn't already exported as a const wrapped form.
    const constRe = new RegExp(
      String.raw`export\s+const\s+${method}\s*=\s*withErrorHandling\b`,
      'm',
    );
    if (constRe.test(working)) continue;

    const params = m[1].trim();
    const funcStart = m.index;
    const openBraceIdx = funcStart + m[0].length - 1;
    const closeBraceIdx = balancedBlock(working, openBraceIdx);
    if (closeBraceIdx < 0) continue;

    const body = working.slice(openBraceIdx + 1, closeBraceIdx);
    // Strip try/handleError outer wrap if present.
    const inner = maybeStripTryHandleError(body);
    const dedented = dedent(inner).trim();
    const reindented = indent(dedented, '  ');

    const replacement =
      `export const ${method} = withErrorHandling(async (${params}) => {\n` +
      `${reindented}\n` +
      `});`;

    working = working.slice(0, funcStart) + replacement + working.slice(closeBraceIdx + 1);
    modifiedHandlers.push(method);
  }

  if (modifiedHandlers.length === 0) {
    return { changed: false, src: working, modifiedHandlers };
  }

  // Imports: ensure `withErrorHandling` is imported from '@/lib/api'.
  const importLineRe = /import\s*\{([^}]*)\}\s*from\s*['"]@\/lib\/api['"]\s*;?/;
  const imp = working.match(importLineRe);
  if (imp) {
    const named = imp[1].split(',').map((s) => s.trim()).filter(Boolean);
    if (!named.includes('withErrorHandling')) {
      // Remove `handleError` since the wrapper now owns it.
      const kept = named.filter((n) => n !== 'handleError');
      kept.push('withErrorHandling');
      const replacement = `import { ${Array.from(new Set(kept)).sort().join(', ')} } from '@/lib/api';`;
      working = working.replace(importLineRe, replacement);
    } else if (named.includes('handleError')) {
      // Already has both; drop handleError if no other reference uses it.
      // (Safe: we just stripped every catch-handleError block.)
      const stillUsed = /\bhandleError\s*\(/.test(working);
      if (!stillUsed) {
        const kept = named.filter((n) => n !== 'handleError');
        const replacement = `import { ${Array.from(new Set(kept)).sort().join(', ')} } from '@/lib/api';`;
        working = working.replace(importLineRe, replacement);
      }
    }
  } else {
    // Insert a new import after the first existing import line.
    const firstImp = working.match(/^import .+;\s*$/m);
    if (firstImp && firstImp.index !== undefined) {
      const insertAt = firstImp.index + firstImp[0].length;
      working = working.slice(0, insertAt) + `\nimport { withErrorHandling } from '@/lib/api';` + working.slice(insertAt);
    } else {
      working = `import { withErrorHandling } from '@/lib/api';\n` + working;
    }
  }

  return { changed: true, src: working, modifiedHandlers };
}

function main() {
  const files = walk(ROOT);
  let modified = 0;
  let totalHandlers = 0;
  const summary: string[] = [];

  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const t = transformFile(src);
    if (t.changed) {
      writeFileSync(f, t.src);
      modified++;
      totalHandlers += t.modifiedHandlers.length;
      summary.push(`  ${f}  →  ${t.modifiedHandlers.join(', ')}`);
    }
  }
  console.log(`\nMigrated ${totalHandlers} handlers across ${modified}/${files.length} files:\n`);
  for (const s of summary) console.log(s);
}

main();
