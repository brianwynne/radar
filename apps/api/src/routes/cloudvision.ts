// Read-only CloudVision network-telemetry routes. INFORMATIONAL only — RADAR issues no
// device, CloudVision or NS1 writes. Serves the latest polled snapshot + bounded history +
// connector status. Configured facts (speed, classification) are returned distinctly from
// observed telemetry (throughput, state). Engineering detail (warnings, classification
// source) is gated on ns1.detail.read. Never returns the endpoint, token or raw wire bodies.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guards.js';
import type { CloudVisionPoller } from '../cloudvision/poller.js';
import type { BgpPeer, CloudVisionSource, LinkGroupState, NetworkDevice, NetworkInterface } from '../cloudvision/types.js';

export interface CloudVisionRouteOptions {
  poller?: CloudVisionPoller;
  mode?: CloudVisionSource;
}

const INFORMATIONAL_NOTICE = 'Network telemetry is read-only and informational. RADAR issues no device, CloudVision or NS1 writes.';

const HEALTH = ['healthy', 'warning', 'critical', 'down', 'unavailable', 'unknown'] as const;
const LINK_TYPES = ['PRIVATE_PEERING', 'IX_PEERING', 'TRANSIT', 'INTERNAL', 'UNKNOWN'] as const;
const BGP_STATES = ['ESTABLISHED', 'IDLE', 'CONNECT', 'ACTIVE', 'OPENSENT', 'OPENCONFIRM', 'UNKNOWN'] as const;

const interfaceQuery = z.object({
  deviceId: z.string().max(120).optional(),
  provider: z.string().max(120).optional(),
  linkType: z.enum(LINK_TYPES).optional(),
  status: z.enum(HEALTH).optional(),
  unknownOnly: z.enum(['true', 'false']).optional(),
});
const bgpQuery = z.object({
  deviceId: z.string().max(120).optional(),
  provider: z.string().max(120).optional(),
  state: z.enum(BGP_STATES).optional(),
  established: z.enum(['true', 'false']).optional(),
});
const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(1000).optional() });

const badRequest = (issues: z.ZodError['issues']) => issues.map((i) => `${i.path.join('.') || '(query)'}: ${i.message}`).join('; ');

function presentDevice(d: NetworkDevice, detail: boolean): Record<string, unknown> {
  const core = { id: d.id, hostname: d.hostname, modelName: d.modelName, softwareVersion: d.softwareVersion, streaming: d.streaming, reachable: d.reachable, freshness: d.freshness, observedAt: d.observedAt, source: d.provenance.source };
  return detail ? { ...core, warnings: d.warnings, provenance: d.provenance } : core;
}

function presentInterface(i: NetworkInterface, detail: boolean): Record<string, unknown> {
  const core = {
    deviceId: i.deviceId, deviceHostname: i.deviceHostname, name: i.name, description: i.description,
    provider: i.provider, location: i.location, linkType: i.linkType, memberOf: i.memberOf, adminState: i.adminState, operState: i.operState,
    speedBps: i.speedBps, inBps: i.inBps, outBps: i.outBps, primaryBps: i.primaryBps, bandwidthSource: i.bandwidthSource,
    utilisationPercent: i.utilisationPercent, headroomBps: i.headroomBps,
    inErrors: i.inErrors, outErrors: i.outErrors, inDiscards: i.inDiscards, outDiscards: i.outDiscards,
    status: i.status, freshness: i.freshness, observedAt: i.observedAt, source: i.provenance.source,
  };
  return detail ? { ...core, classificationSource: i.classificationSource, warnings: i.warnings, provenance: i.provenance } : core;
}

function presentBgp(p: BgpPeer, detail: boolean): Record<string, unknown> {
  const core = {
    deviceId: p.deviceId, deviceHostname: p.deviceHostname, peerAddress: p.peerAddress, peerAsn: p.peerAsn, provider: p.provider,
    state: p.state, established: p.established, uptimeSeconds: p.uptimeSeconds, prefixesReceived: p.prefixesReceived, prefixesAdvertised: p.prefixesAdvertised,
    status: p.status, freshness: p.freshness, observedAt: p.observedAt, source: p.provenance.source,
  };
  return detail ? { ...core, warnings: p.warnings, provenance: p.provenance } : core;
}

const presentLinkGroup = (g: LinkGroupState): Record<string, unknown> => ({
  key: g.key, label: g.label, linkType: g.linkType, capacityBps: g.capacityBps, currentBps: g.currentBps,
  utilisationPercent: g.utilisationPercent, headroomBps: g.headroomBps, healthyLinks: g.healthyLinks, totalLinks: g.totalLinks,
  status: g.status, freshness: g.freshness, interfaceIds: g.interfaceIds, provenance: g.provenance,
});

