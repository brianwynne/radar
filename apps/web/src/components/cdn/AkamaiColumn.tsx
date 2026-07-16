// Akamai column of the Commercial CDN page. The read-only Akamai connector (EdgeGrid + Reporting
// API v2, 5-minute granularity per CP code) is wired separately; until its data endpoint is live
// this column states its status honestly rather than showing fabricated figures. Structured to
// mirror FastlyColumn so it drops into the same side-by-side layout.
export function AkamaiColumn() {
  return (
    <section className="cdn-col card">
      <header className="cdn-col-head">
        <div>
          <h2 style={{ margin: 0 }}>Akamai</h2>
          <div className="muted" style={{ fontSize: '0.72rem' }}>commercial CDN · delivery platform NS1 can steer to</div>
        </div>
        <span className="badge neutral">NOT CONNECTED</span>
      </header>

      <div className="notice info">
        Akamai connector pending. EdgeGrid authentication is verified, but the API client needs the
        read-only <strong>Reporting API</strong> grant (and <strong>CP Codes &amp; Reporting Groups</strong>
        to list services) before per-CP-code delivery telemetry can be shown.
      </div>
      <div className="center-note" style={{ padding: '1.5rem 0' }}>
        Once connected: per-service traffic, cache hit ratio, bandwidth and a response-code panel at
        Akamai&rsquo;s 5-minute reporting granularity (Akamai has no per-second stream like Fastly).
      </div>
    </section>
  );
}
