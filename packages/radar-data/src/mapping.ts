// Row-mapping helpers. PostgreSQL drivers differ in how they return JSONB, array and
// timestamp columns (node-pg parses JSONB to objects, text[] to a JS array, and
// timestamps to Date). These coerce defensively rather than assume one representation.
// This is real PostgreSQL wire-format handling, not emulated database semantics.

// Real PostgreSQL (node-pg) and pg-mem both parse JSONB into JS values, so a JSONB column
// is already a JS value here (object, array, string, number, boolean or null). It must
// NOT be re-parsed — doing so corrupts scalar strings (`'réalta'` → parse error) and
// scalar numbers (`'42'` → 42). Only when a driver hands back raw JSON *text* for a
// container (`{...}`/`[...]`) do we parse it.
export function toJson<T = unknown>(value: unknown): T {
  if (typeof value !== 'string') return value as T;
  const trimmed = value.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      return value as T;
    }
  }
  return value as T; // an already-parsed JSONB string scalar
}

/** Coerce a PostgreSQL `text[]` column to a string array. node-pg returns a JS array;
 *  a value arriving as a Postgres array literal string (`{a,b}` / `{}`) is parsed too. */
export function toStringArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '' || s === '{}') return [];
    if (s.startsWith('{') && s.endsWith('}')) {
      return s
        .slice(1, -1)
        .split(',')
        .map((part) => part.trim().replace(/^"(.*)"$/, '$1'))
        .filter((part) => part.length > 0);
    }
    return [s];
  }
  return [];
}

export function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string);
}

export function orUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}
