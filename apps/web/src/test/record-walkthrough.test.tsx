import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VE, renderAt, stubApi } from './helpers';
import { question, branches, outcomesOf, highlightMatches } from '../features/RecordWalkthrough';
import type { FilterTrace } from '../api/types';

afterEach(() => vi.unstubAllGlobals());

const mkTrace = (type: string, config: Record<string, unknown> = {}): FilterTrace => ({
  index: 0, type, disabled: false, supported: true, behaviour: 'eliminate', config,
  metadataConsumed: [], input: [], output: [], orderingBefore: [], orderingAfter: [],
  removedAnswerIds: [], outcomes: [], reorder: false, reason: '', confidence: 'high',
});
const identity = { source: 'ecs' as const, evaluatedAddress: '86.40.0.0/24', country: 'IE', asn: 5466, confidence: 'high' as const, notes: [] as string[] };

describe('walkthrough question()', () => {
  it('asks a requester-specific question per filter', () => {
    expect(question(mkTrace('netfence_asn'), identity)).toMatch(/AS5466.*asn metadata/i);
    expect(question(mkTrace('geofence_country'), identity)).toMatch(/country \(IE\)/i);
    expect(question(mkTrace('up'), identity)).toMatch(/up \(healthy\)/i);
    expect(question(mkTrace('weighted_shuffle'), identity)).toMatch(/biased by/i);
    expect(question(mkTrace('select_first_n'), identity)).toMatch(/first N/i);
  });
});

describe('walkthrough branches()', () => {
  it('gives if-yes / if-no rules for fences and reflects the config remove flag', () => {
    expect(branches(mkTrace('netfence_asn', {}))!.ifYes).toMatch(/kept as fallbacks/i);
    expect(branches(mkTrace('netfence_asn', { remove_no_asn: '1' }))!.ifYes).toMatch(/dropped/i);
    expect(branches(mkTrace('netfence_asn'))!.ifNo).toMatch(/only untagged/i);
    expect(branches(mkTrace('geofence_country'))!.ifNo).toMatch(/only answers with no country/i);
    expect(branches(mkTrace('weighted_shuffle'))).toBeNull(); // not a fence
  });
});

describe('walkthrough highlightMatches()', () => {
  it('highlights whole-token matches (the requester ASN/country) but not substrings', () => {
    const { container } = render(<>{highlightMatches('ASN 5466 in answer set [112, 5466, 154660]', ['5466', undefined])}</>);
    const marks = container.querySelectorAll('mark.match-hl');
    expect(marks).toHaveLength(2); // the two standalone 5466s...
    expect([...marks].every((m) => m.textContent === '5466')).toBe(true); // ...not the "5466" inside 154660
  });

  it('returns the text unchanged when there are no tokens', () => {
    const { container } = render(<>{highlightMatches('country IE in [IE, GB]', [])}</>);
    expect(container.querySelectorAll('mark').length).toBe(0);
    expect(container.textContent).toBe('country IE in [IE, GB]');
  });
});

describe('walkthrough outcomesOf()', () => {
  it('prefers the engine outcomes, else synthesises disposition from input/output', () => {
    const withOutcomes = { ...mkTrace('netfence_asn'), outcomes: [{ answerId: 'a', disposition: 'retained' as const, reason: 'ASN 5466 in answer set [5466]' }] };
    expect(outcomesOf(withOutcomes)[0].reason).toMatch(/in answer set/);
    const noOutcomes = { ...mkTrace('up'), input: ['a', 'b'], output: ['a'], outcomes: [] };
    const derived = outcomesOf(noOutcomes);
    expect(derived).toHaveLength(2);
    expect(derived.find((o) => o.answerId === 'a')!.disposition).toBe('retained');
    expect(derived.find((o) => o.answerId === 'b')!.disposition).toBe('removed');
  });
});

describe('Walkthrough tab (in NS1 Explorer)', () => {
  it('walks the chain top-down, headlines the outcome, and shows how the weighting resolves', async () => {
    stubApi(VE);
    renderAt('/explorer/rte.ie/live.rte.ie/A');
    await userEvent.click(await screen.findByRole('button', { name: /^Walkthrough$/ }));
    expect(await screen.findByLabelText(/Requester/i)).toBeInTheDocument();
    // Plain-English headline (default requester is Eir).
    expect(await screen.findByText('Eir', { selector: '.wt-headline strong' })).toBeInTheDocument();
    // Steps from the stub's traces (up + weighted_shuffle).
    expect(screen.getByText('Up')).toBeInTheDocument();
    expect(screen.getByText('Weighted Shuffle')).toBeInTheDocument();
    expect(screen.getByText(/which answers are currently up/i)).toBeInTheDocument();
    // Weighting resolves — Réalta 78% / Fastly 22% (headline + bar + table).
    await waitFor(() => expect(screen.getAllByText('78%').length).toBeGreaterThan(0));
    expect(screen.getAllByText('22%').length).toBeGreaterThan(0);
    expect(screen.getByText(/most likely delivery platform/i)).toBeInTheDocument();
  });

  it('highlights an answer kept as an untagged fallback', async () => {
    stubApi(VE);
    renderAt('/explorer/rte.ie/live.rte.ie/A');
    await userEvent.click(await screen.findByRole('button', { name: /^Walkthrough$/ }));
    const upStep = (await screen.findByText('Up')).closest('.wt-step') as HTMLElement;
    await userEvent.click(within(upStep).getByRole('button', { name: /per-answer detail/i }));
    // The fallback answer is badged "fallback" with the explanatory reason.
    expect(within(upStep).getByText('fallback')).toBeInTheDocument();
    expect(within(upStep).getByText(/kept as a fallback/i)).toBeInTheDocument();
  });

  it('compares several requesters side by side', async () => {
    stubApi(VE);
    renderAt('/explorer/rte.ie/live.rte.ie/A');
    await userEvent.click(await screen.findByRole('button', { name: /^Walkthrough$/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Compare requesters/i }));
    // A matrix with a platform row and per-ISP columns (default: first three ISPs).
    expect(await screen.findByRole('columnheader', { name: /Eir/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Three Ireland/i })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: /Réalta/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('78%').length).toBeGreaterThan(0)); // Réalta share per ISP
  });
});
