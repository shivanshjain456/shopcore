/**
 * Minimal cron expression parser + nextRun calculator.
 *
 * Why hand-rolled: the brief forbids adding a node-cron / cron-parser
 * dependency. We only need a strict subset of the cron grammar (sufficient
 * for every built-in ShopCore schedule listed in spec §2.6):
 *
 *     `m h dom mon dow`     // 5 fields, space-separated
 *
 *   field   range       extras
 *   -----   ---------   ------------------------
 *   m       0–59        *  n  n/step  list n,m,…
 *   h       0–23        *  n  n/step  list
 *   dom     1–31        *  n  n/step  list
 *   mon     1–12        *  n  n/step  list
 *   dow     0–6 (Sun=0) *  n  n/step  list
 *
 * NOT supported (would throw ValidationError on parse):
 *   - `n-m` ranges, named day/month aliases (JAN, MON), `?`, `L`, `W`, `#`.
 *
 * Schedules are interpreted in **UTC**. Authors expressing "9am IST" must
 * write `30 3 * * *` (9:00 IST == 03:30 UTC). The seed file documents this
 * conversion next to every schedule.
 *
 * Tests: scripts/test-background-jobs.ts § cron parser.
 */
import { ValidationError, InternalError } from '@/lib/errors';

export interface CronFields {
  minute:     ReadonlySet<number>;
  hour:       ReadonlySet<number>;
  dayOfMonth: ReadonlySet<number>;
  month:      ReadonlySet<number>;
  dayOfWeek:  ReadonlySet<number>;
  /** Whether each field was `*` (untouched). Used by the matcher to decide
   *  whether dom/dow combine via OR (POSIX cron rule: when both are
   *  restricted, the cron fires if EITHER matches). */
  raw: { minute: string; hour: string; dom: string; mon: string; dow: string };
}

const FIELD_RANGES = {
  minute:     { lo: 0, hi: 59 },
  hour:       { lo: 0, hi: 23 },
  dayOfMonth: { lo: 1, hi: 31 },
  month:      { lo: 1, hi: 12 },
  dayOfWeek:  { lo: 0, hi: 6 },
} as const;

type FieldName = keyof typeof FIELD_RANGES;

function parseField(raw: string, name: FieldName): ReadonlySet<number> {
  // Widen the as-const narrow tuple types to plain `number` — the
  // intersection across field unions makes TS otherwise infer `0 | 1`
  // for `lo` (the only value common to every range) and `start = n`
  // below would fail to type-check.
  const range = FIELD_RANGES[name] as { lo: number; hi: number };
  const { lo, hi } = range;
  const out = new Set<number>();

  // Comma-separated list. Each piece is one of: `*`, `n`, `*/step`, `n/step`.
  for (const piece of raw.split(',')) {
    const p = piece.trim();
    if (p === '') {
      throw new ValidationError(`Empty cron field segment in "${raw}" (${name})`, {
        code: 'INVALID_CRON',
      });
    }

    // Step form: `<base>/<step>`
    const slash = p.indexOf('/');
    if (slash !== -1) {
      const base = p.slice(0, slash);
      const stepStr = p.slice(slash + 1);
      const step = Number(stepStr);
      if (!Number.isInteger(step) || step <= 0) {
        throw new ValidationError(`Invalid cron step "${p}" in field "${name}"`, {
          code: 'INVALID_CRON',
        });
      }
      // base can be `*` (every value) or a single integer (start point).
      let start = lo;
      if (base !== '*') {
        const n = Number(base);
        if (!Number.isInteger(n) || n < lo || n > hi) {
          throw new ValidationError(`Cron step base "${base}" out of range for ${name}`, {
            code: 'INVALID_CRON',
          });
        }
        start = n;
      }
      for (let v = start; v <= hi; v += step) out.add(v);
      continue;
    }

    if (p === '*') {
      for (let v = lo; v <= hi; v++) out.add(v);
      continue;
    }

    const n = Number(p);
    if (!Number.isInteger(n) || n < lo || n > hi) {
      throw new ValidationError(`Cron value "${p}" out of range for ${name} (${lo}-${hi})`, {
        code: 'INVALID_CRON',
      });
    }
    out.add(n);
  }

  if (out.size === 0) {
    throw new ValidationError(`Cron field "${raw}" (${name}) matches no values`, {
      code: 'INVALID_CRON',
    });
  }
  return out;
}

