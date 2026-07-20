// RADAR NS1 Filter Chain evaluation engine (RADAR §9).
//
// Pure and deterministic: given an NS1 record and a Scenario it produces a
// step-by-step, answer-accounting trace, surviving answers, and — where
// mathematically valid — an expected (probabilistic) delivery-platform
// distribution. It never mutates its inputs and performs no I/O.
//
// Filter SEMANTICS are RADAR's interpretation of the documented NS1 Filter Chain,
// isolated here behind one registry. Each is recorded in the NS1 assumptions
// register with a confidence level; unsupported filters degrade the trace to
// partial and stop RADAR claiming certainty (principle 5.4).

import type { NS1Answer, NS1Filter, NS1Record } from './ns1.js';
import { deriveIdentity, type Confidence, type DerivedIdentity, type Scenario } from './identity.js';
import type {
  AnswerOutcome,
  EvaluationResult,
  ExpectedDistribution,
  FilterBehaviour,
  FilterTrace,
  SelectionDeterminism,
  TracedAnswer,
} from './model.js';

/** Internal working answer with a stable id carried across steps. */
interface Work {
  id: string;
  label: string;
  platform?: string;
  raw: NS1Answer;
  /** Fraction of queries this answer survives `shed_load` (1 = never shed). Scales its expected
   *  distribution share; set only by the shed_load filter in the mid-watermark band. */
  shedFactor?: number;
}

interface StepResult {
  output: Work[];
  outcomes: AnswerOutcome[];
  reorder: boolean;
  reason: string;
  metadataConsumed: string[];
  confidence: Confidence;
  warning?: string;
}

type FilterFn = (input: Work[], config: Record<string, unknown>, ctx: Scenario) => StepResult;

/* ------------------------------------------------------------- meta helpers */

const isFeed = (v: unknown): v is { feed: string } =>
  typeof v === 'object' && v !== null && 'feed' in (v as Record<string, unknown>);

// RADAR-owned answer → delivery-platform table (NS1 guide §27). The platform is derived from the
// answer RDATA (the CNAME/target the record steers to), because operator notes are freeform and
// often absent. Falls back to meta.note, then the raw rdata. Extend as RTÉ adds delivery targets.
const PLATFORM_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/(^|\.)rte\.ie\.?$/i, 'Réalta'], // RTÉ's own CDN (e.g. liveedge.rte.ie)
  [/\.fastly\.net\.?$/i, 'Fastly'],
  [/\.akamai(zed|edge)?\.net\.?$/i, 'Akamai'],
  [/\.cloudfront\.net\.?$/i, 'CloudFront'],
];
const platformFromRdata = (rdata: string[]): string | undefined => {
  for (const v of rdata) {
    const host = String(v).trim();
    for (const [re, name] of PLATFORM_PATTERNS) if (re.test(host)) return name;
  }
  return undefined;
};
export const platformOf = (a: NS1Answer): string | undefined =>
  platformFromRdata(a.answer) ?? (typeof a.meta?.note === 'string' ? a.meta.note : undefined);

/** NS1 config flags arrive as "1" / 1 / true (the real Filter Chain uses string "1"). */
const flagOn = (v: unknown): boolean =>
  v === true || v === 1 || v === '1' || (typeof v === 'string' && v.toLowerCase() === 'true');

function upOf(w: Work, ctx: Scenario): { up: boolean; assumed: boolean; reason: string } {
  const ov = ctx.healthOverrides?.[w.id];
  if (ov !== undefined) return { up: ov, assumed: false, reason: ov ? 'health override: up' : 'health override: down' };
  const up = w.raw.meta?.up;
  if (typeof up === 'boolean') return { up, assumed: false, reason: up ? 'meta.up = true' : 'meta.up = false → down' };
  return { up: true, assumed: true, reason: 'meta.up is feed-driven/unset → assumed up (no runtime feed state in v1)' };
}

