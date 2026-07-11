// Snapshot helpers: canonical JSON, SHA-256 checksums, and a structural diff. Canonical
// form recursively sorts object keys while PRESERVING array order (so answer and
// filter-chain order are never reordered — docs/ns1/developer-guide.md §6.2). The raw
// payload is preserved verbatim by the caller; canonicalisation is used only for stable
// checksums and comparison.
import { createHash } from 'node:crypto';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalise(value[key]);
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** Checksum of the raw payload as received (verbatim key order). */
export function rawChecksum(raw: unknown): string {
  return sha256(JSON.stringify(raw ?? null));
}

/** Checksum of the canonical (key-sorted) form — stable across insignificant reordering. */
export function structuralChecksum(raw: unknown): string {
  return sha256(JSON.stringify(canonicalise(raw)));
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalise(a)) === JSON.stringify(canonicalise(b));
}

export type JsonDiffKind = 'added' | 'removed' | 'changed';
export interface JsonDiffEntry {
  path: string;
  kind: JsonDiffKind;
  before?: unknown;
  after?: unknown;
}

/** A compact structural diff between two JSON values (compared canonically). */
export function diffJson(a: unknown, b: unknown, path = ''): JsonDiffEntry[] {
  if (deepEqual(a, b)) return [];

  if (isObject(a) && isObject(b)) {
    const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
    return keys.flatMap((k) => {
      const p = path ? `${path}.${k}` : k;
      if (!(k in a)) return [{ path: p, kind: 'added' as const, after: b[k] }];
      if (!(k in b)) return [{ path: p, kind: 'removed' as const, before: a[k] }];
      return diffJson(a[k], b[k], p);
    });
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    const out: JsonDiffEntry[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const p = `${path}[${i}]`;
      if (i >= a.length) out.push({ path: p, kind: 'added', after: b[i] });
      else if (i >= b.length) out.push({ path: p, kind: 'removed', before: a[i] });
      else out.push(...diffJson(a[i], b[i], p));
    }
    return out;
  }

  return [{ path: path || '(root)', kind: 'changed', before: a, after: b }];
}
