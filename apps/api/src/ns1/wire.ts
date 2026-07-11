// Minimal wire-shape validation (docs/ns1/developer-guide.md §24). We validate ONLY the
// few fields RADAR relies on, with everything else tolerated — the client always returns
// the raw parsed JSON unchanged, so unknown fields are never discarded (guide §6). These
// schemas exist to reject grossly-wrong shapes (e.g. answers that are not an array), not
// to model NS1 exhaustively. Broaden only when a real fixture confirms a field.
import { z } from 'zod';

/** A DNS record: known optional fields; unknown fields tolerated (output is ignored — we
 *  return the raw JSON). Field names are grounded in the NS1 Go SDK (guide §7, §4). */
export const Ns1RecordShape = z.object({
  id: z.string().optional(),
  zone: z.string().optional(),
  domain: z.string().optional(),
  type: z.string().optional(),
  ttl: z.number().optional(),
  use_client_subnet: z.boolean().optional(),
  answers: z.array(z.unknown()).optional(),
  filters: z.array(z.unknown()).optional(),
});

/** Complete zone JSON: minimally an object. */
export const Ns1ZoneShape = z.object({
  zone: z.string().optional(),
  records: z.array(z.unknown()).optional(),
});

/** Zones list: an array of zone summaries. */
export const Ns1ZonesListShape = z.array(z.unknown());

/** Activity log: schema is FIXTURE-PENDING (guide §5); accept any JSON value so a real
 *  capture can tighten it without risking false negatives. */
export const Ns1ActivityShape = z.unknown();

/** Validate `value` against `shape` and return the ORIGINAL value on success (raw
 *  preservation). Returns null on failure so the caller can raise NS1_INVALID_RESPONSE. */
export function validateShape<T>(shape: z.ZodType<unknown>, value: T): T | null {
  return shape.safeParse(value).success ? value : null;
}
