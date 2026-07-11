// RADAR DNS identity model (brief §8, and the decision to drop device/client-type).
//
// An authoritative DNS platform reliably knows only what arrives in the DNS request.
// It does NOT know device type, browser, OS, player application, user identity,
// session or HTTP headers — those belong to future telemetry adapters (e.g. Youbora),
// never to the DNS decision model. This module therefore models exactly:
//   Received: resolver IP, ECS subnet (if present), QNAME, QTYPE
//   Derived:  country, ASN, network, prefix, identity source, confidence

import type { NS1Record } from './ns1.js';

export type Confidence = 'high' | 'medium' | 'low';
export type IdentitySource = 'ecs' | 'resolver';

/** What actually arrives at the authoritative DNS server (nothing else). */
export interface DnsRequest {
  qname: string; // e.g. "live.rte.ie"
  qtype: string; // e.g. "A"
  resolverIp: string;
  ecsPresent: boolean;
  ecsPrefix?: string; // e.g. "185.2.100.0/24"
}

/** A hypothetical or observed request to evaluate. In v1 the derived fields
 *  (country/asn/network/prefix) are supplied or overridden; a geo/ASN resolution
 *  adapter replaces the supplied values later (see docs/ns1-assumptions.md). */
export interface Scenario extends DnsRequest {
  country?: string; // ISO 3166-1 alpha-2
  asn?: number;
  network?: string;
  clientPrefix?: string;
  /** answerId -> up, overriding meta.up for simulation. */
  healthOverrides?: Record<string, boolean>;
}

/** What was actually evaluated, and how it was derived (brief §8). */
export interface DerivedIdentity {
  sourceUsed: IdentitySource;
  evaluatedAddress: string;
  country?: string;
  asn?: number;
  network?: string;
  prefix?: string;
  confidence: Confidence;
  notes: string[];
}

/** Derive the evaluated identity: which address NS1 would evaluate (ECS subnet vs
 *  resolver IP, governed by the record's `use_client_subnet`), and the confidence in
 *  the country/ASN attributed to it. */
export function deriveIdentity(record: NS1Record, ctx: Scenario): DerivedIdentity {
  const notes: string[] = [];
  let sourceUsed: IdentitySource;
  let evaluatedAddress: string;

  if (ctx.ecsPresent && record.use_client_subnet === false) {
    sourceUsed = 'resolver';
    evaluatedAddress = ctx.resolverIp;
    notes.push('ECS supplied but record use_client_subnet=false → NS1 evaluates on the resolver IP.');
  } else if (ctx.ecsPresent && ctx.ecsPrefix) {
    sourceUsed = 'ecs';
    evaluatedAddress = ctx.ecsPrefix;
    notes.push('EDNS Client Subnet present and honoured (use_client_subnet not disabled).');
  } else {
    sourceUsed = 'resolver';
    evaluatedAddress = ctx.resolverIp;
    notes.push('No ECS: country/ASN describe the recursive resolver, not necessarily the viewer.');
  }

  const hasGeo = ctx.country !== undefined && ctx.asn !== undefined;
  const confidence: Confidence = !hasGeo ? 'low' : sourceUsed === 'ecs' ? 'high' : 'medium';

  if (!hasGeo)
    notes.push('Country/ASN not fully resolved for the evaluated address (a geo/ASN resolution adapter replaces the supplied values in a later version).');

  return {
    sourceUsed,
    evaluatedAddress,
    country: ctx.country,
    asn: ctx.asn,
    network: ctx.network,
    prefix: ctx.ecsPresent ? ctx.ecsPrefix : ctx.clientPrefix,
    confidence,
    notes,
  };
}
