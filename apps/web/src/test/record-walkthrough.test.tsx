import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VE, renderAt, stubApi } from './helpers';
import { question, branches } from '../features/RecordWalkthrough';
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

describe('Walkthrough tab (in NS1 Explorer)', () => {
  it('walks the chain top-down and shows how the weighting resolves', async () => {
    stubApi(VE);
    renderAt('/explorer/rte.ie/live.rte.ie/A');
    await userEvent.click(await screen.findByRole('button', { name: /^Walkthrough$/ }));
    // Requester selector present.
    expect(await screen.findByLabelText(/Requester/i)).toBeInTheDocument();
    // Steps from the stub's traces (up + weighted_shuffle).
    expect(await screen.findByText('Up')).toBeInTheDocument();
    expect(screen.getByText('Weighted Shuffle')).toBeInTheDocument();
    expect(screen.getByText(/which answers are currently up/i)).toBeInTheDocument();
    // Weighting resolves — Réalta 78% / Fastly 22% (from the stub distribution; appears in bar + table).
    await waitFor(() => expect(screen.getAllByText('78%').length).toBeGreaterThan(0));
    expect(screen.getAllByText('22%').length).toBeGreaterThan(0);
    expect(screen.getByText(/most likely delivery platform/i)).toBeInTheDocument();
  });
});
