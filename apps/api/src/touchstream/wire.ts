// Touchstream wire shapes, as OBSERVED live on 2026-07-29 against the rtel tenant — deliberately
// permissive, and deliberately kept out of every other module.
//
// The published spec and the live payload disagree, so nothing here is required:
//   * live `stream_status_detail` returns `current_ad_history`/`recent_ad_history`, which the spec's
//     DetailedStreamStatus does not declare;
//   * the spec's `akamai_cpcode` was absent from every live record;
//   * `?stream_key=` on `/api/stream_status_full/` is documented but IGNORED (all monitors return).
// Unknown fields are preserved on the raw object rather than dropped (ADR-0001).
import { z } from 'zod';

const num = z.union([z.number(), z.string()]).nullish();

export const tsRenditionSchema = z
  .object({
    name: z.string().nullish(),
    sequence: z.number().nullish(),
    status: z.number().nullish(),
    status_text: z.string().nullish(),
    http_status: z.union([z.string(), z.number()]).nullish(),
    type: z.string().nullish(),
    stalled_bitrate: z.boolean().nullish(),
    bitrate: z.union([z.string(), z.number()]).nullish(),
    resolution: z.string().nullish(),
    speed: num,
    content_size: num,
    duration: num,
  })
  .passthrough();

export const tsLocationDetailSchema = z
  .object({
    location: z.string().nullish(),
    last_monitored: num,
    pop_ip_addr: z.string().nullish(),
    edge_ip_addr: z.string().nullish(),
    historical_status: z.array(z.number()).nullish(),
    historical_status_pct: num,
    historical_avg_speed: z.union([z.array(num), num]).nullish(),
    historical_avg_speed_avg: num,
    status_detail: z.array(tsRenditionSchema).nullish(),
  })
  .passthrough();

/** `/api/stream_status_full/` element — the richest read, one entry per monitored stream. */
export const tsStreamFullSchema = z
  .object({
    stream_key: z.string(),
    channel: z.string().nullish(),
    channel_id: z.number().nullish(),
    product: z.string().nullish(),
    format: z.string().nullish(),
    cdn: z.string().nullish(),
    environment: z.string().nullish(),
    manifest_url: z.string().nullish(),
    planned_outage: z.union([z.boolean(), z.number()]).nullish(),
    last_monitored: num,
    current_status: z.number().nullish(),
    current_status_pct: num,
    historical_status: z.array(z.number()).nullish(),
    historical_status_pct: num,
    historical_avg_speed: z.union([z.array(num), num]).nullish(),
    historical_avg_speed_avg: num,
    historical_max_speed: z.union([z.array(num), num]).nullish(),
    historical_max_speed_avg: num,
    location_detail: z.array(tsLocationDetailSchema).nullish(),
  })
  .passthrough();

export const tsStreamFullListSchema = z.array(tsStreamFullSchema);

/** `/api/location_detail/` element. Live payloads include a trailing `null`, hence `.nullable()`. */
export const tsLocationGroupSchema = z
  .object({
    key: z.string().nullish(),
    location_group: z.string().nullish(),
    locations: z
      .record(
        z.string(),
        z
          .object({
            country: z.string().nullish(),
            region: z.string().nullish(),
            supplier: z.string().nullish(),
            ip_addresses: z.array(z.string()).nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough()
  .nullable();

export const tsLocationGroupListSchema = z.array(tsLocationGroupSchema);

/** `/api/stream_stats/…` — the live payload is a JSON *string* containing the array. */
export const tsStatSchema = z
  .object({
    product: z.string().nullish(),
    format: z.string().nullish(),
    cdn: z.string().nullish(),
    executions: num,
    requests: num,
    errors: num,
    failure: num,
    error_pct: num,
    fail_pct: num,
    min: num,
    avg: num,
    max: num,
    p95: num,
    stdev: num,
  })
  .passthrough();

export const tsStatListSchema = z.array(tsStatSchema);

/** `/api/error_log/…` element. */
export const tsErrorSchema = z
  .object({
    time: num,
    channel: z.string().nullish(),
    channel_key: z.string().nullish(),
    cdn: z.string().nullish(),
    format: z.string().nullish(),
    location: z.string().nullish(),
    url_name: z.string().nullish(),
    url: z.string().nullish(),
    status_code: z.union([z.string(), z.number()]).nullish(),
    status_text: z.string().nullish(),
    planned_outage: z.union([z.boolean(), z.number()]).nullish(),
  })
  .passthrough();

export const tsErrorListSchema = z.array(tsErrorSchema);

export type TsStreamFull = z.infer<typeof tsStreamFullSchema>;
export type TsLocationGroup = z.infer<typeof tsLocationGroupSchema>;
export type TsRendition = z.infer<typeof tsRenditionSchema>;
export type TsStat = z.infer<typeof tsStatSchema>;
export type TsError = z.infer<typeof tsErrorSchema>;
