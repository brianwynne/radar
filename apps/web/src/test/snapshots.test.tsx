import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ENGINEER, VE, renderAt, stubApi } from './helpers';

afterEach(() => vi.unstubAllGlobals());

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

  it('compares two selected snapshots and shows the diff', async () => {
    stubApi(VE);
    renderAt(RECORD);
    await screen.findByText('before change');
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    await userEvent.click(boxes[0]);
    await userEvent.click(boxes[1]);
    await userEvent.click(await screen.findByRole('button', { name: /Compare selected/i }));

    expect(await screen.findByText('Comparison')).toBeInTheDocument();
    const table = screen.getByText('answers[0].meta.weight').closest('table') as HTMLElement;
    expect(within(table).getByText('changed')).toBeInTheDocument();
    expect(within(table).getByText('70')).toBeInTheDocument();
    expect(within(table).getByText('60')).toBeInTheDocument();
  });
});
