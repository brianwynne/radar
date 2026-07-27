// CENC / Common Encryption analysis (ISO/IEC 23001-7) over a parsed init segment. Extracts the
// protection SIGNALLING only — the default_KID (an identifier, safe to display), the protection
// scheme, IV size, PSSH system IDs and codec/track metadata. It NEVER reads, stores or exposes any
// encryption key or licence payload: the pssh `Data` blob is summarised by length only.
import { findBox, findAllBoxes, toUuid, type Box } from './isobmff.js';

// Well-known DRM system IDs (ISO/IEC 23001-7 registry) → friendly names, for display only.
const DRM_SYSTEMS: Record<string, string> = {
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'Widevine',
  '9a04f079-9840-4286-ab92-e65be0885f95': 'PlayReady',
  '94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'FairPlay',
  '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': 'W3C Common (cenc)',
};

export interface PsshInfo {
  systemId: string;
  systemName: string | null;
  version: number;
  kids: string[];
  dataSize: number; // length only — the pssh init data is never retained
}

export interface TrackInfo {
  trackId: number | null;
  handler: string | null; // 'vide' | 'soun' | …
  timescale: number | null;
  width: number | null;
  height: number | null;
  codec: string | null; // sample-entry 4cc, or the frma original format when encrypted
}

export interface CencInfo {
  isProtected: boolean;
  /** cenc scheme_type: 'cenc' | 'cbc1' | 'cens' | 'cbcs' (from schm), or null when clear. */
  scheme: string | null;
  defaultKid: string | null; // canonical UUID, or null
  perSampleIvSize: number | null;
  hasConstantIv: boolean;
}

export interface InitSegmentInfo {
  majorBrand: string | null;
  compatibleBrands: string[];
  tracks: TrackInfo[];
  cenc: CencInfo;
  pssh: PsshInfo[];
  warnings: string[];
}

const ascii = (data: Uint8Array, at: number, len: number): string => {
  let s = '';
  for (let i = 0; i < len; i++) { const c = data[at + i]; if (c === 0) break; s += String.fromCharCode(c); }
  return s;
};

const SAMPLE_ENTRY = /^(enc[va]|avc[13]|hev1|hvc[12]|av01|vp0[89]|mp4a|ac-[34]|ec-3|Opus|fLaC|dvh[e1])$/;

/** Extract CENC/DRM signalling + track metadata from a parsed init segment's boxes. */
export function analyseInitSegment(data: Uint8Array, boxes: Box[]): InitSegmentInfo {
  const warnings: string[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // ftyp
  let majorBrand: string | null = null;
  const compatibleBrands: string[] = [];
  const ftyp = findBox(boxes, 'ftyp');
  if (ftyp) {
    majorBrand = ascii(data, ftyp.payloadStart, 4);
    for (let off = ftyp.payloadStart + 8; off + 4 <= ftyp.end; off += 4) compatibleBrands.push(ascii(data, off, 4));
  }

  // Tracks
  const tracks: TrackInfo[] = [];
  for (const trak of findAllBoxes(boxes, 'trak')) {
    const info: TrackInfo = { trackId: null, handler: null, timescale: null, width: null, height: null, codec: null };
    const tkhd = trak.children && findBox(trak.children, 'tkhd');
    if (tkhd) {
      const version = data[tkhd.payloadStart];
      // track_id sits after version+flags(4) + (v1 ? 2×8 : 2×4) creation/mod times.
      const idOff = tkhd.payloadStart + 4 + (version === 1 ? 16 : 8);
      info.trackId = view.getUint32(idOff, false);
      // width/height are 16.16 fixed at the end of tkhd (last 8 bytes).
      if (tkhd.end - 8 >= tkhd.payloadStart) {
        info.width = view.getUint32(tkhd.end - 8, false) >>> 16;
        info.height = view.getUint32(tkhd.end - 4, false) >>> 16;
      }
    }
    const mdhd = trak.children && findBox(trak.children, 'mdhd');
    if (mdhd) {
      const version = data[mdhd.payloadStart];
      const tsOff = mdhd.payloadStart + 4 + (version === 1 ? 16 : 8);
      info.timescale = view.getUint32(tsOff, false);
    }
    const hdlr = trak.children && findBox(trak.children, 'hdlr');
    if (hdlr) info.handler = ascii(data, hdlr.payloadStart + 8, 4); // after version+flags(4)+pre_defined(4)
    const stsd = trak.children && findBox(trak.children, 'stsd');
    const entry = stsd?.children?.find((b) => SAMPLE_ENTRY.test(b.type));
    if (entry) {
      const frma = entry.children && findBox(entry.children, 'frma');
      info.codec = frma ? ascii(data, frma.payloadStart, 4) : entry.type; // original format when encrypted
    }
    tracks.push(info);
  }

  // CENC signalling: schm (scheme) + tenc (KID, IV size, protected)
  const cenc: CencInfo = { isProtected: false, scheme: null, defaultKid: null, perSampleIvSize: null, hasConstantIv: false };
  const schm = findBox(boxes, 'schm');
  if (schm) cenc.scheme = ascii(data, schm.payloadStart + 4, 4); // after version+flags(4)
  const tenc = findBox(boxes, 'tenc');
  if (tenc) {
    // FullBox(4) reserved(1) [crypt/skip or reserved](1) default_isProtected(1) default_Per_Sample_IV_Size(1) default_KID(16)
    const p = tenc.payloadStart;
    const isProtected = data[p + 6];
    const ivSize = data[p + 7];
    cenc.isProtected = isProtected === 1;
    cenc.perSampleIvSize = ivSize;
    cenc.defaultKid = toUuid(data, p + 8);
    cenc.hasConstantIv = isProtected === 1 && ivSize === 0;
  }
  if (cenc.scheme && !cenc.defaultKid) warnings.push('schm present without a readable tenc default_KID');

  // PSSH (system IDs + v1 KIDs; data length only)
  const pssh: PsshInfo[] = [];
  for (const box of findAllBoxes(boxes, 'pssh')) {
    const p = box.payloadStart;
    const version = data[p];
    const systemId = toUuid(data, p + 4);
    const kids: string[] = [];
    let cursor = p + 20;
    if (version > 0) {
      const kidCount = view.getUint32(cursor, false); cursor += 4;
      for (let i = 0; i < kidCount && cursor + 16 <= box.end; i++) { kids.push(toUuid(data, cursor)); cursor += 16; }
    }
    const dataSize = cursor + 4 <= box.end ? view.getUint32(cursor, false) : 0;
    pssh.push({ systemId, systemName: DRM_SYSTEMS[systemId] ?? null, version, kids, dataSize });
  }

  return { majorBrand, compatibleBrands, tracks, cenc, pssh, warnings };
}

export const drmSystemName = (systemId: string): string | null => DRM_SYSTEMS[systemId.toLowerCase()] ?? null;
