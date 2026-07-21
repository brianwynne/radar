// GUARDED NS1 record-create path — RADAR's ONLY write to NS1, deliberately isolated from the
// GET-only read client. Nothing here can create a record unless ALL of these hold:
//   1. NS1_WRITE_ENABLED is explicitly on (default off — a write-capable key is inert without it);
//   2. live mode + a key is configured;
//   3. the domain matches the configured allow-list (default: a test namespace only); and
//   4. the domain is NOT on the hard-coded protected denylist (live steering records).
// `plan()` is pure (validates + builds the exact NS1 PUT payload, no network) so the UI can show a
// dry-run before anything is sent. `apply()` re-validates, PUTs, and is audited by the caller.
import type { Ns1Config } from './config.js';

/** A create was refused (blocked by a guard) or failed upstream. Carries a safe message; the
 *  `blocked` flag lets the route map a guard refusal to 4xx vs an upstream failure to 5xx. */
export class Ns1WriteError extends Error {
  constructor(message: string, readonly blocked: boolean) { super(message); this.name = 'Ns1WriteError'; }
}

export type CreatableType = 'A' | 'AAAA' | 'CNAME';

export interface CreateRecordInput {
  zone: string;
  domain: string;
  type: CreatableType;
  /** One answer per value: A/AAAA = addresses, CNAME = a single target hostname. */
  answers: string[];
  ttl: number;
}

export interface RecordPlan {
  allowed: boolean;
  /** Why a create is blocked (allow-list miss, protected name, write disabled, invalid). */
  blockedReason: string | null;
  target: { zone: string; domain: string; type: CreatableType };
  /** The exact NS1 request the apply step would send — shown verbatim in the dry-run. */
  request: { method: 'PUT'; path: string; body: Record<string, unknown> };
  warnings: string[];
}

export interface CreateResult {
  created: boolean;
  provenance: { source: 'ns1'; readOnly: false; write: true; notice: string; appliedAt: string };
  record: unknown;
}

export interface Ns1RecordWriter {
  writeEnabled(): boolean;
  allowList(): string[];
  plan(input: CreateRecordInput): RecordPlan;
  apply(input: CreateRecordInput): Promise<CreateResult>;
  /** Clone a source NS1 record (fetched by the caller via the read client) onto a guarded target. */
  planClone(target: CloneTarget, source: unknown): RecordPlan;
  applyClone(target: CloneTarget, source: unknown): Promise<CreateResult>;
}

// Live steering / production records that must NEVER be created or overwritten via this path, even
// if the allow-list is misconfigured. Defence-in-depth on top of the allow-list.
const PROTECTED = new Set([
  'live.rte.ie', 'livebase.nsone.rte.ie', 'liveedge.rte.ie', 'liveshed.nsone.rte.ie',
  'vod.rte.ie', 'vodbase.nsone.rte.ie', 'liveaudio.rte.ie',
]);

const host = (s: string): string => s.trim().toLowerCase().replace(/\.$/, '');
const isHostname = (h: string): boolean =>
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h);
const isIpv4 = (s: string): boolean =>
  /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s.trim());
const isIpv6 = (s: string): boolean => /^[0-9a-f:]+$/i.test(s.trim()) && s.includes(':');

/** True if `domain` matches an allow-list entry (exact, or a `*.suffix` wildcard). */
export function matchesAllow(domain: string, patterns: string[]): boolean {
  const d = host(domain);
  return patterns.some((raw) => {
    const p = host(raw);
    if (p.startsWith('*.')) { const suf = p.slice(2); return d === suf || d.endsWith(`.${suf}`); }
    return d === p;
  });
}

