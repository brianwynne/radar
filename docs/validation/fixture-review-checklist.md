# Sanitised fixture-candidate review checklist

A sanitised fixture candidate generated from live NS1 data is a **draft only**. It **must not be
committed** to source control until an operator completes this checklist and signs off. The
tooling redacts credential-like keys automatically, but automated redaction is **defence in
depth, not a substitute for human review** — key names vary and sensitive data can hide in
free-text/values.

## Per-candidate review

Candidate: `__________________________`  (endpoint / resource, checksum: `__________`)
Generated: `__________`  ·  Source mode: `live`  ·  Reviewer: `__________`  ·  Date: `__________`

Confirm **every** item before commit:

- [ ] **Credentials** — no API keys, bearer/basic tokens, passwords or secrets anywhere (keys
      *or* values, including inside free-text notes/labels). Redacted markers (`[REDACTED]`) are
      present where expected.
- [ ] **Internal addresses** — no private/internal IPs, hostnames, management URLs or origin
      addresses that should not be public. Replace with documentation-range placeholders (RFC
      5737 / RFC 3849) if the structure must be kept.
- [ ] **Account identifiers** — no NS1 account IDs, org IDs, billing identifiers or tenant
      references.
- [ ] **User names** — no real usernames, emails or personal identifiers (esp. in activity
      actor fields). Replace with role placeholders (e.g. `operator@example.invalid`).
- [ ] **API-key identifiers** — no API-key names/IDs (e.g. activity `api_key_name`/`api_key_id`),
      even non-secret ones — they reveal key inventory.
- [ ] **Sensitive metadata** — no feed names, monitor IDs, data-source IDs, internal notes, or
      capacity/topology detail that RTÉ considers sensitive.
- [ ] **Structural fidelity preserved** — answer order, filter-chain order, answer-group
      structure and unknown fields are intact (sanitisation only redacted values, never
      reordered or dropped structure).
- [ ] **Provenance stamped** — the candidate carries source/mode/endpoint/checksum/retrieval-time
      and the `reviewRequired` list; the checksum matches the validated payload.
- [ ] **`reviewRequired` cleared** — every entry the tool flagged (unexpected fields, unknown
      metadata, unsupported filters, feed-controlled metadata, answer groups, redacted fields)
      has been examined and dispositioned.
- [ ] **Marked synthetic** — the committed fixture carries the `_radar_note` SYNTHETIC marker and
      does not masquerade as production data.
- [ ] **Semantics not broadened** — any code change that accompanies the fixture interprets only
      fields the live payload **proves**; nothing was widened speculatively.

**Disposition:** ☐ Approved for commit  ☐ Rejected (reason: `__________________________`)

Reviewer signature / sign-off: `__________________________`

## Register linkage
- Record the outcome against the relevant discrepancy in
  [discrepancy-register.md](discrepancy-register.md) (fixture-update-required → done/rejected).
- Approved candidates are committed with a narrowly-scoped adapter change (if any) **and a
  regression test** that pins the confirmed field; rejected candidates are discarded (never
  committed) with the reason recorded.
