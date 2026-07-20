import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ENGINEER, VE, renderAt, stubApi } from './helpers';

const rowOf = (label: string) => screen.getByText(label).closest('tr') as HTMLElement;
const fetchCalls = () => (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const RECORD = '/explorer/rte.ie/live.rte.ie/A';

describe('Snapshots (in NS1 Explorer)', () => {
  it('shows snapshot history from the API to a Viewing Engineer, without a capture button', async () => {
    stubApi(VE);
    renderAt(RECORD);
    expect(await screen.findByText('before change')).toBeInTheDocument(); // history row from API
    expect(screen.getByText('after change')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Capture snapshot/i })).toBeNull(); // no snapshot.create
  });

  it('lets an Engineer capture a snapshot', async () => {
    stubApi(ENGINEER);
    renderAt(RECORD);
    const capture = await screen.findByRole('button', { name: /Capture snapshot/i });
    await userEvent.click(capture);
    // History reloads and remains rendered from the API.
    expect(await screen.findByText('before change')).toBeInTheDocument();
  });

  it('lets an Engineer rename a snapshot (PATCH with the new label)', async () => {
    stubApi(ENGINEER);
    renderAt(RECORD);
    await screen.findByText('before change');
    // Capture the row node up front — its label turns into an input during edit (so it's no
    // longer findable by text), but the <tr> persists by key across the reload.
    const row = rowOf('before change');
    await userEvent.click(within(row).getByRole('button', { name: /rename snapshot/i }));
    const input = within(row).getByRole('textbox', { name: /rename/i });
    expect(input).toHaveValue('before change'); // prefilled with current label
    await userEvent.clear(input);
    await userEvent.type(input, 'checkpoint A');
    await userEvent.click(within(row).getByRole('button', { name: /^Save$/ }));

    const patch = fetchCalls().find((c) => /\/api\/v1\/snapshots\/[^/]+$/.test(String(c[0])) && c[1]?.method === 'PATCH');
    expect(patch).toBeTruthy();
    expect(JSON.parse(String(patch![1]!.body))).toEqual({ label: 'checkpoint A' });
    // Edit mode closes after saving.
    await waitFor(() => expect(within(row).queryByRole('textbox')).toBeNull());
  });

  it('does not show rename or delete controls to a read-only Viewing Engineer', async () => {
    stubApi(VE);
    renderAt(RECORD);
    await screen.findByText('before change');
    expect(screen.queryByRole('button', { name: /rename snapshot/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete snapshot/i })).toBeNull();
  });

  it('lets an Engineer delete a snapshot after confirming', async () => {
    stubApi(ENGINEER);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderAt(RECORD);
    await screen.findByText('before change');
    await userEvent.click(within(rowOf('before change')).getByRole('button', { name: /delete snapshot/i }));
    expect(confirmSpy).toHaveBeenCalled();
    const del = fetchCalls().find((c) => /\/api\/v1\/snapshots\/[^/]+$/.test(String(c[0])) && c[1]?.method === 'DELETE');
    expect(del).toBeTruthy();
  });

  it('cancelling the confirm does not delete', async () => {
    stubApi(ENGINEER);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderAt(RECORD);
    await screen.findByText('before change');
    await userEvent.click(within(rowOf('before change')).getByRole('button', { name: /delete snapshot/i }));
    expect(fetchCalls().some((c) => /\/api\/v1\/snapshots\/[^/]+$/.test(String(c[0])) && c[1]?.method === 'DELETE')).toBe(false);
  });

  it('compares two selected snapshots and shows the diff', async () => {
    stubApi(VE);
    renderAt(RECORD);
    await screen.findByText('before change');
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    await userEvent.click(boxes[0]);
    await userEvent.click(boxes[1]);
    await userEvent.click(await screen.findByRole('button', { name: /^Compare$/ }));

    expect(await screen.findByText('Comparison')).toBeInTheDocument();
    const table = screen.getByText('answers[0].meta.weight').closest('table') as HTMLElement;
    expect(within(table).getByText('changed')).toBeInTheDocument();
    expect(within(table).getByText('70')).toBeInTheDocument();
    expect(within(table).getByText('60')).toBeInTheDocument();
  });

  it('compares one snapshot against a chosen current NS1 record', async () => {
    stubApi(VE);
    renderAt(RECORD);
    await screen.findByText('before change');
    // Switch to record-compare mode, select one snapshot, pick a record.
    await userEvent.click(screen.getByRole('radio', { name: /current NS1 record/i }));
    await userEvent.click(screen.getAllByRole('checkbox')[0]);
    const select = await screen.findByLabelText(/NS1 record to compare against/i);
    await userEvent.selectOptions(select, 'vod.rte.ie|A'); // a different record in the zone
    await userEvent.click(screen.getByRole('button', { name: /^Compare$/ }));

    expect(await screen.findByText('Comparison')).toBeInTheDocument();
    expect(screen.getByText(/current vod\.rte\.ie/i)).toBeInTheDocument(); // heading names the target record
    expect(screen.getByText('answers[0].meta.weight')).toBeInTheDocument(); // diff from compare-current
    // The compare-current POST carried the chosen record as its target.
    const call = fetchCalls().find((c) => String(c[0]).includes('/compare-current') && c[1]?.method === 'POST');
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]!.body))).toEqual({ zone: 'rte.ie', domain: 'vod.rte.ie', type: 'A' });
  });
});