function numMeta(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
function listMeta(v: unknown): string[] | 'feed' | undefined {
  if (v === undefined) return undefined;
  if (isFeed(v)) return 'feed';
  if (Array.isArray(v)) return v.map((x) => String(x));
  return [String(v)];
}
function asnMeta(v: unknown): number[] | 'feed' | undefined {
  if (v === undefined) return undefined;
  if (isFeed(v)) return 'feed';
  if (Array.isArray(v)) return v.map((x) => Number(x));
  return [Number(v)];
}
/** Country meta as an upper-cased string list (feed-driven country → []). */
function countryList(v: unknown): string[] {
  const cs = listMeta(v);
  return Array.isArray(cs) ? cs.map((s) => s.toUpperCase()) : [];
}

/** IPv4 CIDR containment (v1). IPv6 is not evaluated — flagged in the register. */
function cidrContains(container: string, target: string): boolean | undefined {
  const c = parseCidr(container);
  const t = parseCidr(target);
  if (!c || !t) return undefined;
  if (t.bits < c.bits) return false;
  const mask = c.bits === 0 ? 0 : (~0 << (32 - c.bits)) >>> 0;
  return (c.addr & mask) === (t.addr & mask);
}
function parseCidr(s: string): { addr: number; bits: number } | undefined {
  const [ip, prefix] = s.split('/');
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return undefined;
  const addr = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  const bits = prefix === undefined ? 32 : Number(prefix);
  if (Number.isNaN(bits) || bits < 0 || bits > 32) return undefined;
  return { addr, bits };
}

/* ------------------------------------------------------------------ filters */

const up: FilterFn = (input, _c, ctx) => {
  const output: Work[] = [];
  const outcomes: AnswerOutcome[] = [];
  let assumed = 0;
  for (const w of input) {
    const r = upOf(w, ctx);
    if (r.assumed) assumed++;
    if (r.up) {
      output.push(w);
      outcomes.push({ answerId: w.id, disposition: 'retained', reason: r.reason });
    } else {
      outcomes.push({ answerId: w.id, disposition: 'removed', reason: r.reason });
    }
  }
  const removed = input.length - output.length;
  return {
    output,
    outcomes,
    reorder: false,
    metadataConsumed: ['up'],
    confidence: assumed > 0 ? 'medium' : 'high',
    reason: `Removed ${removed} down answer(s); retained ${output.length} up.`,
    warning: assumed > 0 ? 'Some up states are feed-driven and assumed up (no runtime feed in v1).' : undefined,
  };
};

// Shared "fence" (sift) implementation for netfence_asn / netfence_prefix / geofence_country.
// NS1 semantics (guide §11–13, confirmed against live resolutions of live.nsone.rte.ie):
//   • Answers TAGGED with this metadata are kept iff the user matches; non-matching tagged removed.
//   • Answers with NO tag (untagged/global) are kept as a fallback — UNLESS `removeUntagged` (the
//     record's remove_no_* flag) is set AND at least one tagged answer matched, in which case the
//     untagged answers are dropped (the tagged group "wins").
//   • Feed-driven tags are of unknown state: kept, and they suppress untagged removal (we can't
//     assert a match), lowering confidence.
type Tag = 'match' | 'nomatch' | 'untagged' | 'feed';
function fence(
  input: Work[],
  metaKey: 'asn' | 'ip_prefixes' | 'country',
  removeUntagged: boolean,
  classify: (w: Work) => Tag,
  describe: (w: Work, tag: Tag, dropUntagged: boolean) => string,
  summary: string,
): StepResult {
  const tags = input.map((w) => ({ w, tag: classify(w) }));
  const matched = tags.some((t) => t.tag === 'match');
  const feedSeen = tags.some((t) => t.tag === 'feed');
  const dropUntagged = removeUntagged && matched && !feedSeen;
  const output: Work[] = [];
  const outcomes: AnswerOutcome[] = [];
  for (const { w, tag } of tags) {
    const keep = tag === 'match' || tag === 'feed' || (tag === 'untagged' && !dropUntagged);
    if (keep) output.push(w);
    // An untagged answer that survives did so only as a fallback (nothing matched, or it has no
    // restriction) — flag it so the UI can highlight the safety net.
    const fallback = tag === 'untagged' && keep;
    outcomes.push({ answerId: w.id, disposition: keep ? 'retained' : 'removed', reason: describe(w, tag, dropUntagged), ...(fallback ? { fallback: true } : {}) });
  }
  return {
    output,
    outcomes,
    reorder: false,
    metadataConsumed: [metaKey],
    confidence: feedSeen ? 'medium' : 'high',
    reason: `${summary}: ${tags.filter((t) => t.tag === 'match').length} matched, untagged ${dropUntagged ? 'dropped (a tagged answer matched)' : 'kept as fallbacks'}, ${input.length - output.length} removed, ${output.length} retained.`,
    warning: feedSeen && removeUntagged ? 'Feed-driven tag present: cannot assert a match, so untagged answers were kept.' : undefined,
  };
}

const netfence_asn: FilterFn = (input, config, ctx) => {
  if (ctx.asn === undefined) {
    return {
      output: input,
      outcomes: input.map((w) => ({ answerId: w.id, disposition: 'retained', reason: 'no ASN in scenario — filter not applied' })),
      reorder: false,
      metadataConsumed: ['asn'],
      confidence: 'low',
      reason: 'ASN unavailable in scenario; netfence_asn could not fence — all answers kept.',
      warning: 'netfence_asn skipped: no ASN available.',
    };
  }
  const asn = ctx.asn;
  const tagOf = (w: Work): Tag => {
    const set = asnMeta(w.raw.meta?.asn);
    if (set === undefined) return 'untagged';
    if (set === 'feed') return 'feed';
    return set.includes(asn) ? 'match' : 'nomatch';
  };
  return fence(input, 'asn', flagOn(config.remove_no_asn), tagOf, (w, tag, dropUntagged) => {
    const set = asnMeta(w.raw.meta?.asn);
    const list = Array.isArray(set) ? `[${set.join(', ')}]` : '';
    if (tag === 'match') return `ASN ${asn} in answer set ${list}`;
    if (tag === 'feed') return 'ASN metadata is feed-driven → kept (state unknown in v1)';
    if (tag === 'nomatch') return `ASN ${asn} not in answer set ${list}`;
    if (dropUntagged) return 'no ASN metadata → dropped: another answer matched the requester and remove_no_asn is on';
    return flagOn(config.remove_no_asn)
      ? `no ASN metadata → kept as a fallback (no answer's ASN list matched AS${asn})`
      : 'no ASN metadata → kept as a global fallback (this answer has no ASN restriction)';
  }, `Fenced by ASN ${asn}`);
};

const netfence_prefix: FilterFn = (input, config, ctx) => {
  const clientPrefix = ctx.ecsPresent ? ctx.ecsPrefix : ctx.clientPrefix;
  if (!clientPrefix) {
    return {
      output: input,
      outcomes: input.map((w) => ({ answerId: w.id, disposition: 'retained', reason: 'no client prefix — filter not applied' })),
      reorder: false,
      metadataConsumed: ['ip_prefixes'],
      confidence: 'low',
      reason: 'No client prefix available; netfence_prefix could not fence — all answers kept.',
      warning: 'netfence_prefix skipped: no client prefix.',
    };
  }
  const tagOf = (w: Work): Tag => {
    const set = listMeta(w.raw.meta?.ip_prefixes);
    if (set === undefined) return 'untagged';
    if (set === 'feed') return 'feed';
    return set.some((p) => cidrContains(p, clientPrefix) === true) ? 'match' : 'nomatch';
  };
  return fence(input, 'ip_prefixes', flagOn(config.remove_no_ip_prefixes), tagOf, (w, tag, dropUntagged) => {
    const set = listMeta(w.raw.meta?.ip_prefixes);
    const list = Array.isArray(set) ? `[${set.join(', ')}]` : '';
    if (tag === 'match') return `client ${clientPrefix} within answer prefixes ${list}`;
    if (tag === 'feed') return 'prefix metadata is feed-driven → kept';
    if (tag === 'nomatch') return `client ${clientPrefix} not within ${list}`;
    if (dropUntagged) return 'no ip_prefixes metadata → dropped: another answer matched the requester and remove_no_ip_prefixes is on';
    return flagOn(config.remove_no_ip_prefixes)
      ? `no ip_prefixes metadata → kept as a fallback (no answer's prefixes contained ${clientPrefix})`
      : 'no ip_prefixes metadata → kept as a global fallback (this answer has no prefix restriction)';
  }, `Fenced by prefix ${clientPrefix}`);
};

const geotarget_country: FilterFn = (input, _c, ctx) => {
  if (!ctx.country) {
    return {
      output: input,
      outcomes: input.map((w) => ({ answerId: w.id, disposition: 'retained', reason: 'no country in scenario — no reorder' })),
      reorder: false,
      metadataConsumed: ['country'],
      confidence: 'low',
      reason: 'No country available; geotarget_country did not reorder.',
    };
  }
  const country = ctx.country.toUpperCase();
  const match = (w: Work) => countryList(w.raw.meta?.country).includes(country);
  const matching = input.filter(match);
  const rest = input.filter((w) => !match(w));
  const output = [...matching, ...rest];
  const reorder = output.some((w, i) => w.id !== input[i].id);
  const outcomes: AnswerOutcome[] = output.map((w) => ({
    answerId: w.id,
    disposition: reorder ? 'reordered' : 'retained',
    reason: match(w) ? `matches country ${country} → prioritised` : 'no country match → kept, lower order',
  }));
  return {
    output,
    outcomes,
    reorder,
    metadataConsumed: ['country'],
    confidence: 'high',
    reason: `Prioritised ${matching.length} answer(s) matching country ${country} (none removed).`,
  };
};

const geofence_country: FilterFn = (input, config, ctx) => {
  if (!ctx.country) {
    return {
      output: input,
      outcomes: input.map((w) => ({ answerId: w.id, disposition: 'retained', reason: 'no country in scenario — filter not applied' })),
      reorder: false,
      metadataConsumed: ['country'],
      confidence: 'low',
      reason: 'No country available; geofence_country could not fence — all answers kept.',
      warning: 'geofence_country skipped: no country.',
    };
  }
  const country = ctx.country.toUpperCase();
  const tagOf = (w: Work): Tag => {
    const cs = countryList(w.raw.meta?.country);
    if (cs.length === 0) return 'untagged';
    return cs.includes(country) ? 'match' : 'nomatch';
  };
  return fence(input, 'country', flagOn(config.remove_no_location), tagOf, (w, tag, dropUntagged) => {
    const cs = countryList(w.raw.meta?.country);
    const list = `[${cs.join(', ')}]`;
    if (tag === 'match') return `country ${country} in ${list}`;
    if (tag === 'nomatch') return `country ${country} not in ${list}`;
    if (dropUntagged) return 'no country metadata → dropped: a geo-tagged answer matched the requester and remove_no_location is on';
    return flagOn(config.remove_no_location)
      ? `no country metadata → kept as a fallback (no country-tagged answer matched ${country})`
      : 'no country metadata → kept as a global fallback (this answer has no geo restriction)';
  }, `Fenced by country ${country}`);
};

// NOTE: `priority`, `cost` and the Pulsar filters are deliberately NOT implemented (NS1 guide
// §17). Their wire representation, mode (sort vs sift), missing-value behaviour and interaction
// with later filters are fixture-pending, so RADAR treats them as UNSUPPORTED → partial rather
// than guessing (see docs/ns1/assumptions.md). The raw filter config is still displayed;
// evaluation stops claiming completeness at that step.

// `shed_load` (validated against IBM NS1 Connect docs + the ns1-go SDK): sheds an answer as its
// load crosses per-answer watermarks. Config carries `metric` (connections|requests|loadavg); each
// answer carries `low_watermark`, `high_watermark`, and the live load under the metric's own key
// (there is NO field literally called "load"). Behaviour: load ≤ low → served; between → dropped on
// a rising FRACTION of queries (NS1's exact curve is unpublished — we model a linear ramp); load ≥
// high → removed entirely. Answers WITHOUT watermarks are never shed (they are the fallback). The
// load is normally a FEED — with no runtime feed state in v1 it is ASSUMED not shedding (like `up`),
// unless the scenario supplies `loadOverrides` (by answerId or feed id) to simulate a load.
function loadOf(w: Work, metric: string, ctx: Scenario): { load: number | undefined; assumed: boolean } {
  // Override precedence: this answer's id, then its feed id, then the `*` wildcard (a single load
  // applied to every shed answer — what the Walkthrough's PNI-load slider uses).
  const raw = w.raw.meta?.[metric] as unknown;
  const wildcard = ctx.loadOverrides?.['*'];
  if (isFeed(raw)) {
    const ov = ctx.loadOverrides?.[w.id] ?? ctx.loadOverrides?.[raw.feed] ?? wildcard;
    return ov !== undefined ? { load: ov, assumed: false } : { load: undefined, assumed: true };
  }
  const ov = ctx.loadOverrides?.[w.id] ?? wildcard;
  if (ov !== undefined) return { load: ov, assumed: false };
  const n = numMeta(raw);
  return n !== undefined ? { load: n, assumed: false } : { load: undefined, assumed: true };
}

const shed_load: FilterFn = (input, config, ctx) => {
  const metric = String(config.metric ?? 'loadavg');
  const output: Work[] = [];
  const outcomes: AnswerOutcome[] = [];
  let removed = 0, partial = 0, assumed = 0, subject = 0;
  for (const w of input) {
    const low = numMeta(w.raw.meta?.low_watermark);
    const high = numMeta(w.raw.meta?.high_watermark);
    if (low === undefined || high === undefined || high <= low) {
      w.shedFactor = 1;
      output.push(w);
      outcomes.push({ answerId: w.id, disposition: 'retained', reason: 'no load-shedding watermarks — not subject to shed_load' });
      continue;
    }
    subject++;
    const { load, assumed: asm } = loadOf(w, metric, ctx);
    if (load === undefined) {
      assumed++;
      w.shedFactor = 1;
      output.push(w);
      outcomes.push({ answerId: w.id, disposition: 'retained', reason: `${metric} is feed-driven/unset → assumed not shedding (no runtime feed in v1; supply loadOverrides to simulate)`, shedProbability: 0 });
      continue;
    }
    const shedProb = load <= low ? 0 : load >= high ? 1 : (load - low) / (high - low);
    if (shedProb >= 1) {
      removed++;
      outcomes.push({ answerId: w.id, disposition: 'removed', reason: `${metric} ${load} ≥ high watermark ${high} → shed (removed; traffic moves to the remaining answers)`, shedProbability: 1 });
      continue;
    }
    w.shedFactor = 1 - shedProb;
    output.push(w);
    if (shedProb <= 0) {
      outcomes.push({ answerId: w.id, disposition: 'retained', reason: `${metric} ${load} ≤ low watermark ${low} → served normally (not shed)`, shedProbability: 0 });
    } else {
      partial++;
      outcomes.push({ answerId: w.id, disposition: 'retained', reason: `${metric} ${load} between ${low}–${high} → shed on ${Math.round(shedProb * 100)}% of queries`, shedProbability: shedProb });
    }
  }
  const parts = [`${removed} removed`, `${partial} partially shed`, `${output.length} kept`];
  return {
    output,
    outcomes,
    reorder: false,
    metadataConsumed: subject > 0 ? [metric, 'low_watermark', 'high_watermark'] : [],
    confidence: assumed > 0 ? 'medium' : 'high',
    reason: `Load shedding (metric=${metric}): ${parts.join(', ')}.`,
    warning: assumed > 0 ? `${assumed} answer(s) have feed-driven load with no runtime feed in v1 — assumed not shedding.` : undefined,
  };
};

const weighted_shuffle: FilterFn = (input) => {
  const w = (x: Work) => numMeta(x.raw.meta?.weight) ?? 1;
  const output = [...input].sort((a, b) => w(b) - w(a));
  const reorder = output.some((x, i) => x.id !== input[i].id);
  return {
    output,
    outcomes: output.map((x) => ({
      answerId: x.id,
      disposition: input.length > 1 ? 'reordered' : 'retained',
      reason: `weight ${w(x)} (probabilistic ordering)`,
    })),
    reorder,
    metadataConsumed: ['weight'],
    confidence: 'high',
    reason: `Weighted probabilistic ordering by meta.weight over ${input.length} answer(s). Shown highest-weight-first for display; actual order is random per resolution.`,
  };
};

const select_first_n: FilterFn = (input, config) => {
  const n = Number(config.N ?? config.n ?? 1);
  const output = input.slice(0, n);
  const outcomes: AnswerOutcome[] = input.map((w, i) => {
    if (i < n) return { answerId: w.id, disposition: n === 1 ? 'selected' : 'retained', reason: `within first ${n}` };
    return { answerId: w.id, disposition: 'removed', reason: `beyond first ${n}` };
  });
  return {
    output,
    outcomes,
    reorder: false,
    metadataConsumed: [],
    confidence: 'high',
    reason: `Kept the first ${n} answer(s); removed ${input.length - output.length}.`,
  };
};

/** Supported filters. An NS1 filter type absent here is UNSUPPORTED: the engine
 *  passes answers through untouched, flags the step, and stops claiming certainty. */
const REGISTRY: Record<string, FilterFn> = {
  up,
  netfence_asn,
  netfence_prefix,
  geotarget_country,
  geofence_country,
  shed_load,
  weighted_shuffle,
  select_first_n,
};

/** How each supported filter acts on the answer list (NS1 guide §8.1). */
const BEHAVIOUR: Record<string, FilterBehaviour> = {
  up: 'eliminate',
  netfence_asn: 'eliminate',
  netfence_prefix: 'eliminate',
  geofence_country: 'eliminate',
  geotarget_country: 'reorder',
  shed_load: 'eliminate',
  weighted_shuffle: 'reorder',
  select_first_n: 'select',
};

/* ---------------------------------------------------------------- evaluate */

export function evaluate(record: NS1Record, scenario: Scenario): EvaluationResult {
  const identity = deriveIdentity(record, scenario);

  const works: Work[] = record.answers.map((a, i) => {
    const platform = platformOf(a);
    // A stable, UNIQUE id per answer object. When NS1 supplies an id, use it; otherwise derive one
    // that always includes the original index so two answers with the same value/platform (and no
    // id) remain distinct — the model must preserve duplicate answers, never collapse them (spec §5/§6).
    const base = (platform ?? a.answer.join('_') ?? 'answer').toLowerCase().replace(/\s+/g, '-');
    const id = a.id || `${base}-${i}`;
    return { id, label: platform || a.answer.join(', ') || id, platform, raw: a };
  });
  const byId = new Map(works.map((w) => [w.id, w]));

  const answers: TracedAnswer[] = works.map((w) => ({
    id: w.id,
    label: w.label,
    deliveryPlatform: w.platform,
    rdata: w.raw.answer,
    weight: numMeta(w.raw.meta?.weight),
    priority: numMeta(w.raw.meta?.priority),
    region: w.raw.region,
  }));

  const traces: FilterTrace[] = [];
  const warnings: string[] = [];
  const unsupportedFilters: string[] = [];
  let complete = true;
  let stoppedAtFilterIndex: number | undefined;
  let current = works;
  let weightedSet: Work[] | undefined;
  let weightingMethod: ExpectedDistribution['method'] | undefined;

  record.filters.forEach((f, index) => {
    const config = f.config ?? {};
    const inputIds = current.map((w) => w.id);

    if (f.disabled) {
      traces.push({
        index, type: f.filter, disabled: true, supported: true,
        behaviour: BEHAVIOUR[f.filter] ?? 'unknown', config,
        metadataConsumed: [], input: inputIds, output: inputIds,
        orderingBefore: inputIds, orderingAfter: inputIds, removedAnswerIds: [],
        outcomes: current.map((w) => ({ answerId: w.id, disposition: 'retained', reason: 'filter disabled — skipped' })),
        reorder: false, reason: 'Filter is disabled in the configuration; not evaluated.',
        confidence: complete ? 'high' : 'low',
      });
      return;
    }

    const fn = REGISTRY[f.filter];
    if (!fn) {
      unsupportedFilters.push(f.filter);
      if (complete) stoppedAtFilterIndex = index; // first unsupported step
      complete = false;
      const warning = `Unsupported filter "${f.filter}" at step ${index}: RADAR cannot evaluate it; results beyond this step are partial.`;
      warnings.push(warning);
      traces.push({
        index, type: f.filter, disabled: false, supported: false,
        behaviour: 'unknown', config,
        metadataConsumed: [], input: inputIds, output: inputIds,
        orderingBefore: inputIds, orderingAfter: inputIds, removedAnswerIds: [],
        outcomes: current.map((w) => ({ answerId: w.id, disposition: 'unsupported', reason: 'filter not evaluated by RADAR' })),
        reorder: false, reason: warning, confidence: 'low', warning,
      });
      return;
    }

    const res = fn(current, config, scenario);
    if (res.warning) warnings.push(`Step ${index} (${f.filter}): ${res.warning}`);
    const outputIds = res.output.map((w) => w.id);
    traces.push({
      index, type: f.filter, disabled: false, supported: true,
      behaviour: BEHAVIOUR[f.filter] ?? 'unknown', config,
      metadataConsumed: res.metadataConsumed, input: inputIds, output: outputIds,
      orderingBefore: inputIds, orderingAfter: outputIds,
      removedAnswerIds: inputIds.filter((id) => !outputIds.includes(id)),
      outcomes: res.outcomes, reorder: res.reorder,
      reason: res.reason, confidence: complete ? res.confidence : 'low',
      warning: res.warning,
    });

    if (f.filter === 'weighted_shuffle') { weightedSet = res.output; weightingMethod = 'weighted_shuffle'; }
    current = res.output;
  });

  const eligibleAnswerIds = current.map((w) => w.id);
  // The single surviving answer (if any). Whether that is a DEFINITIVE selection or merely the
  // most-likely answer depends on selectionDeterminism below — a probabilistic reorder (shuffle /
  // weighted shuffle) upstream of the selection means the specific answer is NOT fixed.
  const selected = eligibleAnswerIds.length === 1 ? eligibleAnswerIds[0] : undefined;

  const SHUFFLE = new Set(['shuffle', 'weighted_shuffle', 'sticky_shuffle', 'weighted_sticky_shuffle']);
  const CONTEXT_META = new Set(['asn', 'country', 'ip_prefixes', 'georegion', 'geo']);
  // A shuffle, or a shed_load that is mid-band (an answer shed on a FRACTION of queries), makes the
  // specific returned answer non-deterministic.
  const shedPartial = traces.some((t) => t.supported && t.type === 'shed_load' && t.outcomes.some((o) => o.shedProbability !== undefined && o.shedProbability > 0 && o.shedProbability < 1));
  const probabilistic = shedPartial || traces.some((t) => t.supported && SHUFFLE.has(t.type) && t.input.length > 1);
  const contextDependent = traces.some((t) => t.supported && t.metadataConsumed.some((m) => CONTEXT_META.has(m)));
  const selectionDeterminism: SelectionDeterminism = !complete
    ? 'partial'
    : probabilistic
      ? 'probabilistic'
      : contextDependent
        ? 'context_dependent'
        : 'deterministic';

  // Which steering metadata is present on the answers vs actually read by the chain. Keys present
  // but not consumed have no steering effect in this chain (spec §7 — surface, don't hide).
  const metadataConfigured = [
    ...new Set(record.answers.flatMap((a) => Object.keys(a.meta ?? {}).filter((k) => k !== 'note'))),
  ].sort();
  const metadataConsumed = [
    ...new Set(traces.filter((t) => t.supported && !t.disabled).flatMap((t) => t.metadataConsumed)),
  ].sort();

  const expectedDistribution = computeDistribution(weightedSet, weightingMethod, current);
  const explanation = buildExplanation(
    record, identity, byId, selected, selectionDeterminism, eligibleAnswerIds, expectedDistribution, complete, stoppedAtFilterIndex, record.filters, unsupportedFilters,
  );

  return {
    scenario, identity, answers, traces, eligibleAnswerIds, selected, selectionDeterminism,
    expectedDistribution, complete, stoppedAtFilterIndex, explanation, warnings, unsupportedFilters,
    metadataConfigured, metadataConsumed,
  };
}

/** Human-readable steering explanation (NS1 guide §25 `explanation`). Composed from
 *  the trace; adds no new evaluation semantics. */
function buildExplanation(
  record: NS1Record,
  identity: DerivedIdentity,
  byId: Map<string, Work>,
  selected: string | undefined,
  determinism: SelectionDeterminism,
  eligible: string[],
  dist: ExpectedDistribution | undefined,
  complete: boolean,
  stoppedAtFilterIndex: number | undefined,
  filters: NS1Filter[],
  unsupportedFilters: string[],
): string {
  const parts: string[] = [];
  const src = identity.source === 'ecs'
    ? `the EDNS Client Subnet ${identity.evaluatedAddress}`
    : `the resolver IP ${identity.evaluatedAddress}`;
  const geo = [identity.country && `country ${identity.country}`, identity.asn && `ASN ${identity.asn}`].filter(Boolean).join(', ');
  parts.push(`Evaluated ${record.domain} ${record.type} using ${src}${geo ? ` (${geo})` : ''}; identity confidence ${identity.confidence}.`);

  if (selected) {
    const w = byId.get(selected);
    const name = w?.platform ?? w?.label ?? selected;
    // Only assert a definitive selection when deterministic. When a shuffle decides the final answer
    // the specific platform is probabilistic — one answer is returned per response (spec: never
    // claim a single "active" endpoint the config does not produce).
    if (determinism === 'deterministic') {
      parts.push(`Selected delivery platform: ${name} (deterministic for this query).`);
    } else if (determinism === 'probabilistic') {
      parts.push(`One answer is returned per DNS response; the specific platform is probabilistic (weighted) — most likely ${name}.`);
    } else if (determinism === 'context_dependent') {
      parts.push(`Selected delivery platform for this query context: ${name} (would differ for another resolver/ECS/geo/ASN).`);
    } else {
      parts.push(`Most likely delivery platform: ${name} (evaluation partial — an unsupported filter follows).`);
    }
  } else if (eligible.length > 1) {
    parts.push(`${eligible.length} answers remain eligible; NS1 returns one probabilistically.`);
  } else if (eligible.length === 0) {
    parts.push('No answers remain eligible.');
  }

  if (dist) {
    // Aggregate the per-answer shares by delivery platform and drop negligible standbys (<0.5%,
    // e.g. CloudFront/emergency-offload answers at ~1e-8) so the sentence reads cleanly.
    const byPlatform = new Map<string, number>();
    for (const s of dist.shares) byPlatform.set(s.deliveryPlatform ?? s.label, (byPlatform.get(s.deliveryPlatform ?? s.label) ?? 0) + s.share);
    const shares = [...byPlatform.entries()]
      .filter(([, v]) => v >= 0.005)
      .sort((a, b) => b[1] - a[1])
      .map(([p, v]) => `${p} ${(v * 100).toFixed(0)}%`)
      .join(', ');
    if (shares) parts.push(`Expected delivery-platform distribution (probabilistic): ${shares}.`);
  }

  if (!complete) {
    const at = stoppedAtFilterIndex !== undefined ? filters[stoppedAtFilterIndex]?.filter : unsupportedFilters[0];
    parts.push(`Evaluation is INCOMPLETE: unsupported filter "${at}" at step ${stoppedAtFilterIndex}; RADAR makes no definitive steering claim beyond that step.`);
  }
  return parts.join(' ');
}

function computeDistribution(
  weightedSet: Work[] | undefined,
  method: ExpectedDistribution['method'] | undefined,
  survivors: Work[],
): ExpectedDistribution | undefined {
  const disclaimers = [
    'Weighted Shuffle is probabilistic: NS1 randomly orders answers per resolution weighted by these values; it does NOT guarantee exact per-viewer traffic percentages.',
    'Actual viewer distribution is further shaped by recursive-resolver caching and TTL, EDNS Client Subnet coverage, and player-session duration.',
    'These shares describe NS1 delivery-platform selection only; downstream Cloudflare pool and individual cache selection are outside NS1 (RADAR §7).',
  ];

  const set = weightedSet && weightedSet.length ? weightedSet : undefined;
  if (set && method === 'weighted_shuffle') {
    // Effective weight = configured weight × shed survival factor. In the shed mid-band an answer
    // is served on only (1 − shedProbability) of queries, so its expected share is scaled down and
    // the freed share flows to the answers that are not shedding (approximation — NS1's exact
    // mid-band curve is unpublished; the endpoints load≤low and load≥high are exact).
    const w = (x: Work) => (numMeta(x.raw.meta?.weight) ?? 1) * (x.shedFactor ?? 1);
    const total = set.reduce((s, x) => s + w(x), 0);
    if (total <= 0) return undefined;
    return {
      probabilistic: true,
      method: 'weighted_shuffle',
      shares: set.map((x) => ({ answerId: x.id, label: x.label, deliveryPlatform: x.platform, share: w(x) / total })),
      disclaimers,
    };
  }
  if (survivors.length === 1) {
    const x = survivors[0];
    return {
      probabilistic: true,
      method: 'single_answer',
      shares: [{ answerId: x.id, label: x.label, deliveryPlatform: x.platform, share: 1 }],
      disclaimers,
    };
  }
  return undefined;
}
