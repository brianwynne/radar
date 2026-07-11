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
  TracedAnswer,
} from './model.js';

/** Internal working answer with a stable id carried across steps. */
interface Work {
  id: string;
  label: string;
  platform?: string;
  raw: NS1Answer;
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

const platformOf = (a: NS1Answer): string | undefined =>
  typeof a.meta?.note === 'string' ? a.meta.note : undefined;

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

const netfence_asn: FilterFn = (input, _c, ctx) => {
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
  const output: Work[] = [];
  const outcomes: AnswerOutcome[] = [];
  let feedSeen = false;
  for (const w of input) {
    const set = asnMeta(w.raw.meta?.asn);
    if (set === undefined) {
      output.push(w);
      outcomes.push({ answerId: w.id, disposition: 'retained', reason: 'no ASN metadata → global answer, kept' });
    } else if (set === 'feed') {
      feedSeen = true;
      output.push(w);
      outcomes.push({ answerId: w.id, disposition: 'retained', reason: 'ASN metadata is feed-driven → kept (state unknown in v1)' });
    } else if (set.includes(ctx.asn)) {
      output.push(w);
      outcomes.push({ answerId: w.id, disposition: 'retained', reason: `ASN ${ctx.asn} in answer set [${set.join(', ')}]` });
    } else {
      outcomes.push({ answerId: w.id, disposition: 'removed', reason: `ASN ${ctx.asn} not in answer set [${set.join(', ')}]` });
    }
  }
  return {
    output,
    outcomes,
    reorder: false,
    metadataConsumed: ['asn'],
    confidence: feedSeen ? 'medium' : 'high',
    reason: `Fenced by ASN ${ctx.asn}: retained ${output.length}, removed ${input.length - output.length}.`,
  };
};

const netfence_prefix: FilterFn = (input, _c, ctx) => {
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
  const output: Work[] = [];
  const outcomes: AnswerOutcome[] = [];
  for (const w of input) {
    const set = listMeta(w.raw.meta?.ip_prefixes);
    if (set === undefined) {
      output.push(w);
      outcomes.push({ answerId: w.id, disposition: 'retained', reason: 'no prefix metadata → global answer, kept' });
    } else if (set === 'feed') {
      output.push(w);
      outcomes.push({ answerId: w.id, disposition: 'retained', reason: 'prefix metadata is feed-driven → kept' });
    } else {
      const match = set.some((p) => cidrContains(p, clientPrefix) === true);
      if (match) {
        output.push(w);
        outcomes.push({ answerId: w.id, disposition: 'retained', reason: `client ${clientPrefix} within answer prefixes` });
      } else {
        outcomes.push({ answerId: w.id, disposition: 'removed', reason: `client ${clientPrefix} not within [${set.join(', ')}]` });
      }
    }
  }
  return {
    output,
    outcomes,
    reorder: false,
    metadataConsumed: ['ip_prefixes'],
    confidence: 'high',
    reason: `Fenced by prefix ${clientPrefix}: retained ${output.length}, removed ${input.length - output.length}.`,
  };
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
  const removeNoLoc = config.remove_no_location === true;
  const output: Work[] = [];
  const outcomes: AnswerOutcome[] = [];
  for (const w of input) {
    const cs = countryList(w.raw.meta?.country);
    if (cs.length === 0) {
      if (removeNoLoc) {
        outcomes.push({ answerId: w.id, disposition: 'removed', reason: 'no country metadata & remove_no_location=true' });
      } else {
        output.push(w);
        outcomes.push({ answerId: w.id, disposition: 'retained', reason: 'no country metadata → kept (fallback)' });
      }
    } else if (cs.includes(country)) {
      output.push(w);
      outcomes.push({ answerId: w.id, disposition: 'retained', reason: `country ${country} in [${cs.join(', ')}]` });
    } else {
      outcomes.push({ answerId: w.id, disposition: 'removed', reason: `country ${country} not in [${cs.join(', ')}]` });
    }
  }
  return {
    output,
    outcomes,
    reorder: false,
    metadataConsumed: ['country'],
    confidence: 'high',
    reason: `Fenced by country ${country}: retained ${output.length}, removed ${input.length - output.length}.`,
  };
};

// NOTE: `priority`, `cost`, `shed_load` and the Pulsar filters are deliberately NOT
// implemented (NS1 guide §17). Their wire representation, mode (sort vs sift),
// missing-value behaviour and interaction with later filters are fixture-pending, so
// RADAR treats them as UNSUPPORTED → partial rather than guessing (see
// docs/ns1/assumptions.md). The raw filter config is still displayed; evaluation stops
// claiming completeness at that step.

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
  weighted_shuffle: 'reorder',
  select_first_n: 'select',
};

/* ---------------------------------------------------------------- evaluate */

export function evaluate(record: NS1Record, scenario: Scenario): EvaluationResult {
  const identity = deriveIdentity(record, scenario);

  const works: Work[] = record.answers.map((a, i) => {
    const platform = platformOf(a);
    const id = a.id || (platform ? platform.toLowerCase().replace(/\s+/g, '-') : undefined) || `answer-${i}`;
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
  const lastTrace = traces[traces.length - 1];
  const selected =
    lastTrace && lastTrace.supported && lastTrace.type === 'select_first_n' && eligibleAnswerIds.length === 1
      ? eligibleAnswerIds[0]
      : eligibleAnswerIds.length === 1
        ? eligibleAnswerIds[0]
        : undefined;

  const expectedDistribution = computeDistribution(weightedSet, weightingMethod, current);
  const explanation = buildExplanation(
    record, identity, byId, selected, eligibleAnswerIds, expectedDistribution, complete, stoppedAtFilterIndex, record.filters, unsupportedFilters,
  );

  return {
    scenario, identity, answers, traces, eligibleAnswerIds, selected,
    expectedDistribution, complete, stoppedAtFilterIndex, explanation, warnings, unsupportedFilters,
  };
}

/** Human-readable steering explanation (NS1 guide §25 `explanation`). Composed from
 *  the trace; adds no new evaluation semantics. */
function buildExplanation(
  record: NS1Record,
  identity: DerivedIdentity,
  byId: Map<string, Work>,
  selected: string | undefined,
  eligible: string[],
  dist: ExpectedDistribution | undefined,
  complete: boolean,
  stoppedAtFilterIndex: number | undefined,
  filters: NS1Filter[],
  unsupportedFilters: string[],
): string {
  const parts: string[] = [];
  const src = identity.sourceUsed === 'ecs'
    ? `the EDNS Client Subnet ${identity.evaluatedAddress}`
    : `the resolver IP ${identity.evaluatedAddress}`;
  const geo = [identity.country && `country ${identity.country}`, identity.asn && `ASN ${identity.asn}`].filter(Boolean).join(', ');
  parts.push(`Evaluated ${record.domain} ${record.type} using ${src}${geo ? ` (${geo})` : ''}; identity confidence ${identity.confidence}.`);

  if (selected) {
    const w = byId.get(selected);
    parts.push(`Selected delivery platform: ${w?.platform ?? w?.label ?? selected}.`);
  } else if (eligible.length > 1) {
    parts.push(`${eligible.length} answers remain eligible; NS1 returns one probabilistically.`);
  } else if (eligible.length === 0) {
    parts.push('No answers remain eligible.');
  }

  if (dist) {
    const shares = dist.shares.filter((s) => s.share > 0).map((s) => `${s.deliveryPlatform ?? s.label} ${(s.share * 100).toFixed(0)}%`).join(', ');
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
    const w = (x: Work) => numMeta(x.raw.meta?.weight) ?? 1;
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
