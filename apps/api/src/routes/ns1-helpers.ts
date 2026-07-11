// Shared helpers for the NS1/DNS routes: response provenance (with the mandatory
// mock/synthetic disclosure) and safe mapping of normalised NS1 errors to HTTP status
// codes. Upstream detail (keys, headers, raw bodies, upstream 401s) is never surfaced.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Ns1Config, RadarMode } from '../ns1/config.js';
import type { Ns1Error, Ns1ErrorCode } from '../ns1/errors.js';

export interface Provenance {
  source: 'ns1';
  mode: RadarMode;
  /** True in mock mode — the payload is synthetic, non-production data. */
  synthetic: boolean;
  readOnly: true;
  endpoint: string;
  retrievedAt: string;
  disclaimer?: string;
}

const MOCK_DISCLAIMER = 'SYNTHETIC / MOCK NS1 data — not real RTÉ or NS1 configuration.';

export function buildProvenance(ns1: Ns1Config, endpoint: string, retrievedAt: string): Provenance {
  const synthetic = ns1.mode === 'mock';
  return {
    source: 'ns1',
    mode: ns1.mode,
    synthetic,
    readOnly: true,
    endpoint,
    retrievedAt,
    ...(synthetic ? { disclaimer: MOCK_DISCLAIMER } : {}),
  };
}

// An upstream NS1 auth failure is RADAR's own credential/permission problem — surface it
// as a bad gateway, never as a 401 that would imply the RADAR caller is unauthenticated.
const STATUS: Record<Ns1ErrorCode, number> = {
  NS1_NOT_FOUND: 404,
  NS1_AUTH: 502,
  NS1_RATE_LIMITED: 503,
  NS1_UPSTREAM_TIMEOUT: 504,
  NS1_INVALID_RESPONSE: 502,
  NS1_UPSTREAM_UNAVAILABLE: 502,
};

/** Send a safe error response for a normalised NS1 failure. */
export function sendNs1Error(req: FastifyRequest, reply: FastifyReply, err: Ns1Error): FastifyReply {
  const status = STATUS[err.code] ?? 502;
  if (status >= 500) {
    // Log the code and upstream status only — never the key, headers or body.
    req.log.error({ code: err.code, upstreamStatus: err.status, correlationId: req.id }, 'NS1 upstream error');
  }
  reply.code(status).send({ code: err.code, message: err.message, correlationId: req.id });
  return reply;
}
