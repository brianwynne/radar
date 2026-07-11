// Honest placeholders for navigation destinations not yet built. They state clearly that
// the feature is not implemented in v1 rather than showing invented data.

export function Settings() {
  return (
    <div>
      <div className="page-head">
        <h1>Settings</h1>
        <p>Configured mappings and thresholds (Engineer).</p>
      </div>
      <div className="card">
        <div className="notice info">
          Editing is not enabled in v1. Future editable items (ASN → path mappings, capacity targets, thresholds) appear
          here as disabled controls only.
        </div>
        <button className="ghost" disabled>
          Edit ASN → path mappings
        </button>{' '}
        <button className="ghost" disabled>
          Edit capacity thresholds
        </button>
      </div>
    </div>
  );
}
