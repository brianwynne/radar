// DataStream 2 edge-log parser. DS2 delivers logs as newline-delimited JSON objects (one request
// per line), commonly gzip-compressed and batched many-per-upload, with numeric fields encoded as
// strings. This reduces a raw upload to canonical DataStreamRecords. Pure and defensive: malformed
// or field-less lines are skipped, never guessed. READ-ONLY.
import { gunzipSync } from 'node:zlib';
import type { DataStreamRecord } from './types.js';

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const intOf = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; }
  return 0;
};

/** Gunzip when the payload is gzip (magic 0x1f 0x8b) or explicitly gzip-encoded, else pass through. */
export function decodeUpload(body: Buffer, contentEncoding?: string): string {
  const gzip = /gzip/i.test(contentEncoding ?? '') || (body.length > 1 && body[0] === 0x1f && body[1] === 0x8b);
  return (gzip ? gunzipSync(body) : body).toString('utf8');
}

/** Parse newline-delimited DS2 JSON into canonical records. Lines without a usable time+cp are dropped. */
export function parseRecords(text: string): DataStreamRecord[] {
  const out: DataStreamRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let obj: unknown;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (!isObj(obj)) continue;
    const rec = toRecord(obj);
    if (rec) out.push(rec);
  }
  return out;
}

export function parseDataStreamUpload(body: Buffer, contentEncoding?: string): DataStreamRecord[] {
  return parseRecords(decodeUpload(body, contentEncoding));
}

function toRecord(o: Record<string, unknown>): DataStreamRecord | null {
  const second = intOf(o.reqTimeSec ?? o.start);
  const cp = o.cp !== undefined && o.cp !== null ? String(o.cp) : '';
  if (second <= 0 || cp.length === 0) return null;
  return {
    second,
    cp,
    bytes: intOf(o.bytes),
    hit: intOf(o.cacheStatus) === 1,
    statusCode: intOf(o.statusCode),
  };
}
