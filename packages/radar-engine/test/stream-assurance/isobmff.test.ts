import { describe, it, expect } from 'vitest';
import { parseBoxes, findBox, findAllBoxes } from '../../src/stream-assurance/index.js';
import { buildInitSegment, oversizedBox, deeplyNested } from './fixtures.js';

const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const cc = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

describe('parseBoxes (bounded ISO-BMFF)', () => {
  it('parses a valid init segment and finds deeply-nested boxes with retained offsets', () => {
    const seg = buildInitSegment();
    const { boxes, truncated, warnings } = parseBoxes(seg);
    expect(truncated).toBe(false);
    expect(warnings).toHaveLength(0);
    expect(boxes.map((b) => b.type)).toEqual(expect.arrayContaining(['ftyp', 'moov']));
    for (const t of ['trak', 'mdia', 'stsd', 'enca', 'sinf', 'schm', 'schi', 'tenc', 'pssh']) {
      expect(findBox(boxes, t), `missing ${t}`).toBeDefined();
    }
    const tenc = findBox(boxes, 'tenc')!;
    expect(tenc.end - tenc.start).toBe(tenc.size);
    expect(tenc.payloadStart).toBe(tenc.start + tenc.headerSize);
  });

  it('treats a box larger than the buffer as truncated without allocating', () => {
    const { truncated, warnings, boxes } = parseBoxes(oversizedBox());
    expect(truncated).toBe(true);
    expect(warnings.join(' ')).toMatch(/beyond bound|truncated/);
    expect(boxes[0].type).toBe('moov');
  });

  it('rejects a box whose declared size is smaller than its header', () => {
    const bad = new Uint8Array([0, 0, 0, 4, ...cc('moov')]); // size 4 < 8
    const { boxes } = parseBoxes(bad);
    expect(boxes).toHaveLength(0);
  });

  it('supports a 64-bit largesize box', () => {
    const payload = [1, 2, 3, 4, 5, 6, 7, 8];
    const size = 16 + payload.length;
    const bytes = new Uint8Array([0, 0, 0, 1, ...cc('free'), ...u32(0), ...u32(size), ...payload]);
    const { boxes, truncated } = parseBoxes(bytes);
    expect(truncated).toBe(false);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].type).toBe('free');
    expect(boxes[0].headerSize).toBe(16);
    expect(boxes[0].size).toBe(size);
  });

  it('stops descending past the configured depth limit', () => {
    const seg = deeplyNested(40);
    const { warnings } = parseBoxes(seg, { maxDepth: 8 });
    expect(warnings.join(' ')).toMatch(/max depth/);
    const shallow = parseBoxes(seg, { maxDepth: 8 });
    expect(findAllBoxes(shallow.boxes, 'moov').length).toBeLessThan(40); // did not walk all 40 levels
  });

  it('enforces the box-count limit', () => {
    const sibling = [...u32(8), ...cc('free')];
    const many = new Uint8Array(Array.from({ length: 50 }, () => sibling).flat());
    const { boxes, warnings } = parseBoxes(many, { maxBoxes: 10 });
    expect(boxes.length).toBeLessThanOrEqual(10);
    expect(warnings.join(' ')).toMatch(/box limit/);
  });
});
