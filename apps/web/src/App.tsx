import { Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { AppShell } from './components/AppShell';
import { Dashboard } from './pages/Dashboard';
import { RealtaCacheLb } from './pages/RealtaCacheLb';
import { Ns1Explorer } from './pages/Ns1Explorer';
import { ValidationNs1 } from './pages/ValidationNs1';
import { ExplainDns } from './pages/ExplainDns';
import { Steering } from './pages/Steering';
import { LiveSteering } from './pages/LiveSteering';
import { Topology } from './pages/Topology';
import { NetworkTelemetry } from './pages/NetworkTelemetry';
import { ConnectorSettings } from './pages/ConnectorSettings';
import { Activity } from './pages/Activity';
import { SnapshotDetail } from './pages/SnapshotDetail';
import { Settings } from './pages/Placeholders';

export function App() {
  const { loading, unauthenticated, error } = useAuth();

  if (loading) return <div className="center-note">Loading RADAR…</div>;
  if (unauthenticated)
    return (
      <div className="center-note">
        <h2>Authentication required</h2>
        <p>Sign in with your RTÉ identity provider to use RADAR.</p>
      </div>
    );
  if (error)
    return (
      <div className="center-note">
        <h2>RADAR is unavailable</h2>
        <p>{error}</p>
      </div>
    );

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="explain" element={<ExplainDns />} />
        <Route path="live-steering" element={<LiveSteering />} />
        <Route path="steering" element={<Steering />} />
        <Route path="topology" element={<Topology />} />
        <Route path="network" element={<NetworkTelemetry />} />
        <Route path="realta-cache" element={<RealtaCacheLb />} />
        <Route path="network/connection" element={<ConnectorSettings />} />
        <Route path="explorer" element={<Ns1Explorer />} />
        <Route path="explorer/:zone" element={<Ns1Explorer />} />
        <Route path="explorer/:zone/:domain/:type" element={<Ns1Explorer />} />
        <Route path="validation/ns1" element={<ValidationNs1 />} />
        <Route path="activity" element={<Activity />} />
        <Route path="snapshots/:snapshotId" element={<SnapshotDetail />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<div className="center-note">Page not found.</div>} />
      </Route>
    </Routes>
  );
}
