// Recent-record convenience, persisted in localStorage (read-only client state — no
// server writes). Most-recent first, capped.
export interface RecordRef {
  zone: string;
  domain: string;
  type: string;
}

const KEY = 'radar.recentRecords';
const MAX = 8;

const same = (a: RecordRef, b: RecordRef) => a.zone === b.zone && a.domain === b.domain && a.type === b.type;

export function getRecent(): RecordRef[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as RecordRef[]) : [];
    return Array.isArray(list) ? list.filter((r) => r && r.zone && r.domain && r.type) : [];
  } catch {
    return [];
  }
}

export function addRecent(ref: RecordRef): RecordRef[] {
  const next = [ref, ...getRecent().filter((r) => !same(r, ref))].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // ignore storage failures (private mode / disabled)
  }
  return next;
}
