// CMAF/DASH media-fragment timeline extraction (ISO/IEC 14496-12 movie fragments). Reads the moof
// timeline signalling — the fragment sequence number (mfhd), the decode time (tfdt
// baseMediaDecodeTime) and the sample count / total duration (trun, with tfhd defaults) — so the same
// fragment fetched through several CDNs can be checked for timeline drift, and consecutive fragments
// for gaps/overlaps. Bounded and defensive like the init reader; no keys, no media samples retained.
import { findBox, type Box } from './isobmff.js';

export interface FragmentInfo {
  /** movie-fragment sequence number (mfhd), or null. */
  sequenceNumber: number | null;
  /** track_ID from tfhd, or null. */
  trackId: number | null;
  /** baseMediaDecodeTime (tfdt) in the track timescale, or null. */
  baseMediaDecodeTime: number | null;
  /** trun sample_count, or null. */
  sampleCount: number | null;
  /** Sum of sample durations in the track timescale when derivable (trun per-sample or tfhd default), else null. */
  totalDuration: number | null;
  warnings: string[];
}

const readU32 = (v: DataView, at: number): number => v.getUint32(at, false);
const readU64 = (v: DataView, at: number): number => v.getUint32(at, false) * 0x1_0000_0000 + v.getUint32(at + 4, false);

/** Extract the movie-fragment timeline signalling from a parsed media fragment's boxes. */
export function analyseMediaFragment(data: Uint8Array, boxes: Box[]): FragmentInfo {
  const warnings: string[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const info: FragmentInfo = { sequenceNumber: null, trackId: null, baseMediaDecodeTime: null, sampleCount: null, totalDuration: null, warnings };

  const moof = findBox(boxes, 'moof');
  if (!moof) { warnings.push('no moof box — not a media fragment'); return info; }

  const mfhd = findBox(moof.children ?? [], 'mfhd');
  if (mfhd && mfhd.payloadStart + 8 <= mfhd.end) info.sequenceNumber = readU32(view, mfhd.payloadStart + 4);

  const traf = findBox(moof.children ?? [], 'traf');
  if (!traf) { warnings.push('moof without traf'); return info; }

  // tfhd: version/flags(4) + track_ID(4) + optional fields; we want default_sample_duration (0x08).
  let defaultSampleDuration: number | null = null;
  const tfhd = findBox(traf.children ?? [], 'tfhd');
  if (tfhd && tfhd.payloadStart + 8 <= tfhd.end) {
    const flags = readU32(view, tfhd.payloadStart) & 0x00ffffff;
    info.trackId = readU32(view, tfhd.payloadStart + 4);
    let off = tfhd.payloadStart + 8;
    if (flags & 0x000001) off += 8; // base_data_offset
    if (flags & 0x000002) off += 4; // sample_description_index
    if (flags & 0x000008) { if (off + 4 <= tfhd.end) defaultSampleDuration = readU32(view, off); off += 4; }
  }

  // tfdt: version 0 → u32, version 1 → u64 baseMediaDecodeTime.
  const tfdt = findBox(traf.children ?? [], 'tfdt');
  if (tfdt && tfdt.payloadStart + 4 <= tfdt.end) {
    const version = view.getUint8(tfdt.payloadStart);
    if (version === 1 && tfdt.payloadStart + 12 <= tfdt.end) info.baseMediaDecodeTime = readU64(view, tfdt.payloadStart + 4);
    else if (tfdt.payloadStart + 8 <= tfdt.end) info.baseMediaDecodeTime = readU32(view, tfdt.payloadStart + 4);
  }

  // trun: version/flags(4) + sample_count(4) + optional data_offset/first_sample_flags + per-sample records.
  const trun = findBox(traf.children ?? [], 'trun');
  if (trun && trun.payloadStart + 8 <= trun.end) {
    const flags = readU32(view, trun.payloadStart) & 0x00ffffff;
    const sampleCount = readU32(view, trun.payloadStart + 4);
    info.sampleCount = sampleCount;
    let off = trun.payloadStart + 8;
    if (flags & 0x000001) off += 4; // data_offset (i32)
    if (flags & 0x000004) off += 4; // first_sample_flags
    const hasDur = !!(flags & 0x000100);
    const rec = (hasDur ? 4 : 0) + ((flags & 0x000200) ? 4 : 0) + ((flags & 0x000400) ? 4 : 0) + ((flags & 0x000800) ? 4 : 0);
    if (hasDur && rec > 0) {
      let sum = 0; let read = 0;
      for (let i = 0; i < sampleCount && off + 4 <= trun.end; i++, off += rec) { sum += readU32(view, off); read++; }
      if (read < sampleCount) warnings.push(`trun truncated: read ${read}/${sampleCount} sample durations`);
      info.totalDuration = read > 0 ? sum : null;
    } else if (defaultSampleDuration != null) {
      info.totalDuration = defaultSampleDuration * sampleCount;
    }
  }

  return info;
}