/** Validate the input and build the plan. Pure — never touches the network. */
export function planCreate(cfg: Ns1Config, input: CreateRecordInput): RecordPlan {
  const zone = host(input.zone);
  const domain = host(input.domain);
  const type = input.type;
  const target = { zone, domain, type };
  const warnings: string[] = [];
  const body: Record<string, unknown> = {
    zone, domain, type,
    answers: input.answers.map((a) => ({ answer: type === 'CNAME' ? [host(a)] : [a.trim()] })),
    ttl: input.ttl,
  };
  const request = { method: 'PUT' as const, path: `/zones/${encodeURIComponent(zone)}/${encodeURIComponent(domain)}/${encodeURIComponent(type)}`, body };
  const block = (reason: string): RecordPlan => ({ allowed: false, blockedReason: reason, target, request, warnings });

  if (!cfg.writeEnabled) return block('Record creation is disabled (set NS1_WRITE_ENABLED to enable the guarded write path).');
  if (cfg.mode !== 'live' || !cfg.writeApiKey) return block('NS1 is not in live mode with a write-capable key configured.');
  if (!isHostname(zone)) return block(`Invalid zone “${input.zone}”.`);
  if (!isHostname(domain)) return block(`Invalid record name “${input.domain}”.`);
  if (domain !== zone && !domain.endsWith(`.${zone}`)) return block(`“${domain}” is not inside zone “${zone}”.`);
  if (!['A', 'AAAA', 'CNAME'].includes(type)) return block(`Unsupported record type “${type}”.`);
  if (PROTECTED.has(domain)) return block(`“${domain}” is a protected live record — creation is never permitted here.`);
  if (!matchesAllow(domain, cfg.writeAllow)) return block(`“${domain}” is outside the create allow-list (${cfg.writeAllow.join(', ')}).`);

  const answers = input.answers.map((a) => a.trim()).filter(Boolean);
  if (answers.length === 0) return block('At least one answer is required.');
  if (type === 'CNAME') {
    if (answers.length !== 1) return block('A CNAME must have exactly one target.');
    if (!isHostname(host(answers[0]))) return block(`Invalid CNAME target “${answers[0]}”.`);
  } else if (type === 'A') {
    const bad = answers.find((a) => !isIpv4(a));
    if (bad) return block(`“${bad}” is not a valid IPv4 address.`);
  } else if (type === 'AAAA') {
    const bad = answers.find((a) => !isIpv6(a));
    if (bad) return block(`“${bad}” is not a valid IPv6 address.`);
  }
  if (!Number.isInteger(input.ttl) || input.ttl < 1 || input.ttl > 604800) return block('TTL must be an integer between 1 and 604800 seconds.');
  if (input.ttl < 30) warnings.push('A TTL below 30s may be floored up by many resolvers (min-TTL floor).');

  return { allowed: true, blockedReason: null, target, request, warnings };
}

// Fields that carry a record's STEERING config and are safe to clone; NS1 read-only/identity fields
// (id, zone, domain, type, ttl, timestamps, links) are set/dropped explicitly, never copied blindly.
const CLONEABLE = ['answers', 'filters', 'regions', 'meta', 'use_client_subnet', 'networks', 'override_ttl', 'override_address_records', 'blocked_tags', 'tags'] as const;

export interface CloneTarget { zone: string; domain: string; ttl?: number }

/** Build the plan for copying `source` (a raw NS1 record, read from ANY zone) onto a new target.
 *  This is a CROSS-ZONE copy — the source's answers/filters/meta are retargeted to the chosen target
 *  zone+name — NOT NS1's native clone (which is same-zone only). Pure; runs the SAME target guards as
 *  a create (allow-list, protected denylist, in-zone). Only the TARGET is guarded. */
export function planCloneRecord(cfg: Ns1Config, target: CloneTarget, source: unknown): RecordPlan {
  const zone = host(target.zone);
  const domain = host(target.domain);
  const src = (source && typeof source === 'object' ? source : {}) as Record<string, unknown>;
  const type = String(src.type ?? '').toUpperCase() as CreatableType;
  const ttl = target.ttl !== undefined ? target.ttl : typeof src.ttl === 'number' ? src.ttl : 30;
  const body: Record<string, unknown> = { zone, domain, type, ttl };
  for (const k of CLONEABLE) if (src[k] !== undefined) body[k] = src[k];
  const tgt = { zone, domain, type };
  const request = { method: 'PUT' as const, path: `/zones/${encodeURIComponent(zone)}/${encodeURIComponent(domain)}/${encodeURIComponent(type)}`, body };
  const block = (reason: string): RecordPlan => ({ allowed: false, blockedReason: reason, target: tgt, request, warnings: [] });
  const warnings: string[] = [];

  if (!src.type || !Array.isArray(src.answers)) return block('Source record could not be read (no type/answers).');
  if (!cfg.writeEnabled) return block('Record creation is disabled (set NS1_WRITE_ENABLED to enable the guarded write path).');
  if (cfg.mode !== 'live' || !cfg.writeApiKey) return block('NS1 is not in live mode with a write-capable key configured.');
  if (!['A', 'AAAA', 'CNAME'].includes(type)) return block(`Cloning ${type} records is not supported here (A/AAAA/CNAME only).`);
  if (!isHostname(zone)) return block(`Invalid target zone “${target.zone}”.`);
  if (!isHostname(domain)) return block(`Invalid target name “${target.domain}”.`);
  if (domain !== zone && !domain.endsWith(`.${zone}`)) return block(`“${domain}” is not inside zone “${zone}”.`);
  if (PROTECTED.has(domain)) return block(`“${domain}” is a protected live record — cloning onto it is never permitted.`);
  if (!matchesAllow(domain, cfg.writeAllow)) return block(`“${domain}” is outside the create allow-list (${cfg.writeAllow.join(', ')}).`);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 604800) return block('TTL must be an integer between 1 and 604800 seconds.');
  if (ttl < 30) warnings.push('A TTL below 30s may be floored up by many resolvers (min-TTL floor).');
  if (Array.isArray(src.filters) && src.filters.length) warnings.push(`Cloning the source’s ${src.filters.length}-filter steering chain — review it before creating.`);

  return { allowed: true, blockedReason: null, target: tgt, request, warnings };
}

