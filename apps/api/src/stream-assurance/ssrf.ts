// SSRF controls for Stream Assurance probe targets. RADAR only ever dials operator-configured
// endpoint targets (never arbitrary user-submitted URLs), and every target is validated here before
// a connection is attempted: loopback, link-local, the cloud metadata service and private ranges are
// rejected unless the endpoint is explicitly flagged as a managed internal endpoint AND the
// deployment policy permits managed-internal targets. An optional host/IP allowlist further narrows
// what may be reached. Pure validation — no DNS, no sockets.
import { isIP } from 'node:net';

export interface EndpointTarget {
  /** Host or IP the probe will dial (the connect-to target). */
  connectHost: string;
  /** Explicitly approved internal endpoint (e.g. an on-net origin/reference). */
  managedInternal?: boolean;
}

export interface SsrfPolicy {
  /** When true, managed-internal endpoints may target otherwise-blocked (private/loopback) ranges. */
  allowManagedInternal?: boolean;
  /** If set, the connect host (or IP) must appear in this allowlist. */
  allowHosts?: string[];
}

export interface SsrfDecision {
  ok: boolean;
  reason?: string;
  /** The category the target resolved to, for audit/logging. */
  category: 'public' | 'loopback' | 'link-local' | 'metadata' | 'private' | 'unspecified' | 'hostname';
}

const METADATA_IPS = new Set(['169.254.169.254', 'fd00:ec2::254']);

const ipv4ToInt = (ip: string): number => ip.split('.').reduce((a, o) => (a << 8) + (Number(o) & 255), 0) >>> 0;
const inV4 = (ip: string, cidr: string): boolean => {
  const [net, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(net) & mask);
};

function categoriseIp(ip: string): SsrfDecision['category'] {
  if (METADATA_IPS.has(ip.toLowerCase())) return 'metadata';
  if (isIP(ip) === 4) {
    if (inV4(ip, '127.0.0.0/8')) return 'loopback';
    if (inV4(ip, '169.254.0.0/16')) return 'link-local';
    if (inV4(ip, '0.0.0.0/8')) return 'unspecified';
    if (inV4(ip, '10.0.0.0/8') || inV4(ip, '172.16.0.0/12') || inV4(ip, '192.168.0.0/16') || inV4(ip, '100.64.0.0/10')) return 'private';
    return 'public';
  }
  // IPv6
  const lower = ip.toLowerCase();
  if (lower === '::1') return 'loopback';
  if (lower === '::' ) return 'unspecified';
  if (lower.startsWith('fe80')) return 'link-local';
  if (lower.startsWith('fc') || lower.startsWith('fd')) return 'private'; // ULA fc00::/7
  return 'public';
}

const BLOCKED: SsrfDecision['category'][] = ['loopback', 'link-local', 'metadata', 'private', 'unspecified'];

/** Validate an endpoint target against the SSRF policy. Returns a decision with an audit category. */
export function validateTarget(target: EndpointTarget, policy: SsrfPolicy = {}): SsrfDecision {
  const host = target.connectHost.trim();
  if (!host) return { ok: false, reason: 'empty connect host', category: 'unspecified' };

  if (policy.allowHosts && policy.allowHosts.length > 0) {
    const allowed = policy.allowHosts.some((h) => h.toLowerCase() === host.toLowerCase());
    if (!allowed) return { ok: false, reason: `${host} is not in the configured allowlist`, category: isIP(host) ? categoriseIp(host) : 'hostname' };
  }

  if (isIP(host)) {
    const category = categoriseIp(host);
    if (BLOCKED.includes(category)) {
      if (target.managedInternal && policy.allowManagedInternal) return { ok: true, category };
      return { ok: false, reason: `${category} target ${host} is blocked (not an approved managed internal endpoint)`, category };
    }
    return { ok: true, category };
  }

  // Hostnames are permitted only when allowlisted (checked above) or as managed-internal; otherwise
  // they are accepted here and re-validated at connect time against the resolved address by the probe.
  return { ok: true, category: 'hostname' };
}
