// DASH MPD extraction focused on the signals this stage needs: DRM/ContentProtection identity and
// manifest freshness. It is deliberately narrow (not yet a full ISO/IEC 23009-1 structural
// validator — that is a later stage) and dependency-free, using targeted scans rather than a DOM.
// A full XSD/structural validator will replace the internals behind this same interface.

export interface DashDrmSystem {
  systemId: string; // canonical UUID (lowercase), or the raw schemeIdUri when not a urn:uuid
  scheme: string | null; // ContentProtection@value (e.g. 'cenc', 'cbcs')
}

export interface DashManifestInfo {
  presentation: 'static' | 'dynamic' | null;
  publishTime: string | null;
  minimumUpdatePeriodSeconds: number | null;
  profiles: string[];
  drm: { defaultKid: string | null; systems: DashDrmSystem[] };
}

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? m[1] : null;
};

/** Parse an xs:duration (e.g. "PT6S", "PT1M30S") into seconds. */
export function parseIso8601Duration(d: string | null): number | null {
  if (!d) return null;
  const m = d.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/);
  if (!m) return null;
  const [, days, hours, mins, secs] = m;
  return (Number(days) || 0) * 86400 + (Number(hours) || 0) * 3600 + (Number(mins) || 0) * 60 + (Number(secs) || 0);
}

const normaliseSystemId = (schemeIdUri: string | null): string => {
  if (!schemeIdUri) return '';
  const u = schemeIdUri.trim();
  const m = u.match(/urn:uuid:([0-9a-fA-F-]{36})/);
  return m ? m[1].toLowerCase() : u.toLowerCase();
};

/** Extract DRM + freshness signalling from an MPD document. */
export function extractDashManifest(xml: string): DashManifestInfo {
  const mpdTag = xml.match(/<MPD\b[^>]*>/i)?.[0] ?? '';
  const presentationRaw = attr(mpdTag, 'type');
  const presentation = presentationRaw === 'dynamic' ? 'dynamic' : presentationRaw === 'static' ? 'static' : null;
  const profiles = (attr(mpdTag, 'profiles') ?? '').split(/[\s,]+/).filter(Boolean);

  const systems: DashDrmSystem[] = [];
  let defaultKid: string | null = null;
  const cpTags = xml.match(/<ContentProtection\b[^>]*>/gi) ?? [];
  for (const tag of cpTags) {
    const systemId = normaliseSystemId(attr(tag, 'schemeIdUri'));
    const scheme = attr(tag, 'value');
    const kid = attr(tag, 'default_KID'); // cenc:default_KID (namespace stripped by attr())
    if (kid && !defaultKid) defaultKid = kid.toLowerCase();
    // The mp4protection element carries default_KID; the per-system elements carry the DRM system IDs.
    if (systemId && systemId !== 'urn:mpeg:dash:mp4protection:2011') systems.push({ systemId, scheme });
  }

  return {
    presentation,
    publishTime: attr(mpdTag, 'publishTime'),
    minimumUpdatePeriodSeconds: parseIso8601Duration(attr(mpdTag, 'minimumUpdatePeriod')),
    profiles,
    drm: { defaultKid, systems },
  };
}
