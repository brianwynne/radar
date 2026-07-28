// HLS parsing + validation (RFC 8216, Apple HLS authoring, Low-Latency HLS). Parses master and media
// playlists and validates structure, timeline and encryption SIGNALLING. It never retrieves, stores
// or exposes an encryption key — only the EXT-X-KEY signalling (method, key format, IV presence) is
// read. Pure and dependency-free.

export interface HlsVariant {
  bandwidth: number | null;
  averageBandwidth: number | null;
  codecs: string[];
  resolution: { width: number; height: number } | null;
  frameRate: number | null;
  audioGroup: string | null;
  subtitlesGroup: string | null;
  uri: string;
}

export interface HlsRendition {
  type: string; // AUDIO | SUBTITLES | CLOSED-CAPTIONS | VIDEO
  groupId: string | null;
  name: string | null;
  language: string | null;
  isDefault: boolean;
  autoselect: boolean;
  uri: string | null;
}

export interface HlsMaster {
  isMaster: true;
  version: number | null;
  independentSegments: boolean;
  variants: HlsVariant[];
  renditions: HlsRendition[];
  warnings: string[];
}

export interface HlsKey {
  method: string; // NONE | AES-128 | SAMPLE-AES | SAMPLE-AES-CTR
  uri: string | null;
  keyFormat: string | null;
  keyFormatVersions: string | null;
  ivPresent: boolean;
}

export interface HlsSegment {
  duration: number;
  uri: string;
  discontinuity: boolean;
  programDateTime: string | null;
  gap: boolean;
}

export interface HlsMedia {
  isMaster: false;
  version: number | null;
  targetDuration: number | null;
  mediaSequence: number;
  discontinuitySequence: number;
  playlistType: string | null;
  endList: boolean;
  independentSegments: boolean;
  map: string | null; // EXT-X-MAP (CMAF init)
  keys: HlsKey[];
  segments: HlsSegment[];
  lowLatency: boolean; // any LL-HLS tag present
  partTargetDuration: number | null;
  warnings: string[];
}

export type HlsPlaylist = HlsMaster | HlsMedia;

/** Parse an HLS attribute list, respecting double-quoted values (commas inside quotes are literal). */
export function parseAttributes(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < input.length) {
    const eq = input.indexOf('=', i);
    if (eq < 0) break;
    const key = input.slice(i, eq).trim();
    let j = eq + 1;
    let value: string;
    if (input[j] === '"') {
      const end = input.indexOf('"', j + 1);
      value = input.slice(j + 1, end < 0 ? input.length : end);
      j = end < 0 ? input.length : end + 1;
    } else {
      let end = input.indexOf(',', j);
      if (end < 0) end = input.length;
      value = input.slice(j, end).trim();
      j = end;
    }
    if (key) out[key] = value;
    while (input[j] === ',' || input[j] === ' ') j++;
    i = j;
  }
  return out;
}

const num = (v: string | undefined): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export function isMasterPlaylist(text: string): boolean {
  return /^#EXT-X-STREAM-INF:/m.test(text);
}

export function parseMasterPlaylist(text: string): HlsMaster {
  const lines = text.split(/\r?\n/);
  const warnings: string[] = [];
  if (!lines[0]?.startsWith('#EXTM3U')) warnings.push('missing #EXTM3U on the first line');
  let version: number | null = null;
  let independentSegments = false;
  const variants: HlsVariant[] = [];
  const renditions: HlsRendition[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-VERSION:')) version = num(line.split(':')[1]);
    else if (line === '#EXT-X-INDEPENDENT-SEGMENTS') independentSegments = true;
    else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      renditions.push({ type: a.TYPE ?? 'UNKNOWN', groupId: a['GROUP-ID'] ?? null, name: a.NAME ?? null, language: a.LANGUAGE ?? null, isDefault: a.DEFAULT === 'YES', autoselect: a.AUTOSELECT === 'YES', uri: a.URI ?? null });
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      const res = a.RESOLUTION?.match(/(\d+)x(\d+)/);
      // The URI is the next non-comment line.
      let uri = '';
      for (let j = i + 1; j < lines.length; j++) { const t = lines[j].trim(); if (t && !t.startsWith('#')) { uri = t; break; } }
      variants.push({
        bandwidth: num(a.BANDWIDTH), averageBandwidth: num(a['AVERAGE-BANDWIDTH']),
        codecs: (a.CODECS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        resolution: res ? { width: Number(res[1]), height: Number(res[2]) } : null,
        frameRate: num(a['FRAME-RATE']), audioGroup: a.AUDIO ?? null, subtitlesGroup: a.SUBTITLES ?? null, uri,
      });
    }
  }
  return { isMaster: true, version, independentSegments, variants, renditions, warnings };
}

