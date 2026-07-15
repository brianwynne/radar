// Tiny bit-rate formatter for the CLI validation report. Never invents a value — a missing
// rate renders as a placeholder.
export function formatBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '—';
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(bps >= 1e10 ? 0 : 1)} Gb/s`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(0)} Mb/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} kb/s`;
  return `${bps} b/s`;
}
