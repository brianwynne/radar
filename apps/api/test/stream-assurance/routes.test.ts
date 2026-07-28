// Stream Assurance routes: RBAC, profile create, and an audited diagnostic run that fetches two mock
// CDNs and persists findings — the incident classified through the full API path.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { StreamAssuranceService } from '../../src/stream-assurance/service.js';
import { StreamAssuranceScheduler } from '../../src/stream-assurance/scheduler.js';
import type { NewStreamAssuranceProfile, NewStreamAssuranceRun, StreamAlertRow, StreamAssuranceProfileRow, StreamAssuranceRepository, StreamAssuranceRunRow, UpsertStreamAlert } from '@radar/data';
import { buildFragment, buildInit } from './init-fixture.js';

const CURRENT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OLD = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const STALE_MPD = `<?xml version="1.0"?>
<MPD type="dynamic" publishTime="2020-01-01T00:00:00Z" minimumUpdatePeriod="PT6S">
  <Period><AdaptationSet><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/></AdaptationSet></Period>
</MPD>`;
// Two CDNs serving the SAME service but a drifted manifest generation (different default_KID) — the
// current generation on cdn1, a stale one cached on cdn2. publishTime == the run's `now`, so neither
// trips the freshness rule; only the cross-CDN KID drift (SA-XCDN-001) should fire.
const mpdGen = (kid: string): string => `<?xml version="1.0"?>
<MPD type="dynamic" publishTime="2026-07-27T00:00:00Z" minimumUpdatePeriod="PT6S">
  <Period><AdaptationSet>
    <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cbcs" cenc:default_KID="${kid}"/>
    <Representation id="v1" bandwidth="800000"/><Representation id="v2" bandwidth="2400000"/>
  </AdaptationSet></Period>
</MPD>`;
const CURRENT_MPD = mpdGen('11111111-1111-1111-1111-111111111111');
const DRIFT_MPD = mpdGen('22222222-2222-2222-2222-222222222222');
const HLS_MEDIA_FAIRPLAY = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:6.0,
s1.m4s
`;

class FakeRepo implements StreamAssuranceRepository {
  profiles = new Map<string, StreamAssuranceProfileRow>();
  runs: NewStreamAssuranceRun[] = [];
  async upsertProfile(p: NewStreamAssuranceProfile) { this.profiles.set(p.id, { id: p.id, name: p.name, config: p.config, enabled: p.enabled ?? true, createdAt: new Date(), updatedAt: new Date() }); }
  async listProfiles() { return [...this.profiles.values()]; }
  async getProfile(id: string) { return this.profiles.get(id) ?? null; }
  async deleteProfile(id: string) { this.profiles.delete(id); }
  async insertRun(r: NewStreamAssuranceRun) { this.runs.push(r); }
  async latestRun(pid: string): Promise<StreamAssuranceRunRow | null> { const r = this.runs.filter((x) => x.profileId === pid).at(-1); return r ? (r as StreamAssuranceRunRow) : null; }
  async listRuns(pid: string) { return this.runs.filter((x) => x.profileId === pid) as StreamAssuranceRunRow[]; }
  async pruneRuns() { return 0; }
  alerts = new Map<string, StreamAlertRow>();
  async listAlertsByProfile(pid: string) { return [...this.alerts.values()].filter((a) => a.profileId === pid); }
  async listOpenAlerts(pid?: string) { return [...this.alerts.values()].filter((a) => a.state !== 'resolved' && (!pid || a.profileId === pid)); }
  async getAlert(id: string) { return this.alerts.get(id) ?? null; }
  async upsertAlert(a: UpsertStreamAlert) { const prev = this.alerts.get(a.id); this.alerts.set(a.id, { ...a, acknowledgedBy: prev?.acknowledgedBy ?? null, acknowledgedAt: prev?.acknowledgedAt ?? null } as StreamAlertRow); }
  async acknowledgeAlert(id: string, by: string) { const a = this.alerts.get(id); if (!a || a.state === 'resolved') return a ?? null; a.state = 'acknowledged'; a.acknowledgedBy = by; a.acknowledgedAt = new Date(); return a; }
  async resolveAlert(id: string) { const a = this.alerts.get(id); if (!a) return null; a.state = 'resolved'; return a; }
  async pruneAlerts() { return 0; }
}

let server: http.Server; let port: number;
const audit = { record: vi.fn(async () => ({} as never)) };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.includes('.mpd')) {
      const body = req.headers.host === 'live.rte.cdn1' ? CURRENT_MPD : req.headers.host === 'live.rte.cdn2' ? DRIFT_MPD : STALE_MPD;
      res.writeHead(200, { 'content-type': 'application/dash+xml' }); res.end(body); return;
    }
    if (req.url?.endsWith('.m3u8')) { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); res.end(req.url.includes('master') ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.64001f"\nmedia.m3u8\n' : HLS_MEDIA_FAIRPLAY); return; }
    if (req.url?.endsWith('.m4s')) {
      // The lagging CDN (cdn2) serves an older fragment generation for the same URL.
      const [seq, dts] = req.headers.host === 'live.rte.cdn2' ? [99, 891000] : [100, 900000];
      res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(buildFragment(seq, dts)); return;
    }
    const host = req.headers.host;
    if (host === 'live.rte.host') { res.writeHead(200, { 'x-cache': 'HIT', 'last-modified': 'Sun, 26 Jul 2026 12:00:00 GMT' }); res.end(buildInit(CURRENT)); }
    else { res.writeHead(200, { 'x-cache': 'TCP_MISS from edge', 'x-cache-remote': 'TCP_MISS from parent', 'last-modified': 'Wed, 01 Jan 2026 00:00:00 GMT' }); res.end(buildInit(OLD)); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const repo = new FakeRepo();
const seedProfile = () => repo.upsertProfile({ id: 'rte-test', name: 'RTÉ Test', config: { endpoints: [
  { endpointId: 'fastly', provider: 'fastly', role: 'reference', publicUrl: 'http://live.rte.ie/init.mp4', connectHost: '127.0.0.1', connectPort: port, hostHeader: 'live.rte.host', managedInternal: true, originHost: 'live.rte.host' },
  { endpointId: 'akamai', provider: 'akamai', role: 'candidate', publicUrl: 'http://live.rte.ie/init.mp4', connectHost: '127.0.0.1', connectPort: port, hostHeader: 'live.rte.ie', managedInternal: true, originHost: 'live.rte.host' },
] } });

const noopTimers = { setIntervalImpl: () => ({}) as never, clearIntervalImpl: () => {}, setTimeoutImpl: () => ({}) as never, clearTimeoutImpl: () => {} };
async function app(role: string, auth = true): Promise<FastifyInstance> {
  const service = new StreamAssuranceService(repo, { allowManagedInternal: true }, { now: () => Date.parse('2026-07-27T00:00:00Z') });
  const scheduler = new StreamAssuranceScheduler(repo, service, noopTimers);
  const a = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: String(auth), RADAR_DEV_ROLE: role }), {
    streamAssuranceRepository: repo, streamAssuranceService: service, streamAssuranceScheduler: scheduler, database: { audit } as never,
  });
  await a.ready();
  return a;
}

describe('Stream Assurance routes', () => {
  it('serves the rule catalogue and lists profiles to a NOC viewer; blocks unauth', async () => {
    seedProfile();
    const noAuth = await app('NOC_VIEWER', false);
    expect((await noAuth.inject({ url: '/api/v1/stream-assurance/profiles' })).statusCode).toBe(401);
    await noAuth.close();

    const a = await app('NOC_VIEWER');
    const rules = await a.inject({ url: '/api/v1/stream-assurance/rules' });
    expect(rules.statusCode).toBe(200);
    expect(rules.json().rules.find((r: { id: string }) => r.id === 'SA-CDN-001')).toBeDefined();
    const list = await a.inject({ url: '/api/v1/stream-assurance/profiles' });
    expect(list.json().profiles[0]).toMatchObject({ id: 'rte-test', endpointCount: 2 });
    await a.close();
  });

  it('enforces RBAC: configure needs Engineer, run needs Viewing Engineer', async () => {
    const noc = await app('NOC_VIEWER');
    expect((await noc.inject({ method: 'POST', url: '/api/v1/stream-assurance/profiles', payload: { id: 'x', name: 'x', config: { endpoints: [] } } })).statusCode).toBe(403);
    expect((await noc.inject({ method: 'POST', url: '/api/v1/stream-assurance/profiles/rte-test/run' })).statusCode).toBe(403);
    await noc.close();

    const eng = await app('ENGINEER');
    const created = await eng.inject({ method: 'POST', url: '/api/v1/stream-assurance/profiles', payload: { id: 'rte-two', name: 'RTÉ Two', config: { endpoints: [], tags: ['test'] } } });
    expect(created.statusCode).toBe(201);
    expect(repo.profiles.has('rte-two')).toBe(true);
    await eng.close();
  });

  it('a Viewing Engineer runs a profile: incident is classified, persisted and audited', async () => {
    seedProfile();
    audit.record.mockClear();
    const ve = await app('VIEWING_ENGINEER');
    const res = await ve.inject({ method: 'POST', url: '/api/v1/stream-assurance/profiles/rte-test/run' });
    expect(res.statusCode).toBe(200);
    const run = res.json().run;
    expect(run.status).toBe('findings');
    const f = run.findings.find((x: { endpointId: string }) => x.endpointId === 'akamai');
    expect(f.classification).toBe('ORIGIN_VARIANT_MISMATCH');
    expect(f.ruleId).toBe('SA-CDN-001');
    // Observations carry the parsed init metadata for the CMAF/DRM inspector (KID, never keys).
    const refObs = run.observations.find((o: { endpointId: string }) => o.endpointId === 'fastly');
    expect(refObs.init).toBeTruthy();
    expect(refObs.init.cenc.defaultKid).toBe(refObs.kid);
    expect(JSON.stringify(refObs.init)).not.toMatch(/"key"/i);
    // Redacted response headers are captured for diagnosis (the reference served an edge HIT).
    expect(refObs.headers['x-cache']).toBe('HIT');
    // Persisted + retrievable as the latest run.
    const latest = await ve.inject({ url: '/api/v1/stream-assurance/profiles/rte-test/latest' });
    expect(latest.json().run.findingCount).toBeGreaterThanOrEqual(1);
    // Audited.
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'stream-assurance.run', outcome: 'success' }));
    await ve.close();

    // A non-existent profile → 404.
    const ve2 = await app('VIEWING_ENGINEER');
    expect((await ve2.inject({ method: 'POST', url: '/api/v1/stream-assurance/profiles/nope/run' })).statusCode).toBe(404);
    await ve2.close();
  });

  it('alert lifecycle across runs: observed → active → acknowledged → resolved; event mode', async () => {
    seedProfile(); repo.alerts.clear(); repo.runs = [];
    const ve = await app('VIEWING_ENGINEER');

    // Run 1 → the finding is observed (critical needs 2 occurrences before active).
    await ve.inject({ method: 'POST', url: '/api/v1/stream-assurance/profiles/rte-test/run' });
    let alerts = (await ve.inject({ url: '/api/v1/stream-assurance/alerts?profileId=rte-test' })).json();
    expect(alerts.count).toBe(1);
    const alert = alerts.alerts[0];
    expect(alert.classification).toBe('ORIGIN_VARIANT_MISMATCH');
    expect(alert.state).toBe('observed');

    // Run 2 → active.
    await ve.inject({ method: 'POST', url: '/api/v1/stream-assurance/profiles/rte-test/run' });
    alerts = (await ve.inject({ url: '/api/v1/stream-assurance/alerts' })).json();
    expect(alerts.alerts.find((a: { id: string }) => a.id === alert.id).state).toBe('active');

    // Acknowledge (audited).
    audit.record.mockClear();
    const ack = await ve.inject({ method: 'POST', url: `/api/v1/stream-assurance/alerts/${encodeURIComponent(alert.id)}/ack` });
    expect(ack.json().alert.state).toBe('acknowledged');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'stream-assurance.alert.ack' }));

    // Resolve → no longer open.
    await ve.inject({ method: 'POST', url: `/api/v1/stream-assurance/alerts/${encodeURIComponent(alert.id)}/resolve` });
    expect((await ve.inject({ url: '/api/v1/stream-assurance/alerts' })).json().count).toBe(0);

    // Event mode on → reflected in the alerts feed.
    const em = await ve.inject({ method: 'POST', url: '/api/v1/stream-assurance/profiles/rte-test/event-mode', payload: { enabled: true, durationMinutes: 5 } });
    expect(em.statusCode).toBe(200);
    expect((await ve.inject({ url: '/api/v1/stream-assurance/alerts' })).json().eventModeProfiles).toContain('rte-test');
    await ve.close();
  });

  it('discover: validates the URL, enforces RBAC, and maps an SSRF block to 502', async () => {
    const noc = await app('NOC_VIEWER');
    expect((await noc.inject({ method: 'POST', url: '/api/v1/stream-assurance/discover', payload: { mpdUrl: 'https://x/y.mpd' } })).statusCode).toBe(403);
    await noc.close();

    const ve = await app('VIEWING_ENGINEER');
    expect((await ve.inject({ method: 'POST', url: '/api/v1/stream-assurance/discover', payload: { mpdUrl: 'not-a-url' } })).statusCode).toBe(400);
    // A loopback manifest host is refused by the SSRF guard → 502 DISCOVER_FAILED (not a crash).
    const blocked = await ve.inject({ method: 'POST', url: '/api/v1/stream-assurance/discover', payload: { mpdUrl: 'http://127.0.0.1:9/live.mpd' } });
    expect(blocked.statusCode).toBe(502);
    expect(blocked.json().message).toMatch(/SSRF/i);
    await ve.close();
  });

  it('channel routes: list + resolve (RBAC + validation), service stubbed', async () => {
    const svc = new StreamAssuranceService(repo, { allowManagedInternal: true }, { now: () => Date.parse('2026-07-27T00:00:00Z') });
    vi.spyOn(svc, 'listChannels').mockResolvedValue([
      { guid: 'RTEONE', title: 'RTÉ One', callSign: 'RTEONE', isVirtual: false, daiKey: 'K', delivery: 'dai' },
      { guid: 'RTENewsChannel', title: 'RTÉ News', callSign: 'RTENewsNow', isVirtual: false, daiKey: null, delivery: 'direct' },
    ]);
    vi.spyOn(svc, 'resolveChannel').mockResolvedValue({
      callSign: 'RTEONE', mediaPid: 'pid', entryUrl: 'https://www.rte.ie/x.mpd?token1=t', finalManifestUrl: 'https://dai.google.com/…/manifest.mpd', redirects: [], adTags: [],
      manifest: { manifestUrl: 'f', baseUrl: 'https://live.rte.ie/live/b/vc11/vc11.isml/dash/', presentation: 'dynamic', drm: { defaultKid: null, systems: [] }, representations: [] },
    });
    const build = (role: string) => buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', RADAR_DEV_AUTH: 'true', RADAR_DEV_ROLE: role }), {
      streamAssuranceRepository: repo, streamAssuranceService: svc, streamAssuranceScheduler: new StreamAssuranceScheduler(repo, svc, noopTimers), database: { audit } as never,
    });

    const noc = await build('NOC_VIEWER'); await noc.ready();
    expect((await noc.inject({ url: '/api/v1/stream-assurance/channels' })).statusCode).toBe(403);
    await noc.close();

    const ve = await build('VIEWING_ENGINEER'); await ve.ready();
    const list = await ve.inject({ url: '/api/v1/stream-assurance/channels' });
    expect(list.statusCode).toBe(200);
    expect(list.json().channels.map((c: { delivery: string }) => c.delivery)).toEqual(['dai', 'direct']);
    const res = await ve.inject({ method: 'POST', url: '/api/v1/stream-assurance/resolve-channel', payload: { callSign: 'RTEONE' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().resolved.manifest.baseUrl).toContain('live.rte.ie');
    expect((await ve.inject({ method: 'POST', url: '/api/v1/stream-assurance/resolve-channel', payload: {} })).statusCode).toBe(400);
    await ve.close();
  });

  it('a run with manifest URLs also validates DASH/HLS and cross-protocol', async () => {
    repo.runs = []; repo.alerts.clear();
    await repo.upsertProfile({ id: 'rte-manifests', name: 'M', config: {
      endpoints: [{ endpointId: 'ref', provider: 'fastly', role: 'reference', publicUrl: 'http://live.rte.ie/init.mp4', connectHost: '127.0.0.1', connectPort: port, hostHeader: 'live.rte.host', managedInternal: true }],
      manifests: { dashMpdUrl: 'http://live.rte.ie/live.mpd', hlsMasterUrl: 'http://live.rte.ie/hls/master.m3u8', hlsMediaUrl: 'http://live.rte.ie/hls/media.m3u8' },
    } });
    const ve = await app('VIEWING_ENGINEER');
    const res = await ve.inject({ method: 'POST', url: '/api/v1/stream-assurance/profiles/rte-manifests/run' });
    expect(res.statusCode).toBe(200);
    const ids = res.json().run.findings.map((f: { ruleId: string }) => f.ruleId);
    expect(ids).toContain('SA-DASH-001'); // stale dynamic MPD
    expect(ids).toContain('SA-XDRM-001'); // DASH Widevine vs HLS FairPlay
    await ve.close();
  });

  it('fetches the manifest via every CDN and flags cross-CDN manifest drift on the lagging CDN', async () => {
    repo.runs = []; repo.alerts.clear();
    await repo.upsertProfile({ id: 'rte-xcdn', name: 'X', config: {
      endpoints: [
        { endpointId: 'fastly', provider: 'fastly', role: 'reference', publicUrl: 'http://live.rte.ie/init.mp4', connectHost: '127.0.0.1', connectPort: port, hostHeader: 'live.rte.cdn1', managedInternal: true },
        { endpointId: 'akamai', provider: 'akamai', role: 'candidate', publicUrl: 'http://live.rte.ie/init.mp4', connectHost: '127.0.0.1', connectPort: port, hostHeader: 'live.rte.cdn2', managedInternal: true },
      ],
      manifests: { dashMpdUrl: 'http://live.rte.ie/live.mpd', mediaFragmentUrl: 'http://live.rte.ie/seg.m4s' },
    } });
    const ve = await app('VIEWING_ENGINEER');
    const res = await ve.inject({ method: 'POST', url: '/api/v1/stream-assurance/profiles/rte-xcdn/run' });
    expect(res.statusCode).toBe(200);
    const runOut = res.json().run as { findings: { ruleId: string; endpointId: string; classification: string }[]; observations: { endpointId: string; media: { requested: { dash: boolean; fragment: boolean }; dash: { presentation: string } | null; fragment: { baseMediaDecodeTime: number } | null } | null }[] };
    // Media checks are summarised on each observation (positive display, not only findings).
    const cdn2 = runOut.observations.find((o) => o.endpointId === 'akamai')!;
    expect(cdn2.media).toBeTruthy();
    expect(cdn2.media!.requested).toMatchObject({ dash: true, fragment: true });
    expect(cdn2.media!.dash?.presentation).toBe('dynamic');
    expect(cdn2.media!.fragment?.baseMediaDecodeTime).toBe(891000);
    const findings = runOut.findings;
    const xcdn = findings.find((f) => f.ruleId === 'SA-XCDN-001');
    expect(xcdn).toBeTruthy();
    expect(xcdn!.classification).toBe('DRM_KID_MISMATCH');
    expect(xcdn!.endpointId).toBe('akamai'); // the drifted (candidate) CDN, not the reference
    // The sampled media fragment also drifts on the lagging CDN → SA-FRAG-001.
    const frag = findings.find((f) => f.ruleId === 'SA-FRAG-001');
    expect(frag).toBeTruthy();
    expect(frag!.classification).toBe('FRAGMENT_TIMELINE_DRIFT');
    expect(frag!.endpointId).toBe('akamai');
    // Freshness rule stays quiet: both manifests were published at the run's `now`.
    expect(findings.find((f) => f.ruleId === 'SA-DASH-001')).toBeUndefined();
    await ve.close();
  });
});
