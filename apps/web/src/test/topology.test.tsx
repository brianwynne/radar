import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { NOC, VE, renderAt, stubApi } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING

describe('Delivery Topology', () => {
  it('NOC Viewer can access the topology summary', async () => {
    stubApi(NOC);
    renderAt('/topology');
    expect(await screen.findByText('Delivery Topology')).toBeInTheDocument();
    expect(screen.getAllByText(/Telemetry not connected/i).length).toBeGreaterThan(0);
  });

  it('Viewing Engineer sees topology detail (ASN → path mapping)', async () => {
    stubApi(VE);
    renderAt('/topology');
    expect(await screen.findByText(/ASN → path mapping is CONFIGURED/i)).toBeInTheDocument();
  });

  it('shows NS1 before the delivery platforms, and does not show NS1 selecting a cache pool', async () => {
    stubApi(VE);
    renderAt('/topology');
    const steering = await screen.findByTestId('topology-steering');
    const ns1 = within(steering).getByText('NS1');
    const realta = within(steering).getByText('Réalta');
    expect(ns1.compareDocumentPosition(realta) & FOLLOWING).toBeTruthy(); // NS1 precedes Réalta
    for (const p of ['Fastly', 'Akamai', 'CloudFront']) expect(within(steering).getByText(p)).toBeInTheDocument();
    // NS1 selects platforms only — no cache pool inside the steering section.
    expect(within(steering).queryByText('Donnybrook Pool 1')).toBeNull();
    expect(screen.getByText(/NS1 selects the delivery platform/i)).toBeInTheDocument();
  });

  it('shows Cloudflare after Réalta in the origin-selection section', async () => {
    stubApi(VE);
    renderAt('/topology');
    const realtaSection = await screen.findByTestId('topology-realta');
    const realta = within(realtaSection).getByText('Réalta');
    const cloudflare = within(realtaSection).getByText('Cloudflare Load Balancer');
    expect(realta.compareDocumentPosition(cloudflare) & FOLLOWING).toBeTruthy();
    expect(within(realtaSection).getByText('Donnybrook Pool 1')).toBeInTheDocument();
  });

  it('labels configured capacities and never shows measured utilisation', async () => {
    stubApi(VE);
    renderAt('/topology');
    await screen.findByText('Delivery Topology');
    expect(screen.getAllByText('MANUALLY MAINTAINED').length).toBeGreaterThan(0);
    expect(screen.getAllByText('CONFIGURED').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getAllByText(/Telemetry not connected/i).length).toBeGreaterThan(0));
  });
});
