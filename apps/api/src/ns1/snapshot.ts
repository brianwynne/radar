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

// --- Record-aware change summary -------------------------------------------

export interface RecordDiffSummary {
  ttlChanged: boolean;
  ecsChanged: boolean;
  answersAdded: number;
  answersRemoved: number;
  answersChanged: number;
  filtersAdded: number;
  filtersRemoved: number;
  filtersChanged: number;
  filtersReordered: boolean;
  otherChanges: number;
}

function rec(v: unknown): Record<string, unknown> {
  return isObject(v) ? v : {};
}
function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v.filter(isObject) as Record<string, unknown>[]) : [];
}
function answerKey(a: Record<string, unknown>): string {
  return typeof a.id === 'string' && a.id ? a.id : JSON.stringify(a.answer ?? a);
}
function countBy(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}
function firstSegment(path: string): string {
  const m = path.match(/^[^.[]+/);
  return m ? m[0] : path;
}

function summariseAnswers(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b = arr(before.answers);
  const a = arr(after.answers);
  const bMap = new Map(b.map((x) => [answerKey(x), x]));
  const aMap = new Map(a.map((x) => [answerKey(x), x]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const k of aMap.keys()) if (!bMap.has(k)) added++;
  for (const [k, v] of bMap) {
    const other = aMap.get(k);
    if (other === undefined) removed++;
    else if (!deepEqual(v, other)) changed++;
  }
  return { added, removed, changed };
}

function summariseFilters(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b = arr(before.filters);
  const a = arr(after.filters);
  const bt = b.map((f) => String(f.filter));
  const at = a.map((f) => String(f.filter));
  const bc = countBy(bt);
  const ac = countBy(at);
  let added = 0;
  let removed = 0;
  for (const t of new Set([...bt, ...at])) {
    const delta = (ac[t] ?? 0) - (bc[t] ?? 0);
    if (delta > 0) added += delta;
    else if (delta < 0) removed += -delta;
  }
  // Same-type filters whose config changed at the same position.
  let changed = 0;
  for (let i = 0; i < Math.min(b.length, a.length); i++) {
    if (bt[i] === at[i] && !deepEqual(b[i], a[i])) changed++;
  }
  const sameMultiset = [...bt].sort().join('|') === [...at].sort().join('|');
  const reordered = sameMultiset && bt.join('|') !== at.join('|');
  return { added, removed, changed, reordered };
}

/** Classify the changes between two canonical NS1 records. Array order (answers,
 *  filters) is preserved — answers are matched by id, filters by position/multiset. */
export function summariseRecordDiff(before: unknown, after: unknown, changes: JsonDiffEntry[]): RecordDiffSummary {
  const b = rec(before);
  const a = rec(after);
  const ans = summariseAnswers(b, a);
  const fil = summariseFilters(b, a);
  const covered = new Set(['answers', 'filters', 'ttl', 'use_client_subnet']);
  return {
    ttlChanged: !deepEqual(b.ttl, a.ttl),
    ecsChanged: !deepEqual(b.use_client_subnet, a.use_client_subnet),
    answersAdded: ans.added,
    answersRemoved: ans.removed,
    answersChanged: ans.changed,
    filtersAdded: fil.added,
    filtersRemoved: fil.removed,
    filtersChanged: fil.changed,
    filtersReordered: fil.reordered,
    otherChanges: changes.filter((c) => !covered.has(firstSegment(c.path))).length,
  };
}
