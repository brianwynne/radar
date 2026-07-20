import type { AtlasConfig } from './config.js';
import { DisabledAtlasClient, HttpAtlasClient, type AtlasResolverClient } from './client.js';
import { HttpAtlasManager, type ResolverManager } from './manager.js';
import { MockAtlasClient, MockAtlasManager } from './mock.js';

export { loadAtlasConfig } from './config.js';
export type { AtlasConfig } from './config.js';
export type { AtlasResolverClient } from './client.js';
export type { ResolverManager, ResolverCheck } from './manager.js';
export type { ResolverSnapshot } from './types.js';

/** Build the resolver-reader client (read-only baseline) for the configured mode. */
export function createAtlasClient(cfg: AtlasConfig): AtlasResolverClient {
  if (!cfg.enabled) return new DisabledAtlasClient(cfg);
  if (cfg.mode === 'mock') return new MockAtlasClient(cfg);
  return new HttpAtlasClient(cfg);
}

/** Build the resolver-reader manager (baseline + check-now + polling switch). */
export function createAtlasManager(cfg: AtlasConfig): ResolverManager {
  if (cfg.mode === 'live' && cfg.enabled) return new HttpAtlasManager(cfg);
  return new MockAtlasManager(cfg);
}