export const cloudVisionRoutes: FastifyPluginAsync<CloudVisionRouteOptions> = async (app, opts) => {
  // Derive the mode from the poller's current source so it reflects a runtime reconfigure
  // (an Engineer switching mock↔live), falling back to the registration-time mode.
  const currentMode = (): CloudVisionSource => opts.poller?.status().source ?? opts.mode ?? 'disabled';
  const envelope = (retrievedAt: string) => ({ source: 'radar' as const, telemetryMode: currentMode(), readOnly: true, informationalOnly: true, notice: INFORMATIONAL_NOTICE, retrievedAt });
  const schema = (summary: string, description: string) => ({ tags: ['network-telemetry'], summary, description, security: [{ bearerAuth: [] }] });
  const now = () => new Date().toISOString();
  const latest = () => opts.poller?.getLatest() ?? null;

  app.get(
    '/network/status',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('CloudVision connector status + snapshot summary', 'Read-only connector status (running, last poll, failures, snapshot age) and the latest snapshot summary/freshness/completeness.') },
    async () => {
      const snap = latest();
      const status = opts.poller?.status() ?? { enabled: false, running: false, source: currentMode(), intervalMs: 0, lastPollAt: null, lastSuccessAt: null, lastDurationMs: null, consecutiveFailures: 0, lastError: null, snapshotAgeSeconds: null, historyLength: 0, deviceCount: 0, interfaceCount: 0, unknownInterfaceCount: 0 };
      return {
        provenance: envelope(now()),
        status,
        summary: snap?.summary ?? null,
        freshness: snap?.freshness ?? null,
        completeness: snap?.completeness ?? null,
        warnings: snap?.warnings ?? [],
        capturedAt: snap?.capturedAt ?? null,
      };
    },
  );

  app.get(
    '/network/devices',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('Edge device inventory', 'Read-only edge-router inventory (hostname, model, software, streaming/reachable, freshness).') },
    async (req) => {
      const detail = req.principal!.permissions.includes('ns1.detail.read');
      const items = latest()?.devices ?? [];
      return { provenance: envelope(now()), count: items.length, items: items.map((d) => presentDevice(d, detail)) };
    },
  );

  app.get(
    '/network/interfaces',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('Interface telemetry', 'Read-only per-interface state: provider/link-type (classified), capacity vs observed throughput, utilisation, headroom, errors/discards, status, freshness. Filters: deviceId, provider, linkType, status, unknownOnly.') },
    async (req, reply) => {
      const parsed = interfaceQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: badRequest(parsed.error.issues), correlationId: req.id });
      const q = parsed.data;
      const detail = req.principal!.permissions.includes('ns1.detail.read');
      let items = latest()?.interfaces ?? [];
      if (q.deviceId) items = items.filter((i) => i.deviceId === q.deviceId);
      if (q.provider) items = items.filter((i) => i.provider === q.provider);
      if (q.linkType) items = items.filter((i) => i.linkType === q.linkType);
      if (q.status) items = items.filter((i) => i.status === q.status);
      if (q.unknownOnly === 'true') items = items.filter((i) => i.linkType === 'UNKNOWN');
      return { provenance: envelope(now()), count: items.length, items: items.map((i) => presentInterface(i, detail)) };
    },
  );

  app.get(
    '/network/link-groups',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('Link groups (provider aggregates)', 'Read-only provider/link-type aggregates. Utilisation is total-throughput / total-capacity (never an average of percentages).') },
    async () => {
      const items = latest()?.linkGroups ?? [];
      return { provenance: envelope(now()), count: items.length, items: items.map(presentLinkGroup) };
    },
  );

  app.get(
    '/network/bgp-peers',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('BGP peer telemetry', 'Read-only BGP peer state (peer, ASN, session state, uptime, prefixes received/advertised). Filters: deviceId, provider, state, established.') },
    async (req, reply) => {
      const parsed = bgpQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: badRequest(parsed.error.issues), correlationId: req.id });
      const q = parsed.data;
      const detail = req.principal!.permissions.includes('ns1.detail.read');
      let items = latest()?.bgpPeers ?? [];
      if (q.deviceId) items = items.filter((p) => p.deviceId === q.deviceId);
      if (q.provider) items = items.filter((p) => p.provider === q.provider);
      if (q.state) items = items.filter((p) => p.state === q.state);
      if (q.established !== undefined) items = items.filter((p) => p.established === (q.established === 'true'));
      return { provenance: envelope(now()), count: items.length, items: items.map((p) => presentBgp(p, detail)) };
    },
  );

  app.get(
    '/network/history',
    { preHandler: requirePermission('topology.summary.read'), schema: schema('Telemetry history (time-series)', 'Read-only bounded in-memory history of edge/peering/transit throughput, headroom and unhealthy counts for the time-series charts. Filter: limit.') },
    async (req, reply) => {
      const parsed = historyQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: badRequest(parsed.error.issues), correlationId: req.id });
      const items = opts.poller?.getHistory(parsed.data.limit) ?? [];
      return { provenance: envelope(now()), count: items.length, items };
    },
  );
};
