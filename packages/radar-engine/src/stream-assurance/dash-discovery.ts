// DASH manifest-driven discovery. Given an MPD (which may be an ad-stitched wrapper whose BaseURL
// points the real media at a CDN origin), derive each representation's init-segment URL and a current
// media-fragment URL — so Stream Tests can be pointed at a manifest and figure out the objects to
// probe, instead of the operator hand-crafting URLs. Pure string parsing + URL resolution, no I/O.
import { extractDashManifest, type DashDrmSystem } from './dash.js';

export interface DiscoveredRepresentation {
  adaptationIndex: number;
  contentType: string | null; // 'video' | 'audio' | 'text' | …
  mimeType: string | null;
  lang: string | null;
  id: string;
  bandwidth: number | null;
  codecs: string | null;
  width: number | null;
  height: number | null;
  /** True for DASH trick-play renditions (id contains "mode=trik"). */
  trickPlay: boolean;
  /** Absolute init-segment URL (resolved against the manifest's BaseURL). */
  initUrl: string;
  /** Absolute URL of the latest media fragment from the SegmentTimeline, when derivable. */
  latestMediaUrl: string | null;
}

export interface DiscoveredManifest {
  manifestUrl: string;
  baseUrl: string;
  presentation: 'static' | 'dynamic' | null;
  drm: { defaultKid: string | null; systems: DashDrmSystem[] };
  representations: DiscoveredRepresentation[];
}

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? m[1] : null;
};
const numAttr = (tag: string, name: string): number | null => {
  const v = attr(tag, name);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Resolve the effective base URL: the manifest URL with each <BaseURL> applied in document order. */
function resolveBase(manifestUrl: string, baseUrls: string[]): string {
  try {
    return baseUrls.reduce((acc, b) => new URL(b, acc).href, manifestUrl);
  } catch {
    return manifestUrl;
  }
}

/** Start time of the LAST segment described by a SegmentTimeline (the live edge), in timescale units. */
export function latestSegmentTime(timelineXml: string): number | null {
  const entries = timelineXml.match(/<S\b[^>]*\/?>/gi) ?? [];
  let current = 0;
  let latestStart: number | null = null;
  for (const s of entries) {
    const t = attr(s, 't');
    const d = numAttr(s, 'd');
    const r = numAttr(s, 'r') ?? 0;
    if (t != null) current = Number(t);
    if (d == null) continue;
    latestStart = current + d * r; // r repeats after the first ⇒ last start is +d*r
    current = current + d * (r + 1);
  }
  return latestStart;
}

const substitute = (template: string, id: string, time: number | null): string => {
  let out = template.replace(/\$RepresentationID\$/g, id);
  if (time != null) out = out.replace(/\$Time\$/g, String(time));
  return out;
};

/** Parse an MPD and derive per-representation init + current-fragment URLs. */
export function discoverDashSegments(xml: string, manifestUrl: string): DiscoveredManifest {
  const mpdTag = xml.match(/<MPD\b[^>]*>/i)?.[0] ?? '';
  const presentationRaw = attr(mpdTag, 'type');
  const presentation = presentationRaw === 'dynamic' ? 'dynamic' : presentationRaw === 'static' ? 'static' : null;

  const baseUrls = [...xml.matchAll(/<BaseURL>([^<]*)<\/BaseURL>/gi)].map((m) => m[1].trim()).filter(Boolean);
  const base = resolveBase(manifestUrl, baseUrls);

  const representations: DiscoveredRepresentation[] = [];
  const blocks = xml.match(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/gi) ?? [];
  blocks.forEach((block, idx) => {
    const head = block.match(/<AdaptationSet\b[^>]*>/i)?.[0] ?? '';
    const mimeType = attr(head, 'mimeType');
    const contentType = attr(head, 'contentType') ?? (mimeType ? mimeType.split('/')[0] : null);
    const lang = attr(head, 'lang');
    const st = block.match(/<SegmentTemplate\b[^>]*>/i)?.[0] ?? '';
    const initT = attr(st, 'initialization');
    const mediaT = attr(st, 'media');
    const timeline = block.match(/<SegmentTimeline>[\s\S]*?<\/SegmentTimeline>/i)?.[0] ?? '';
    const latestTime = timeline ? latestSegmentTime(timeline) : null;

    for (const rt of block.match(/<Representation\b[^>]*?>/gi) ?? []) {
      const id = attr(rt, 'id');
      if (!id) continue;
      let initUrl = '';
      let latestMediaUrl: string | null = null;
      try {
        if (initT) initUrl = new URL(substitute(initT, id, null), base).href;
        if (mediaT && latestTime != null) latestMediaUrl = new URL(substitute(mediaT, id, latestTime), base).href;
      } catch { /* leave empty on malformed template */ }
      representations.push({
        adaptationIndex: idx, contentType, mimeType: attr(rt, 'mimeType') ?? mimeType, lang,
        id, bandwidth: numAttr(rt, 'bandwidth'), codecs: attr(rt, 'codecs'),
        width: numAttr(rt, 'width'), height: numAttr(rt, 'height'), trickPlay: /mode=trik/i.test(id),
        initUrl, latestMediaUrl,
      });
    }
  });

  return { manifestUrl, baseUrl: base, presentation, drm: extractDashManifest(xml).drm, representations };
}
