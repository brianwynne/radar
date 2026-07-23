// Mock bgp.tools provider — realistic synthetic data with no network access, for dev, the demo
// toggle and tests. Implements the same BgpToolsReadClient contract the live client will, so the
// adapter/poller/routes are provider-agnostic. Returns only the monitored prefixes it is asked
// about; an unknown prefix comes back withdrawn (empty origins), matching a real table miss.
import type { BgpToolsPing, BgpToolsReadClient } from './client.js';
import { scenarioObservations, type MockScenario } from './fixtures.js';
import type { MonitoredPrefix, RawRoutingObservation } from './types.js';

export interface MockClientOptions {
  scenario?: MockScenario;
  /** Injectable clock (epoch ms) for deterministic observedAt stamps. */
  now?: () => number;
}

export class MockBgpToolsClient implements BgpToolsReadClient {
  private scenario: MockScenario;
  private readonly now: () => number;

  constructor(opts: MockClientOptions = {}) {
    this.scenario = opts.scenario ?? 'healthy';
    this.now = opts.now ?? (() => Date.now());
  }

  /** Swap the active scenario at runtime (used by the dev demo toggle). */
  setScenario(scenario: MockScenario): void {
    this.scenario = scenario;
  }

  async fetchObservations(prefixes: MonitoredPrefix[]): Promise<RawRoutingObservation[]> {
    const at = new Date(this.now());
    const byPrefix = new Map(scenarioObservations(this.scenario, at).map((o) => [o.prefix, o]));
    // Answer for exactly the prefixes asked about; a prefix the scenario doesn't cover is withdrawn.
    return prefixes.map((p) => byPrefix.get(p.prefix) ?? { prefix: p.prefix, addressFamily: p.addressFamily, origins: [], observedAt: at });
  }

  async ping(): Promise<BgpToolsPing> {
    return { ok: true, detail: `mock provider (scenario: ${this.scenario})` };
  }
}