/** Live writer — PUTs to NS1 only for an allowed plan. Isolated from the read client. */
export class HttpNs1RecordWriter implements Ns1RecordWriter {
  constructor(private readonly cfg: Ns1Config, private readonly fetchImpl: typeof fetch = fetch) {}
  writeEnabled(): boolean { return this.cfg.writeEnabled && this.cfg.mode === 'live' && !!this.cfg.writeApiKey; }
  allowList(): string[] { return this.cfg.writeAllow; }
  plan(input: CreateRecordInput): RecordPlan { return planCreate(this.cfg, input); }
  planClone(target: CloneTarget, source: unknown): RecordPlan { return planCloneRecord(this.cfg, target, source); }
  apply(input: CreateRecordInput): Promise<CreateResult> { return this.put(planCreate(this.cfg, input)); }
  applyClone(target: CloneTarget, source: unknown): Promise<CreateResult> { return this.put(planCloneRecord(this.cfg, target, source), true); }

  // The single write primitive — PUTs an allowed plan to NS1 with the write key. Never called for a
  // blocked plan (guards are re-checked here) and never for the read client's key.
  private async put(plan: RecordPlan, cloned = false): Promise<CreateResult> {
    if (!plan.allowed) throw new Ns1WriteError(plan.blockedReason ?? 'Blocked.', true);
    const res = await this.fetchImpl(`${this.cfg.baseUrl}${plan.request.path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-NSONE-Key': this.cfg.writeApiKey as string, 'User-Agent': 'radar/1.0' },
      body: JSON.stringify(plan.request.body),
      signal: AbortSignal.timeout(this.cfg.requestTimeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Ns1WriteError(`NS1 ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, false);
    }
    const record = await res.json().catch(() => ({}));
    return {
      created: true,
      provenance: { source: 'ns1', readOnly: false, write: true, notice: `${cloned ? 'Cloned to' : 'Created'} ${plan.target.domain} (${plan.target.type}) in NS1.`, appliedAt: new Date().toISOString() },
      record,
    };
  }
}

/** Not-enabled writer — plan still works (pure dry-run), apply always refuses. */
export class DisabledNs1RecordWriter implements Ns1RecordWriter {
  constructor(private readonly cfg: Ns1Config) {}
  writeEnabled(): boolean { return false; }
  allowList(): string[] { return this.cfg.writeAllow; }
  plan(input: CreateRecordInput): RecordPlan { return planCreate(this.cfg, input); }
  planClone(target: CloneTarget, source: unknown): RecordPlan { return planCloneRecord(this.cfg, target, source); }
  async apply(): Promise<CreateResult> { throw new Ns1WriteError('Record creation is not enabled.', true); }
  async applyClone(): Promise<CreateResult> { throw new Ns1WriteError('Record creation is not enabled.', true); }
}

export function createNs1RecordWriter(cfg: Ns1Config, fetchImpl: typeof fetch = fetch): Ns1RecordWriter {
  return cfg.writeEnabled && cfg.mode === 'live' && cfg.writeApiKey
    ? new HttpNs1RecordWriter(cfg, fetchImpl)
    : new DisabledNs1RecordWriter(cfg);
}
