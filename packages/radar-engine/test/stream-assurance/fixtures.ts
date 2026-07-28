// Synthetic, fully-fabricated ISO-BMFF fixtures for the Stream Assurance engine tests. These contain
// NO real content, tokens, licence data or production URLs — only structurally-valid boxes and a
// made-up KID/UUID, so the parser and CENC/DRM logic can be exercised deterministically.

const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const str = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const zeros = (n: number): number[] => new Array(n).fill(0);

export const kidBytes = (uuid: string): number[] => (uuid.replace(/-/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));

function box(type: string, ...parts: number[][]): number[] {
  const payload = parts.flat();
  return [...u32(8 + payload.length), ...str(type), ...payload];
}
function fullbox(type: string, version: number, flags: number, ...parts: number[][]): number[] {
  return box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], parts.flat());
}

export const WIDEVINE = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';

export interface InitOpts {
  kid?: string;
  scheme?: string;      // 'cbcs' | 'cenc' | …
  protected?: boolean;
  systemId?: string;    // pssh system id
  handler?: string;     // 'soun' | 'vide'
  codec?: string;       // original format 4cc
  ivSize?: number;
}

/** Build a minimal but structurally-valid (audio) CMAF init segment. */
export function buildInitSegment(opts: InitOpts = {}): Uint8Array {
  const kid = opts.kid ?? '11111111-2222-3333-4444-555555555555';
  const scheme = opts.scheme ?? 'cbcs';
  const isProtected = opts.protected ?? true;
  const systemId = opts.systemId ?? WIDEVINE;
  const handler = opts.handler ?? 'soun';
  const codec = opts.codec ?? 'mp4a';
  const ivSize = opts.ivSize ?? 8;

  const ftyp = box('ftyp', str('iso6'), u32(0), str('isom'), str('iso6'), str('dash'), str('cmfc'));

  // Sample entry: encrypted ('enca' with sinf) or clear ('mp4a').
  let sampleEntry: number[];
  if (isProtected) {
    const tenc = fullbox('tenc', 0, 0, [0, 0, 1, ivSize], kidBytes(kid));
    const schm = fullbox('schm', 0, 0, str(scheme), u32(0x00010000));
    const frma = box('frma', str(codec));
    const schi = box('schi', tenc);
    const sinf = box('sinf', frma, schm, schi);
    sampleEntry = box('enca', zeros(28), sinf); // 28-byte AudioSampleEntry header then child boxes
  } else {
    sampleEntry = box('mp4a', zeros(28));
  }

  const stsd = fullbox('stsd', 0, 0, u32(1), sampleEntry);
  const stbl = box('stbl', stsd);
  const minf = box('minf', stbl);
  const hdlr = fullbox('hdlr', 0, 0, u32(0), str(handler), zeros(12), [0]);
  const mdhd = fullbox('mdhd', 0, 0, u32(0), u32(0), u32(48000), u32(0), [0x55, 0xc4, 0, 0]);
  const mdia = box('mdia', mdhd, hdlr, minf);
  const tkhd = fullbox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), zeros(8), zeros(8), zeros(36), u32(0), u32(0));
  const trak = box('trak', tkhd, mdia);

  const children = [trak];
  if (isProtected) {
    const pssh = fullbox('pssh', 1, 0, kidBytes(systemId), u32(1), kidBytes(kid), u32(0));
    children.push(pssh);
  }
  const moov = box('moov', ...children);
  return new Uint8Array([...ftyp, ...moov]);
}

export interface FragmentOpts {
  sequenceNumber?: number;
  baseMediaDecodeTime?: number;
  trackId?: number;
  sampleDurations?: number[]; // per-sample durations (trun); default two 1024-tick samples
  version1?: boolean;         // use a 64-bit tfdt
}

/** Build a minimal but structurally-valid CMAF media fragment (styp + moof[+ empty mdat]). */
export function buildMediaFragment(opts: FragmentOpts = {}): Uint8Array {
  const seq = opts.sequenceNumber ?? 1;
  const bmdt = opts.baseMediaDecodeTime ?? 0;
  const trackId = opts.trackId ?? 1;
  const durations = opts.sampleDurations ?? [1024, 1024];

  const styp = box('styp', str('cmfs'), u32(0), str('cmfs'));
  const mfhd = fullbox('mfhd', 0, 0, u32(seq));
  const tfhd = fullbox('tfhd', 0, 0, u32(trackId)); // no optional fields
  const tfdt = opts.version1
    ? fullbox('tfdt', 1, 0, u32(Math.floor(bmdt / 0x1_0000_0000)), u32(bmdt >>> 0))
    : fullbox('tfdt', 0, 0, u32(bmdt));
  // trun with sample-duration present (flag 0x000100) and data-offset (0x000001).
  const trun = fullbox('trun', 0, 0x000101, u32(durations.length), u32(0), ...durations.map((d) => u32(d)));
  const traf = box('traf', tfhd, tfdt, trun);
  const moof = box('moof', mfhd, traf);
  const mdat = box('mdat', zeros(8));
  return new Uint8Array([...styp, ...moof, ...mdat]);
}

/** A deliberately malformed segment: a box claiming a size far larger than the buffer. */
export function oversizedBox(): Uint8Array {
  return new Uint8Array([...u32(0x0fff_ffff), ...str('moov'), 0, 0, 0, 0]);
}

/** A deeply-nested chain of container boxes for depth-limit tests. */
export function deeplyNested(depth: number): Uint8Array {
  let inner: number[] = box('mdat', zeros(4));
  for (let i = 0; i < depth; i++) inner = box('moov', inner);
  return new Uint8Array(inner);
}
