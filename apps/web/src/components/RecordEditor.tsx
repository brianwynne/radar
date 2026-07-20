// Read-only record editor. RADAR NEVER writes to NS1 — this lets an engineer edit a record's
// JSON locally and copy an NS1-ready payload to the clipboard, to paste into NS1 themselves.
// The manual precursor to a future ChangeProposal write-path (ADR-0002).
import { useMemo, useState } from 'react';

/** Strip RADAR/server-only fields so the payload pastes cleanly into NS1's record API:
 *  the identity echoes (id, zone, domain, type — carried by the record's URL) and RADAR's
 *  synthetic `_radar_note` marker, anywhere in the tree. Deep-clones; never mutates the input. */
export function cleanForNs1(record: unknown): unknown {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === '_radar_note') continue;
        out[k] = strip(val);
      }
      return out;
    }
    return v;
  };
  const cleaned = strip(record);
  if (cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned)) {
    for (const k of ['id', 'zone', 'domain', 'type']) delete (cleaned as Record<string, unknown>)[k];
  }
  return cleaned;
}

type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

export function RecordEditor({ initial, onClose }: { initial: unknown; onClose?: () => void }) {
  const initialText = useMemo(() => JSON.stringify(initial, null, 2), [initial]);
  const [text, setText] = useState(initialText);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const parsed: Parsed = useMemo(() => {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSON' };
    }
  }, [text]);
  const isObject = parsed.ok && parsed.value !== null && typeof parsed.value === 'object' && !Array.isArray(parsed.value);
  const dirty = text !== initialText;

  const copyForNs1 = async () => {
    if (!parsed.ok || !isObject) return;
    setCopyError(null);
    const cleaned = JSON.stringify(cleanForNs1(parsed.value), null, 2);
    try {
      await navigator.clipboard.writeText(cleaned);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopyError('Clipboard unavailable — select the text and copy manually.');
    }
  };

  return (
    <div className="record-editor">
      <div className="notice info">
        RADAR does <strong>not</strong> write to NS1. Edit here, click <strong>Copy for NS1</strong>, then paste into NS1 to save.
        The copied payload drops the identity fields (id/zone/domain/type) and RADAR markers — review it in NS1 before saving.
      </div>
      <textarea
        className="record-editor-text raw-json"
        aria-label="Record JSON editor"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={18}
      />
      <div className="record-editor-status">
        {parsed.ok ? (
          isObject ? (
            <span className="badge ok">valid JSON</span>
          ) : (
            <span className="badge warn">valid JSON, but not a record object</span>
          )
        ) : (
          <span className="badge danger" title={parsed.error}>invalid JSON</span>
        )}
        {dirty && <span className="muted">· edited</span>}
      </div>
      {copyError && <div className="notice danger">{copyError}</div>}
      <div className="record-editor-actions">
        <button className="primary" onClick={copyForNs1} disabled={!isObject}>
          {copied ? 'Copied for NS1 ✓' : 'Copy for NS1'}
        </button>
        <button className="ghost" onClick={() => setText(initialText)} disabled={!dirty}>Reset</button>
        {onClose && <button className="ghost" onClick={onClose}>Close</button>}
      </div>
    </div>
  );
}
