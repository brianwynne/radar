import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NOC, VE, renderAt } from './helpers';
import type { Principal, ValidationResultItem } from '../api/types';

afterEach(() => vi.unstubAllGlobals());

const RESULT: ValidationResultItem = {
  id: 'val-1', endpoint: 'record', resourceKey: 'rte.ie/live.rte.ie/A', zone: 'rte.ie', domain: 'live.rte.ie', recordType: 'A',
  sourceMode: 'mock', retrievedAt: '2026-07-12T10:00:00Z', ranAt: '2026-07-12T10:00:00Z', rawChecksum: 'sha256:aaaa', structuralChecksum: 'sha256:bbbb',
  overallStatus: 'partial', schemaCompatible: true, schemaIssues: [], adapterCompatible: true,
  supportedFilters: ['up', 'weighted_shuffle'], unsupportedFilters: ['shed_load'],
  unknownMetadataFields: ['mystery_meta'], unexpectedFields: [], missingExpectedFields: [],
  fieldTypeMismatches: [], unsupportedFeatures: [{ kind: 'filter', name: 'shed_load', detail: 'unsupported' }],
  answerGroupsPresent: false, feedControlledMetadataPresent: true, ecs: { present: true, enabled: true },
  fixtureComparison: { provisionalFixtureFields: ['answers[].meta.asn'], liveOnlyFields: [], typeMismatches: [], matches: false },
  warnings: ['Unsupported filter(s): shed_load.'],
  sanitisedSample: { id: 'r', apiKey: '[REDACTED]', filters: [{ filter: 'shed_load' }] },
  fixtureCandidate: { provenance: { source: 'ns1', mode: 'mock', endpoint: 'record', resourceKey: 'rte.ie/live.rte.ie/A', retrievedAt: '2026-07-12T10:00:00Z', rawChecksum: 'sha256:aaaa', generatedBy: 'radar-validation', warning: 'CANDIDATE ONLY — credential-redacted, requires operator review, and is NOT a committed fixture.', reviewRequired: ['unsupported filter: shed_load', 'redacted credential-like field: apiKey'] }, payload: { id: 'r', apiKey: '[REDACTED]' } },
};

function stub(principal: Principal, opts: { runResult?: ValidationResultItem } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const p = String(input).split('?')[0];
      const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
      if (p.endsWith('/api/v1/me')) return j(principal);
      if (p.endsWith('/ns1/config')) return j({ mode: 'mock', synthetic: true, readOnly: true });
      if (p.endsWith('/validation/ns1/results')) return j({ provenance: { source: 'radar', readOnly: true, notice: 'x', retrievedAt: 'x' }, mode: 'mock', count: 0, items: [] });
      if (p.endsWith('/validation/ns1/run') && init?.method === 'POST') return j({ provenance: { source: 'radar', readOnly: true, notice: 'Validation is read-only. RADAR has not modified NS1.', retrievedAt: 'x' }, mode: 'mock', count: 1, results: [opts.runResult ?? RESULT] });
      return j({});
    }),
  );
}

describe('NS1 Validation screen', () => {
  it('shows the read-only warning and lets a Viewing Engineer run validation', async () => {
    stub(VE);
    renderAt('/validation/ns1');
    expect(await screen.findByText(/Validation is read-only\. RADAR has not modified NS1\./)).toBeInTheDocument();
    const runBtn = await screen.findByRole('button', { name: 'Run validation' });
    await userEvent.click(runBtn);
    // The result card renders the compatibility status and the unsupported filter.
    expect(await screen.findByText('partial')).toBeInTheDocument();
    expect(screen.getAllByText('shed_load').length).toBeGreaterThan(0);
    expect(screen.getByText(/Fixture comparison\./)).toBeInTheDocument();
  });

  it('offers a review-flagged sanitised fixture candidate (never auto-committed) to a raw-permitted engineer', async () => {
    stub(VE);
    renderAt('/validation/ns1');
    await userEvent.click(await screen.findByRole('button', { name: 'Run validation' }));
    expect(await screen.findByRole('button', { name: 'Generate sanitised fixture candidate' })).toBeInTheDocument();
    expect(screen.getByText(/requires operator review before use/)).toBeInTheDocument();
    // Sanitised raw exposes only redacted credentials, never the secret.
    await userEvent.click(screen.getByRole('button', { name: 'Show sanitised raw' }));
    expect(await screen.findByText(/\[REDACTED\]/)).toBeInTheDocument();
  });

  it('hides the run action from a Viewing Engineer without validation.run', async () => {
    const noRun: Principal = { ...VE, permissions: VE.permissions.filter((p) => p !== 'validation.run') };
    stub(noRun);
    renderAt('/validation/ns1');
    expect(await screen.findByText(/requires the/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run validation' })).toBeNull();
  });

  it('denies a NOC viewer the validation screen', async () => {
    stub(NOC);
    renderAt('/validation/ns1');
    expect(await screen.findByText(/require the Viewing Engineer role/)).toBeInTheDocument();
  });
});
