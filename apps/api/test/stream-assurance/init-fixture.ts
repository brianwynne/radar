// Minimal synthetic CMAF init-segment builder for the probe/observe integration tests. Fully
// fabricated — no real content, keys or tokens; just enough structure for the engine to read a KID.
const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const str = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const zeros = (n: number): number[] => new Array(n).fill(0);
const kidBytes = (uuid: string): number[] => (uuid.replace(/-/g, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));

function box(type: string, ...parts: number[][]): number[] {
  const payload = parts.flat();
  return [...u32(8 + payload.length), ...str(type), ...payload];
}
function fullbox(type: string, version: number, flags: number, ...parts: number[][]): number[] {
  return box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], parts.flat());
}

const WIDEVINE = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';

/** Build a minimal encrypted (audio) CMAF init segment carrying `kid`. */
export function buildInit(kid: string, scheme = 'cbcs'): Buffer {
  const ftyp = box('ftyp', str('iso6'), u32(0), str('isom'), str('iso6'), str('dash'), str('cmfc'));
  const tenc = fullbox('tenc', 0, 0, [0, 0, 1, 8], kidBytes(kid));
  const schm = fullbox('schm', 0, 0, str(scheme), u32(0x00010000));
  const frma = box('frma', str('mp4a'));
  const schi = box('schi', tenc);
  const sinf = box('sinf', frma, schm, schi);
  const enca = box('enca', zeros(28), sinf);
  const stsd = fullbox('stsd', 0, 0, u32(1), enca);
  const stbl = box('stbl', stsd);
  const minf = box('minf', stbl);
  const hdlr = fullbox('hdlr', 0, 0, u32(0), str('soun'), zeros(12), [0]);
  const mdhd = fullbox('mdhd', 0, 0, u32(0), u32(0), u32(48000), u32(0), [0x55, 0xc4, 0, 0]);
  const mdia = box('mdia', mdhd, hdlr, minf);
  const tkhd = fullbox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), zeros(8), zeros(8), zeros(36), u32(0), u32(0));
  const trak = box('trak', tkhd, mdia);
  const pssh = fullbox('pssh', 1, 0, kidBytes(WIDEVINE), u32(1), kidBytes(kid), u32(0));
  const moov = box('moov', trak, pssh);
  return Buffer.from([...ftyp, ...moov]);
}

/** Build a minimal CMAF media fragment (styp + moof + empty mdat) carrying a decode time + sequence. */
export function buildFragment(sequenceNumber: number, baseMediaDecodeTime: number, trackId = 1): Buffer {
  const styp = box('styp', str('cmfs'), u32(0), str('cmfs'));
  const mfhd = fullbox('mfhd', 0, 0, u32(sequenceNumber));
  const tfhd = fullbox('tfhd', 0, 0, u32(trackId));
  const tfdt = fullbox('tfdt', 0, 0, u32(baseMediaDecodeTime));
  const trun = fullbox('trun', 0, 0x000101, u32(2), u32(0), u32(1024), u32(1024));
  const traf = box('traf', tfhd, tfdt, trun);
  const moof = box('moof', mfhd, traf);
  const mdat = box('mdat', zeros(8));
  return Buffer.from([...styp, ...moof, ...mdat]);
}
