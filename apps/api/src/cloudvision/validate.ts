// One-shot, READ-ONLY CloudVision validation command. Validates configuration, authenticates,
// discovers routers, retrieves interfaces + BGP, computes throughput/capacity/headroom, reports
// freshness/completeness, and performs ZERO write operations (the client is GET-only by
// construction). Exits non-zero on: authentication failure, missing routers, missing critical
// interfaces, schema incompatibility (no devices), or critically stale telemetry.
//
// Usage:  tsx src/cloudvision/validate.ts   (npm run -w @radar/api cloudvision:validate)
// The token/endpoint are never printed (only the endpoint host, for live).
import { loadCloudVisionConfig } from './config.js';
import { createCloudVisionClient } from './index.js';
import { CloudVisionError } from './errors.js';
import { formatBps } from './format-cli.js';
import type { LinkType } from './types.js';

const EXTERNAL: LinkType[] = ['PRIVATE_PEERING', 'IX_PEERING', 'TRANSIT'];

async function main(): Promise<void> {
  const config = loadCloudVisionConfig(); // throws (clearly) on invalid live config
  const line = (s: string) => process.stdout.write(`${s}\n`);

  line('CloudVision connector validation (read-only; zero write operations)');
  line(`  enabled: ${config.enabled}`);
  if (!config.enabled) {
    line('  Connector is disabled (CLOUDVISION_ENABLED=false) — nothing to validate.');
    process.exit(0);
  }
  line(`  mode: ${config.mode}`);
  if (config.mode === 'live' && config.endpoint) line(`  endpoint host: ${new URL(config.endpoint).host}`);
  line(`  expected devices: ${config.edgeDeviceIds.length > 0 ? config.edgeDeviceIds.join(', ') : '(all discovered)'}`);
  line(`  max sample age: ${config.maxSampleAgeSeconds}s`);

  const client = createCloudVisionClient(config, { logger: { warn: (o, m) => process.stderr.write(`  warn: ${m} ${JSON.stringify(o)}\n`) } });

  // Authenticate + retrieve (a single read; the client issues only GETs).
  let snap;
  try {
    snap = await client.getSnapshot('cloudvision-validate');
  } catch (err) {
    const code = err instanceof CloudVisionError ? err.code : 'INTERNAL_ERROR';
    process.stderr.write(`FAIL — could not retrieve telemetry: ${code}\n`);
    process.exit(2);
  }

  // ---- Report -------------------------------------------------------------------------------
  const external = snap.interfaces.filter((i) => EXTERNAL.includes(i.linkType));
  const established = snap.bgpPeers.filter((p) => p.established).length;
  const unavailableBw = snap.interfaces.filter((i) => i.bandwidthSource === 'UNAVAILABLE');
  const unknown = snap.interfaces.filter((i) => i.linkType === 'UNKNOWN');

  line('');
  line(`  devices discovered: ${snap.devices.length}`);
  for (const d of snap.devices) line(`    - ${d.id} ${d.hostname} (${d.modelName ?? 'model?'}, ${d.streaming ? 'streaming' : 'NOT streaming'})`);
  line(`  interfaces: ${snap.interfaces.length}  (external ${external.length}, unknown ${unknown.length})`);
  line(`  BGP peers: ${snap.bgpPeers.length}  (established ${established})`);
  line(`  total edge throughput: ${formatBps(snap.summary.totalEdgeThroughputBps)}`);
  line(`    peering: ${formatBps(snap.summary.totalPeeringThroughputBps)}   transit: ${formatBps(snap.summary.totalTransitThroughputBps)}`);
  line(`  operational capacity: ${formatBps(snap.summary.operationalCapacityBps)}   headroom: ${formatBps(snap.summary.operationalHeadroomBps)}`);
  line(`  freshness: ${snap.freshness.level}${snap.freshness.ageSeconds !== null ? ` (${Math.round(snap.freshness.ageSeconds)}s)` : ''}   completeness: ${snap.completeness.level}`);
  if (unknown.length > 0) line(`  UNCLASSIFIED interfaces: ${unknown.map((i) => `${i.deviceHostname}/${i.name}`).join(', ')}`);
  if (unavailableBw.length > 0) line(`  UNAVAILABLE bandwidth: ${unavailableBw.map((i) => `${i.deviceHostname}/${i.name}`).join(', ')}`);
  for (const w of snap.warnings) line(`  warning: ${w}`);

  // ---- Pass/fail checks ---------------------------------------------------------------------
  const failures: string[] = [];
  const missing = config.edgeDeviceIds.filter((id) => !snap.devices.some((d) => d.id === id));
  if (missing.length > 0) failures.push(`missing configured routers: ${missing.join(', ')}`);
  if (snap.devices.length === 0) failures.push('no devices in snapshot (schema incompatibility or empty response)');
  if (external.length === 0) failures.push('no peering/transit interfaces discovered (missing critical interfaces)');
  if (snap.freshness.level === 'STALE' || snap.freshness.level === 'UNAVAILABLE') failures.push(`critically stale telemetry (freshness ${snap.freshness.level})`);

  line('');
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`FAIL — ${f}\n`);
    process.exit(1);
  }
  line('PASS — configuration valid, telemetry retrieved read-only, no write operations performed.');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`CloudVision validation error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
