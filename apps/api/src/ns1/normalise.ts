// RADAR normalisation: raw NS1 JSON (unknown) -> typed NS1Record for @radar/engine. The
// raw payload is preserved verbatim elsewhere (the /raw route returns exactly what the
// client returned); this produces the engine's input without discarding unknown fields.
//
// Answer ids: NS1 does not guarantee a stable answer id (docs/ns1/assumptions.md), so a
// deterministic RADAR id is generated from position + rdata when one is absent. This
// affects only the engine input, never the preserved raw payload.
import type { NS1Record } from '@radar/engine';
import { Ns1Error } from './errors.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normaliseRecord(raw: unknown): NS1Record {
  if (!isObject(raw)) {
    throw new Ns1Error('NS1_INVALID_RESPONSE');
  }
  const rawAnswers = Array.isArray(raw.answers) ? raw.answers : [];
  const answers = rawAnswers.map((answer, index) => {
    if (!isObject(answer)) return answer;
    if (typeof answer.id === 'string' && answer.id.length > 0) return answer;
    const rdata = Array.isArray(answer.answer) ? answer.answer.join('_') : String(index);
    return { ...answer, id: `ans-${index}-${rdata}` };
  });
  const filters = Array.isArray(raw.filters) ? raw.filters : [];

  // Preserve every field; only ensure answers/filters are the arrays the engine expects.
  return { ...raw, answers, filters } as unknown as NS1Record;
}
