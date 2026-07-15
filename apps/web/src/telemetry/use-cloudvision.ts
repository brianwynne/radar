// Load read-only CloudVision network telemetry (status + devices + interfaces + link groups
// + BGP peers + history) with an optional refresh interval. Telemetry is informational only;
// a missing value is never invented. Mirrors use-cache-telemetry.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type {
  BgpPeer, CloudVisionSource, ConnectorStatus, HistoryPoint, LinkGroup, NetworkCompleteness,
  NetworkDevice, NetworkInterface, NetworkSummary,
} from '../api/types';

export interface CloudVisionState {
  status: ConnectorStatus | null;
  summary: NetworkSummary | null;
  completeness: NetworkCompleteness | null;
  warnings: string[];
  devices: NetworkDevice[];
  interfaces: NetworkInterface[];
  linkGroups: LinkGroup[];
  bgpPeers: BgpPeer[];
  history: HistoryPoint[];
  capturedAt: string | null;
  mode: CloudVisionSource | null;
  notice: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useCloudVision(refreshMs?: number): CloudVisionState {
  const [state, setState] = useState<Omit<CloudVisionState, 'refresh'>>({
    status: null, summary: null, completeness: null, warnings: [], devices: [], interfaces: [],
    linkGroups: [], bgpPeers: [], history: [], capturedAt: null, mode: null, notice: null, loading: true, error: null,
  });

  const load = useCallback(async () => {
    try {
      const [status, devices, interfaces, linkGroups, bgpPeers, history] = await Promise.all([
        api.networkStatus(), api.networkDevices(), api.networkInterfaces(), api.networkLinkGroups(), api.networkBgpPeers(), api.networkHistory(),
      ]);
      setState({
        status: status.status,
        summary: status.summary,
        completeness: status.completeness,
        warnings: status.warnings ?? [],
        capturedAt: status.capturedAt,
        devices: devices.items ?? [],
        interfaces: interfaces.items ?? [],
        linkGroups: linkGroups.items ?? [],
        bgpPeers: bgpPeers.items ?? [],
        history: history.items ?? [],
        mode: status.provenance?.telemetryMode ?? null,
        notice: status.provenance?.notice ?? null,
        loading: false,
        error: null,
      });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e instanceof ApiError ? `${e.code}: ${e.message}` : 'Network telemetry unavailable.' }));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!refreshMs) return;
    const t = setInterval(() => void load(), refreshMs);
    return () => clearInterval(t);
  }, [refreshMs, load]);

  return { ...state, refresh: () => void load() };
}