export function parseCron(expression: string): CronFields {
  if (typeof expression !== 'string') {
    throw new ValidationError('Cron expression must be a string', { code: 'INVALID_CRON' });
  }
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new ValidationError(
      `Cron expression must have exactly 5 fields (got ${parts.length}): "${expression}"`,
      { code: 'INVALID_CRON' },
    );
  }
  const [m, h, dom, mon, dow] = parts;
  return {
    minute:     parseField(m,   'minute'),
    hour:       parseField(h,   'hour'),
    dayOfMonth: parseField(dom, 'dayOfMonth'),
    month:      parseField(mon, 'month'),
    dayOfWeek:  parseField(dow, 'dayOfWeek'),
    raw: { minute: m, hour: h, dom, mon, dow },
  };
}

/**
 * Compute the next UTC datetime AFTER `from` that satisfies `expression`.
 *
 * Strategy:
 *   - Round `from` up to the next whole minute (cron resolution is minute).
 *   - Iterate minute-by-minute, checking every field. Cron's lowest
 *     non-trivial resolution is one minute, so worst-case search is
 *     `366*24*60 ≈ 527k` iterations for a once-yearly cron (Feb 29 etc.).
 *     That's < 1s on Node 20 — acceptable for a startup/poll-cycle call.
 *   - Cap at 366 days; throw InternalError if no match (a defensive
 *     guard — only triggers for impossible expressions like Feb 31).
 *
 * dom/dow combine via POSIX OR rule: if BOTH fields are restricted (not `*`)
 * the cron fires when EITHER matches. If one is `*` the other is the gate.
 */
export function computeNextRun(expression: string, from: Date): Date {
  const fields = parseCron(expression);
  const domStar = fields.raw.dom.trim() === '*';
  const dowStar = fields.raw.dow.trim() === '*';

  // Round to the NEXT whole minute strictly after `from` (>= from + 1 min).
  // This guarantees `computeNextRun(expr, now) > now`, matching spec §3.11.
  const t = new Date(Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate(),
    from.getUTCHours(),
    from.getUTCMinutes() + 1,
    0,
    0,
  ));

  const CAP_MS = 366 * 24 * 60 * 60 * 1000;
  const end = t.getTime() + CAP_MS;

  while (t.getTime() <= end) {
    const M  = t.getUTCMinutes();
    const H  = t.getUTCHours();
    const D  = t.getUTCDate();
    const Mo = t.getUTCMonth() + 1;          // 1-12
    const W  = t.getUTCDay();                // 0-6 (Sun=0)

    const monthOk  = fields.month.has(Mo);
    const hourOk   = fields.hour.has(H);
    const minOk    = fields.minute.has(M);

    let dayOk: boolean;
    if (domStar && dowStar) {
      dayOk = true;
    } else if (domStar) {
      dayOk = fields.dayOfWeek.has(W);
    } else if (dowStar) {
      dayOk = fields.dayOfMonth.has(D);
    } else {
      // POSIX OR: either dom or dow matches.
      dayOk = fields.dayOfMonth.has(D) || fields.dayOfWeek.has(W);
    }

    if (monthOk && dayOk && hourOk && minOk) {
      return new Date(t.getTime());
    }

    // Advance one minute. Date math handles month/year rollover for us.
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }

  throw new InternalError(
    `Cron expression "${expression}" did not match any time in the next year`,
    { code: 'CRON_NO_MATCH' },
  );
}
