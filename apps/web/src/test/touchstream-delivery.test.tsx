import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderAt, stubApi, ENGINEER } from './helpers';

async function openTab() {
  stubApi(ENGINEER);
  const view = renderAt('/stream-assurance');
  const tab = await screen.findByRole('button', { name: /Touchstream Delivery/ });
  fireEvent.click(tab);
  await screen.findByText('Delivery matrix');
  return view;
}

describe('Touchstream delivery matrix', () => {
  it('states the provenance on the page, not only in the API envelope', async () => {
    await openTab();
    // An operator must not be able to read this as viewer traffic.
    expect(screen.getByText(/measured synthetic delivery/)).toBeInTheDocument();
    expect(screen.getByText(/cannot show what a subscriber on any ISP received/)).toBeInTheDocument();
  });

  it('renders a column per platform and a row per channel/format', async () => {
    await openTab();
    expect(screen.getByText('Réalta')).toBeInTheDocument();
    expect(screen.getByText('Akamai')).toBeInTheDocument();
    expect(screen.getByText('Channel One')).toBeInTheDocument();
    expect(screen.getByText('MPD')).toBeInTheDocument();
  });

  it('shows an unmonitored cell as NOT MONITORED rather than leaving it blank or passing', async () => {
    const { container } = await openTab();
    expect(screen.getByText('not monitored')).toBeInTheDocument();
    const empty = container.querySelector('.ts-cell.empty')!;
    expect(empty).not.toBeNull();
    // The distinction is semantic, so it must also be in the accessible title, not just the hatching.
    expect(empty.getAttribute('title')).toContain('unmeasured, not known good');
  });

  it('flags a CDN whose label is contradicted by the edge that served it', async () => {
    await openTab();
    expect(screen.getByText('label ≠ edge')).toBeInTheDocument();
    expect(screen.getByText(/1 thing to look at/)).toBeInTheDocument();
    expect(screen.getByText(/measuring RTÉ's own delivery, not AKAMAI/)).toBeInTheDocument();
  });

  it('re-bases every speed figure when the basis toggle switches to like-for-like', async () => {
    const { container } = await openTab();
    const speeds = () => [...container.querySelectorAll('.ts-speed')].map((n) => n.textContent);
    // Headline: Touchstream's own per-monitor averages (mixed geography).
    expect(speeds()).toEqual(['0.3', '3.7']);
    fireEvent.click(screen.getByRole('button', { name: 'Like-for-like' }));
    // Like-for-like: restricted to the row's shared probe location (London).
    expect(speeds()).toEqual(['0.2', '2.4']);
    expect(screen.getAllByText(/at 1 shared/).length).toBe(2);
    // …and the probes dropped from the comparison are counted.
    expect(screen.getAllByText('−1 excluded').length).toBe(2);
  });

  it('warns that headline averages are not comparable, and names where they can be', async () => {
    await openTab();
    expect(screen.getByText('compare at GB-LND-LND')).toBeInTheDocument();
    expect(screen.getByText(/not comparable — switch to like-for-like/)).toBeInTheDocument();
  });

  it('drills down to probe locations with the serving edge and ownership', async () => {
    const { container } = await openTab();
    fireEvent.click(screen.getByRole('button', { name: /Channel One/ }));
    const row = container.querySelector('.ts-row.open')!;
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('IE-D-AWS')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('185.54.104.4')).toBeInTheDocument();
    expect(within(row as HTMLElement).getAllByText('RTÉ-owned').length).toBeGreaterThan(0);
    expect(within(row as HTMLElement).getByText(/Dublin, Ireland/)).toBeInTheDocument();
  });

  it('reports coverage as a share of channel×CDN cells', async () => {
    await openTab();
    expect(screen.getByText('66.7%')).toBeInTheDocument();
    expect(screen.getByText(/2 of 3 channel×CDN cells/)).toBeInTheDocument();
  });

  it('keeps the conformance tab and the Touchstream tab separate', async () => {
    await openTab();
    // Switching back restores RADAR's own runs; the two sources are never blended into one view.
    fireEvent.click(screen.getByRole('button', { name: /Conformance & CDN Consistency/ }));
    expect(screen.queryByText('Delivery matrix')).not.toBeInTheDocument();
  });
});
