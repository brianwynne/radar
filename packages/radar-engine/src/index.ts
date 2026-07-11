// @radar/engine — the pure RADAR core. No dependency on React, Fastify, PostgreSQL,
// Docker or any HTTP framework. Reusable across the application (brief decision §6).
export * from './ns1.js'; // NS1 raw types (grounded in the NS1 SDK)
export * from './identity.js'; // DNS identity model + deriveIdentity
export * from './model.js'; // source-agnostic evaluation trace/result model
export { evaluate } from './engine.js'; // NS1 Filter Chain evaluation engine
