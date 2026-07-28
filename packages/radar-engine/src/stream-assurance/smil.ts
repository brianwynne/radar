// SMIL media-resolution parsing. thePlatform's media endpoint returns a SMIL document whose
// <video>/<ref> elements carry the resolved (signed) manifest URL, alongside ad <ref>s (VAST/VMAP ad
// tags) that must NOT be mistaken for the stream. This extracts the real DASH/HLS manifest URL and
// keeps ad tags separate. Pure string parsing — no I/O.

export interface SmilMedia {
  src: string;
  type: string | null; // e.g. 'application/dash+xml', 'application/vnd.apple.mpegurl'
  protocol: 'dash' | 'hls' | null;
  title: string | null;
  guid: string | null;
  security: string | null; // e.g. 'commonEncryption'
}

export interface SmilResult {
  media: SmilMedia[]; // content manifests only (ad tags excluded)
  /** Best DASH manifest URL (first content <video>/<ref> that resolves to DASH), or null. */
  dashManifestUrl: string | null;
  /** Best HLS manifest URL, or null. */
  hlsManifestUrl: string | null;
  /** Ad-tag URLs seen in the SMIL (doubleclick/VMAP), for visibility only. */
  adTags: string[];
}

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? m[1] : null;
};

const decodeEntities = (s: string): string =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&#0*38;/g, '&');

/** Does a URL's PATH (ignoring the query) look like a streaming manifest? */
const manifestProtocol = (src: string, type: string | null): 'dash' | 'hls' | null => {
  const t = (type ?? '').toLowerCase();
  if (t.includes('dash')) return 'dash';
  if (t.includes('mpegurl') || t.includes('x-mpegurl')) return 'hls';
  const path = src.split('?')[0].toLowerCase();
  if (path.endsWith('.mpd') || path.includes('.isml/.mpd')) return 'dash';
  if (path.endsWith('.m3u8') || path.includes('.isml/.m3u8')) return 'hls';
  return null;
};

/** Parse a SMIL document into its content manifest URLs (+ ad tags kept separate). */
export function parseSmil(xml: string): SmilResult {
  const bySrc = new Map<string, SmilMedia>();
  const adTags: string[] = [];

  for (const tag of xml.match(/<(?:video|ref)\b[^>]*?>/gi) ?? []) {
    const rawSrc = attr(tag, 'src');
    if (!rawSrc) continue;
    const src = decodeEntities(rawSrc);
    const type = attr(tag, 'type');
    const protocol = manifestProtocol(src, type);

    if (!protocol) {
      // Not a manifest → an ad tag / tracking ref (e.g. pubads.g.doubleclick.net, tags="preroll").
      adTags.push(src);
      continue;
    }
    // <video> and its sibling <ref> repeat the same URL; merge so the richer element's metadata wins.
    const prev = bySrc.get(src);
    bySrc.set(src, {
      src, protocol,
      type: type ?? prev?.type ?? null,
      title: attr(tag, 'title') ?? prev?.title ?? null,
      guid: attr(tag, 'guid') ?? prev?.guid ?? null,
      security: attr(tag, 'security') ?? prev?.security ?? null,
    });
  }
  const media = [...bySrc.values()];

  return {
    media,
    dashManifestUrl: media.find((m) => m.protocol === 'dash')?.src ?? null,
    hlsManifestUrl: media.find((m) => m.protocol === 'hls')?.src ?? null,
    adTags,
  };
}
