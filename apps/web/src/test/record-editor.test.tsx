import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecordEditor, cleanForNs1 } from '../components/RecordEditor';

afterEach(() => vi.restoreAllMocks());

describe('cleanForNs1', () => {
  it('strips identity echoes and _radar_note anywhere, keeps steering fields', () => {
    const rec = {
      id: 'demo', zone: 'rte.ie', domain: 'live.rte.ie', type: 'CNAME', _radar_note: 'synthetic',
      ttl: 180, use_client_subnet: true,
      answers: [{ id: 'a1', answer: ['liveedge.rte.ie'], meta: { up: true, weight: 70, _radar_note: 'x' } }],
      filters: [{ filter: 'up' }], regions: {},
    };
    const out = cleanForNs1(rec) as Record<string, unknown>;
    expect(out.id).toBeUndefined();
    expect(out.zone).toBeUndefined();
    expect(out.domain).toBeUndefined();
    expect(out.type).toBeUndefined();
    expect(out._radar_note).toBeUndefined();
    // Steering fields preserved.
    expect(out.ttl).toBe(180);
    expect(out.use_client_subnet).toBe(true);
    expect(out.filters).toEqual([{ filter: 'up' }]);
    const answers = out.answers as Array<Record<string, unknown>>;
    expect(answers[0].answer).toEqual(['liveedge.rte.ie']);
    expect(answers[0].id).toBe('a1'); // answer ids kept (needed for in-place update)
    const meta = answers[0].meta as Record<string, unknown>;
    expect(meta._radar_note).toBeUndefined(); // deep-stripped
    expect(meta.up).toBe(true);
    expect(meta.weight).toBe(70);
  });

  it('does not mutate the input', () => {
    const rec = { id: 'x', ttl: 1 };
    cleanForNs1(rec);
    expect(rec.id).toBe('x'); // original untouched
  });
});

describe('RecordEditor', () => {
  it('copies an NS1-clean payload to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<RecordEditor initial={{ id: 'x', zone: 'rte.ie', ttl: 30, answers: [] }} />);
    await userEvent.click(screen.getByRole('button', { name: /Copy for NS1/i }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual({ ttl: 30, answers: [] }); // id + zone stripped
  });

  it('marks invalid JSON and disables Copy', async () => {
    render(<RecordEditor initial={{ ttl: 1 }} />);
    const textarea = screen.getByLabelText('Record JSON editor');
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'nope'); // not valid JSON
    expect(screen.getByText('invalid JSON')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy for NS1/i })).toBeDisabled();
  });
});
