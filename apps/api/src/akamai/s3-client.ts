// Minimal, READ-ONLY Amazon S3 client with inline AWS Signature V4 (no aws-sdk dependency — the
// same dependency-light approach used for Akamai EdgeGrid). Only GET is implemented: ListObjectsV2
// (to discover new DataStream 2 log objects) and GetObject (to download them). The secret key is
// used only to derive the signing key and is never logged. Virtual-hosted-style requests.
import { createHash, createHmac } from 'node:crypto';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const sha256hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** RFC-3986 encoding used by SigV4 (encodeURIComponent plus the extra reserved chars). */
const enc = (s: string): string => encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
/** Path is encoded per segment; '/' is preserved. */
const encPath = (p: string): string => p.split('/').map(enc).join('/');

export interface SignV4Input {
  method: string;
  host: string;
  path: string; // already the raw object path, e.g. /a/b.json
  query: Record<string, string>;
  headers: Record<string, string>; // must include x-amz-content-sha256 and x-amz-date
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretKey: string;
  amzDate: string; // YYYYMMDDTHHMMSSZ
}

/** Produce the SigV4 Authorization header value. Pure — unit-tested against AWS's published S3 vector. */
export function signV4(inp: SignV4Input): string {
  const dateStamp = inp.amzDate.slice(0, 8);
  const canonicalQuery = Object.keys(inp.query).sort().map((k) => `${enc(k)}=${enc(inp.query[k])}`).join('&');
  const headerNames = Object.keys(inp.headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = headerNames.map((h) => `${h}:${String(inp.headers[Object.keys(inp.headers).find((k) => k.toLowerCase() === h)!]).trim()}\n`).join('');
  const signedHeaders = headerNames.join(';');
  const canonicalRequest = [inp.method, encPath(inp.path), canonicalQuery, canonicalHeaders, signedHeaders, inp.payloadHash].join('\n');
  const scope = `${dateStamp}/${inp.region}/${inp.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', inp.amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + inp.secretKey, dateStamp);
  const kRegion = hmac(kDate, inp.region);
  const kService = hmac(kRegion, inp.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${inp.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export interface S3Object { key: string; lastModified: string; size: number; }

export interface S3ReadClientOptions {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Override the base origin for testing (e.g. a local stub). Defaults to virtual-hosted S3. */
  endpoint?: string;
  timeoutMs?: number;
}

export class S3ReadClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly origin: string;
  private readonly host: string;

  constructor(private readonly opts: S3ReadClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
    this.now = opts.now ?? (() => Date.now());
    this.host = `${opts.bucket}.s3.${opts.region}.amazonaws.com`;
    this.origin = (opts.endpoint ?? `https://${this.host}`).replace(/\/+$/, '');
  }

  /** One page of ListObjectsV2. Returns object keys with LastModified + size. */
  async listObjects(prefix: string, opts: { continuationToken?: string; startAfter?: string; maxKeys?: number } = {}): Promise<{ objects: S3Object[]; nextToken: string | null }> {
    const query: Record<string, string> = { 'list-type': '2', 'max-keys': String(opts.maxKeys ?? 1000) };
    if (prefix) query.prefix = prefix;
    if (opts.continuationToken) query['continuation-token'] = opts.continuationToken;
    if (opts.startAfter) query['start-after'] = opts.startAfter;
    const res = await this.signedGet('/', query);
    if (!res.ok) throw new Error(`S3 list failed: ${res.status}`);
    return parseListXml(await res.text());
  }

  /** Download an object's bytes (may be gzip — the caller decodes). */
  async getObject(key: string): Promise<Buffer> {
    const res = await this.signedGet('/' + key.replace(/^\/+/, ''), {});
    if (!res.ok) throw new Error(`S3 get failed for ${key}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  private async signedGet(path: string, query: Record<string, string>): Promise<Response> {
    const amzDate = amzDateOf(this.now());
    const headers: Record<string, string> = { host: this.host, 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': amzDate };
    const authorization = signV4({
      method: 'GET', host: this.host, path, query, headers, payloadHash: EMPTY_SHA256,
      region: this.opts.region, service: 's3', accessKeyId: this.opts.accessKeyId, secretKey: this.opts.secretKey, amzDate,
    });
    const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
    const url = `${this.origin}${encPath(path)}${qs ? '?' + qs : ''}`;
    return this.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: authorization, 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': amzDate },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
  }
}

function amzDateOf(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Parse a ListObjectsV2 XML response — Contents (Key/LastModified/Size) + NextContinuationToken. */
export function parseListXml(xml: string): { objects: S3Object[]; nextToken: string | null } {
  const objects: S3Object[] = [];
  const tag = (block: string, name: string): string => (new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)?.[1] ?? '');
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1];
    const key = decodeXml(tag(block, 'Key'));
    if (key.length === 0) continue;
    objects.push({ key, lastModified: tag(block, 'LastModified'), size: Number(tag(block, 'Size')) || 0 });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const nextToken = truncated ? decodeXml((/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '')) || null : null;
  return { objects, nextToken };
}

const decodeXml = (s: string): string => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
