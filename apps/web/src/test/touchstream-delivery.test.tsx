import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderAt, stubApi, ENGINEER } from './helpers';

async function openTab() {
  stubApi(ENGINEER);
  const view = renderAt('/stream-assurance');
  const tab = await screen.findByRole('button', { name: /Touchstream Delivery/ });
  fireEvent.click(tab);
  await screen.findByText(/Touchstream · delivery monitoring/);
  return view;
}

describe('Touchstream delivery matrix', () => {
  it('states the provenance on the page, not only in the API envelope', async () => {
    await openTab();
    // An operator must not be able to read this as viewer traffic.
    expect(screen.getByText(/measured synthetic delivery/)).toBeInTheDocument();
    expect(screen.getByText(/not what a subscriber on any ISP received/)).toBeInTheDocument();
  });

  it('renders one aligned grid: a column rail per platform and a row per channel/format', async () => {
    const { container } = await openTab();
    expect(screen.getByText('Réalta')).toBeInTheDocument();
    expect(screen.getByText('Akamai')).toBeInTheDocument();
    expect(screen.getByText('Channel One')).toBeInTheDocument();
    expect(screen.getByText('MPD')).toBeInTheDocument();
    // A single grid, not one card per row — that is what keeps columns aligned across channels.
    expect(container.querySelectorAll('.ts-grid')).toHaveLength(1);
    expect(container.querySelectorAll('.ts-rail:not(.ts-rail-corner)')).toHaveLength(3);
  });

  it('groups video and audio separately, each with its own counts', async () => {
    const { container } = await openTab();
    const bands = [...container.querySelectorAll('.ts-group')];
    expect(bands.map((b) => b.querySelector('.ts-group-name')!.textContent)).toEqual(['Video', 'Audio']);
    expect(bands[0].className).toContain('ts-group-video');
    expect(bands[1].className).toContain('ts-group-audio');
    // The audio band covers the radio stream only.
    expect(bands[1].textContent).toContain('1 stream');
    expect(screen.getByText('Radio One')).toBeInTheDocument();
    // Video comes first in the DOM, so the grid reads television then radio.
    expect(bands[0].compareDocumentPosition(bands[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('reports the video and audio split in the console read-outs', async () => {
    await openTab();
    expect(screen.getByText('video · audio')).toBeInTheDocument();
  });

  it('shows an unmonitored cell as NOT MONITORED rather than leaving it blank or passing', async () => {
    const { container } = await openTab();
    expect(screen.getAllByText('not monitored').length).toBeGreaterThan(0);
    const empty = container.querySelector('.ts-cell-empty')!;
    expect(empty).not.toBeNull();
    // The distinction is semantic, so it must also be in the accessible title, not just the hatching.
    expect(empty.getAttribute('title')).toContain('unmeasured, not known good');
  });

  it('flags a CDN whose label is contradicted by the edge that served it', async () => {
    const { container } = await openTab();
    // The flag sits on the cell (the console read-out carries the same wording as its tally).
    expect(within(container.querySelector('.ts-grid') as HTMLElement).getByText('edge ≠ label')).toBeInTheDocument();
    expect(screen.getByText(/1 thing to look at/)).toBeInTheDocument();
    expect(screen.getByText(/measuring RTÉ's own delivery, not AKAMAI/)).toBeInTheDocument();
  });

  it('re-bases every speed figure when the basis toggle switches to like-for-like', async () => {
    const { container } = await openTab();
    const speeds = () => [...container.querySelectorAll('.ts-speed')].map((n) => n.textContent);
    // Headline: Touchstream's own per-monitor averages (mixed geography).
    // Two video CDNs plus the audio stream.
    expect(speeds()).toEqual(['0.3', '3.7', '2.5']);
    fireEvent.click(screen.getByRole('button', { name: 'Like-for-like' }));
    // Like-for-like: the video row re-bases onto its one shared probe (London); audio already
    // shares every probe, so it does not move.
    expect(speeds()).toEqual(['0.2', '2.4', '2.5']);
    expect(screen.getAllByText(/1 shared probe/).length).toBeGreaterThanOrEqual(2);
    // …and the probes dropped from the comparison are counted.
    expect(screen.getAllByText('−1 not comparable').length).toBe(2);
  });

  it('warns that headline averages are not comparable, and names where they can be', async () => {
    await openTab();
    expect(screen.getByText('≠ basis')).toBeInTheDocument();
    expect(screen.getByText(/Rows marked ≠ basis are probed from different places/)).toBeInTheDocument();
  });

  it('opens probe detail inside the grid columns, so probes stay comparable across CDNs', async () => {
    const { container } = await openTab();
    fireEvent.click(screen.getByRole('button', { name: /RTE CDN/ }));
    // Detail cells are grid children, one per column — not a panel that breaks alignment.
    const detail = [...container.querySelectorAll('.ts-detail-cell')];
    expect(detail).toHaveLength(3);
    const all = detail.map((d) => d.textContent).join(' ');
    expect(all).toContain('IE-D-AWS');
    expect(all).toContain('185.54.104.4');
    expect(all).toContain('Dublin, Ireland');
    expect(container.querySelectorAll('.ts-owned').length).toBeGreaterThan(0);
  });

  it('reports coverage as a share of channel×CDN cells', async () => {
    await openTab();
    expect(screen.getByText('67%')).toBeInTheDocument(); // the arc rounds for legibility
    expect(screen.getByText(/2 of 3 channel×CDN/)).toBeInTheDocument();
  });

  it('keeps the conformance tab and the Touchstream tab separate', async () => {
    await openTab();
    // Switching back restores RADAR's own runs; the two sources are never blended into one view.
    fireEvent.click(screen.getByRole('button', { name: /Conformance & CDN Consistency/ }));
    expect(screen.queryByText(/Touchstream · delivery monitoring/)).not.toBeInTheDocument();
  });
});
