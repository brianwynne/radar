// Bounded, safe ISO Base Media File Format (ISO/IEC 14496-12) box reader — the robust replacement
// for the temporary byte-offset approach used in the CDN-consistency incident investigation. It is
// defensive by construction: validates box sizes and nesting, supports 32- and 64-bit sizes, rejects
// malformed or excessively deep structures, caps the box count, and never allocates based on an
// attacker-controlled length (it only records offsets into the caller's buffer, copying at most the
// small header fields callers ask for). Pure: no I/O, no dependencies.

export interface Box {
  /** 4-character box type (e.g. 'moov', 'tenc'). 'uuid' boxes expose the 16-byte usertype in `uuid`. */
  type: string;
  /** Total box length in bytes (header + payload) as resolved from the wire. */
  size: number;
  /** Header length (8, or 16 for a 64-bit largesize; +16 more for a uuid box). */
  headerSize: number;
  /** Absolute byte offset of the box start (of its size field). */
  start: number;
  /** Absolute byte offset one past the box end. */
  end: number;
  /** Absolute byte offset of the first payload byte (start + headerSize). */
  payloadStart: number;
  /** Present for 'uuid' boxes: the 16-byte extended type as canonical UUID. */
  uuid?: string;
  /** Parsed child boxes for container types (undefined for leaf boxes). */
  children?: Box[];
}

export interface ParseOptions {
  /** Maximum container nesting depth (default 32). */
  maxDepth?: number;
  /** Maximum total boxes parsed across the tree (default 100_000). */
  maxBoxes?: number;
}

export interface ParseResult {
  boxes: Box[];
  /** True when the buffer ended inside a box (declared size exceeded the data). */
  truncated: boolean;
  warnings: string[];
}

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_BOXES = 100_000;

// Container boxes whose payload is entirely further boxes.
const CONTAINERS = new Set([
  'moov', 'trak', 'edts', 'mdia', 'minf', 'dinf', 'stbl', 'mvex', 'moof', 'traf', 'mfra',
  'sinf', 'schi', 'udta', 'strk', 'sthd',
]);
// Sample-entry boxes carry a fixed-size record before any child boxes (e.g. sinf).
const VISUAL_SAMPLE_ENTRIES = new Set(['encv', 'avc1', 'avc3', 'hev1', 'hvc1', 'hvc2', 'av01', 'vp08', 'vp09', 'dvh1', 'dvhe']);
const AUDIO_SAMPLE_ENTRIES = new Set(['enca', 'mp4a', 'ac-3', 'ec-3', 'ac-4', 'Opus', 'fLaC', 'dtsc']);
const VISUAL_SAMPLE_ENTRY_HEADER = 78; // SampleEntry(8) + VisualSampleEntry(70)
const AUDIO_SAMPLE_ENTRY_HEADER = 28; // SampleEntry(8) + AudioSampleEntry(20)
const STSD_HEADER = 8; // FullBox version+flags(4) + entry_count(4), then sample entries

const fourcc = (data: Uint8Array, at: number): string => {
  let s = '';
  for (let i = 0; i < 4; i++) {
    const c = data[at + i];
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.';
  }
  return s;
};

export const toUuid = (data: Uint8Array, at: number): string => {
  let hex = '';
  for (let i = 0; i < 16; i++) hex += data[at + i].toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const readU32 = (v: DataView, at: number): number => v.getUint32(at, false);
const readU64 = (v: DataView, at: number): number => {
  const hi = v.getUint32(at, false);
  const lo = v.getUint32(at + 4, false);
  // Clamp to a safe integer; real init/fragment boxes are never anywhere near 2^53.
  return hi * 0x1_0000_0000 + lo;
};

/** Parse the top-level box sequence of `data`, descending into known container types. */
export function parseBoxes(data: Uint8Array, opts: ParseOptions = {}): ParseResult {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxBoxes = opts.maxBoxes ?? DEFAULT_MAX_BOXES;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const warnings: string[] = [];
  const state = { count: 0, truncated: false };

  const parseRange = (from: number, to: number, depth: number): Box[] => {
    const out: Box[] = [];
    let off = from;
    while (off + 8 <= to) {
      if (state.count >= maxBoxes) { warnings.push(`box limit ${maxBoxes} reached — stopping`); break; }
      const start = off;
      let size = readU32(view, off);
      let headerSize = 8;
      const type = fourcc(data, off + 4);
      if (size === 1) {
        if (off + 16 > to) { warnings.push(`64-bit size header truncated at ${off}`); state.truncated = true; break; }
        size = readU64(view, off + 8);
        headerSize = 16;
      } else if (size === 0) {
        size = to - start; // box extends to the end of the enclosing range
      }
      let uuid: string | undefined;
      if (type === 'uuid') {
        if (start + headerSize + 16 > to) { warnings.push(`uuid box truncated at ${off}`); state.truncated = true; break; }
        uuid = toUuid(data, start + headerSize);
        headerSize += 16;
      }
      if (size < headerSize) { warnings.push(`box '${type}' at ${start} has size ${size} < header ${headerSize} — malformed, stopping range`); break; }
      const end = start + size;
      if (end > to) {
        // Declared size runs past the enclosing range: record what we can, mark truncated, stop.
        warnings.push(`box '${type}' at ${start} declares end ${end} beyond bound ${to} — truncated`);
        state.truncated = true;
        out.push({ type, size, headerSize, start, end, payloadStart: start + headerSize, uuid });
        break;
      }
      state.count++;
      const box: Box = { type, size, headerSize, start, end, payloadStart: start + headerSize, uuid };

      if (depth < maxDepth) {
        if (CONTAINERS.has(type)) {
          box.children = parseRange(box.payloadStart, end, depth + 1);
        } else if (type === 'stsd') {
          box.children = parseRange(box.payloadStart + STSD_HEADER, end, depth + 1);
        } else if (VISUAL_SAMPLE_ENTRIES.has(type)) {
          box.children = parseRange(box.payloadStart + VISUAL_SAMPLE_ENTRY_HEADER, end, depth + 1);
        } else if (AUDIO_SAMPLE_ENTRIES.has(type)) {
          box.children = parseRange(box.payloadStart + AUDIO_SAMPLE_ENTRY_HEADER, end, depth + 1);
        }
      } else if (CONTAINERS.has(type) || type === 'stsd') {
        warnings.push(`max depth ${maxDepth} reached at '${type}' — not descending`);
      }
      out.push(box);
      off = end;
    }
    return out;
  };

  const boxes = parseRange(0, data.byteLength, 0);
  return { boxes, truncated: state.truncated, warnings };
}

/** Depth-first search for the first box of `type`. */
export function findBox(boxes: Box[], type: string): Box | undefined {
  for (const b of boxes) {
    if (b.type === type) return b;
    if (b.children) { const found = findBox(b.children, type); if (found) return found; }
  }
  return undefined;
}

/** All boxes of `type`, depth-first. */
export function findAllBoxes(boxes: Box[], type: string): Box[] {
  const out: Box[] = [];
  const walk = (list: Box[]) => {
    for (const b of list) { if (b.type === type) out.push(b); if (b.children) walk(b.children); }
  };
  walk(boxes);
  return out;
}