export function parseMediaPlaylist(text: string): HlsMedia {
  const lines = text.split(/\r?\n/);
  const warnings: string[] = [];
  if (!lines[0]?.startsWith('#EXTM3U')) warnings.push('missing #EXTM3U on the first line');
  const media: HlsMedia = {
    isMaster: false, version: null, targetDuration: null, mediaSequence: 0, discontinuitySequence: 0,
    playlistType: null, endList: false, independentSegments: false, map: null, keys: [], segments: [], lowLatency: false, partTargetDuration: null, warnings,
  };
  let pendingDuration: number | null = null;
  let pendingDiscontinuity = false;
  let pendingPdt: string | null = null;
  let pendingGap = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-VERSION:')) media.version = num(line.split(':')[1]);
    else if (line.startsWith('#EXT-X-TARGETDURATION:')) media.targetDuration = num(line.split(':')[1]);
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) media.mediaSequence = num(line.split(':')[1]) ?? 0;
    else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) media.discontinuitySequence = num(line.split(':')[1]) ?? 0;
    else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) media.playlistType = line.split(':')[1];
    else if (line === '#EXT-X-ENDLIST') media.endList = true;
    else if (line === '#EXT-X-INDEPENDENT-SEGMENTS') media.independentSegments = true;
    else if (line === '#EXT-X-DISCONTINUITY') pendingDiscontinuity = true;
    else if (line === '#EXT-X-GAP') pendingGap = true;
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pendingPdt = line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length);
    else if (line.startsWith('#EXT-X-MAP:')) { const a = parseAttributes(line.slice('#EXT-X-MAP:'.length)); media.map = a.URI ?? null; }
    else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      media.keys.push({ method: a.METHOD ?? 'UNKNOWN', uri: a.URI ?? null, keyFormat: a.KEYFORMAT ?? null, keyFormatVersions: a.KEYFORMATVERSIONS ?? null, ivPresent: !!a.IV });
    } else if (line.startsWith('#EXT-X-PART-INF:')) { media.lowLatency = true; media.partTargetDuration = num(parseAttributes(line.slice('#EXT-X-PART-INF:'.length))['PART-TARGET']); }
    else if (line.startsWith('#EXT-X-SERVER-CONTROL:') || line.startsWith('#EXT-X-PART:') || line.startsWith('#EXT-X-PRELOAD-HINT:') || line.startsWith('#EXT-X-RENDITION-REPORT:')) media.lowLatency = true;
    else if (line.startsWith('#EXTINF:')) pendingDuration = num(line.slice('#EXTINF:'.length).split(',')[0]);
    else if (!line.startsWith('#')) {
      media.segments.push({ duration: pendingDuration ?? 0, uri: line, discontinuity: pendingDiscontinuity, programDateTime: pendingPdt, gap: pendingGap });
      pendingDuration = null; pendingDiscontinuity = false; pendingPdt = null; pendingGap = false;
    }
  }
  return media;
}

export function parsePlaylist(text: string): HlsPlaylist {
  return isMasterPlaylist(text) ? parseMasterPlaylist(text) : parseMediaPlaylist(text);
}
