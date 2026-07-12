# RADAR NS1 Developer Guide
## IBM NS1 Connect reference for the RADAR read-only implementation

**Status:** Version 1.0  
**Purpose:** A stable, project-local reference for Claude or another coding agent building RADAR without scraping IBM's JavaScript-rendered API catalog.  
**Authoritative sources:** IBM NS1 Connect product documentation and IBM API Hub.  
**Important:** This guide separates **verified behaviour** from **implementation assumptions**. Where an exact API response schema could not be extracted from the JavaScript API catalog, RADAR must capture a real read-only response or use a checked-in fixture before finalising types.

---

## 1. Scope

This guide covers the IBM NS1 Connect functionality required by the first read-only RADAR release:

- API authentication and base URL
- zones and records
- complete zone/record retrieval
- answers and answer metadata
- Filter Chain semantics
- ECS behaviour
- Netfence ASN and Prefix
- geographic filters
- Up
- Weighted Shuffle
- Select First N
- answer groups
- monitors, data sources and feeds
- activity log
- safe snapshotting
- TypeScript integration patterns
- fixture and contract-test strategy

This guide does **not** authorise or specify NS1 writes for RADAR Version 1.

---

## 2. Non-negotiable RADAR rules

1. **NS1 remains authoritative.**
2. **RADAR Version 1 is read-only.**
3. **The NS1 client must implement GET only.**
4. **No generic proxy route may accept an arbitrary NS1 path.**
5. **The complete raw NS1 object must be preserved.**
6. **Unknown fields must not be discarded.**
7. **Filter order must be preserved exactly.**
8. **Unsupported filters must stop RADAR from claiming complete evaluation.**
9. **Weighted Shuffle is probabilistic, not a guaranteed traffic percentage.**
10. **NS1 selects the delivery-platform answer; Cloudflare later selects the Réalta pool.**

---

## 3. Verified API fundamentals

### 3.1 Base URLs

Legacy API:

```text
https://api.nsone.net/v1
```

Newer category APIs may use:

```text
https://api.nsone.net/{category}/v1
```

RADAR Version 1 should use only endpoints required for read-only DNS and account inspection.

### 3.2 Authentication

Every request must use HTTPS and include:

```http
X-NSONE-Key: <NS1_API_KEY_SECRET>
```

The key used by RADAR must be separately created for RADAR and granted only the minimum view permissions.

### 3.3 HTTP methods

IBM documents the legacy convention as:

- `GET` — retrieve
- `PUT` — create
- `POST` — update
- `DELETE` — delete

RADAR Version 1 must reject any attempt to use the latter three methods against NS1.

### 3.4 Suggested common headers

```http
Accept: application/json
X-NSONE-Key: <secret>
User-Agent: radar/<version>
X-Correlation-ID: <uuid>
```

Do not log the API key.

---

## 4. Verified read-only endpoints

The following endpoints are verified by IBM documentation or stable NS1 API usage.

### 4.1 List zones

```http
GET /v1/zones
```

Purpose:

- enumerate zones visible to the API key
- populate the NS1 Explorer
- allow selection of the relevant RTÉ zone

### 4.2 Get complete zone configuration

```http
GET /v1/zones/{zoneFQDN}
```

IBM states that this returns all zone and record information as one JSON object and can serve as a complete JSON backup of the zone and its records.

Use this for:

- raw zone snapshots
- record inventory
- preserving Filter Chain and metadata information that BIND exports omit

### 4.3 Get a specific record

Common legacy endpoint form:

```http
GET /v1/zones/{zone}/{domain}/{type}
```

Example:

```http
GET /v1/zones/rte.ie/live.rte.ie/A
```

The exact record type used by RTÉ must come from live configuration, not assumptions.

### 4.4 Activity log

```http
GET /v1/account/activity
```

Requires the relevant “View activity log” permission.

IBM states that the activity log includes changes made through both the portal and API and identifies the user or API key.

### 4.5 BIND-compatible zone export

A BIND export is not sufficient for RADAR because IBM states that zone-file exports omit Filter Chain configuration.

For reference only:

```http
PUT /v1/export/zonefile/{zone}
GET /v1/export/zonefile/{zone}/status
GET /v1/export/zonefile/{zone}
```

RADAR should use complete JSON zone retrieval instead.

---

## 5. Endpoints requiring fixture-led confirmation

The IBM API Hub is JavaScript-rendered and may not be available to coding agents. Do not invent these paths or schemas.

The following capabilities should be represented behind interfaces, but the exact endpoints must be confirmed by one of:

1. a downloaded IBM OpenAPI specification;
2. a captured read-only API response;
3. IBM support documentation;
4. a manual API Hub export;
5. checked-in fixtures supplied by RTÉ.

Capabilities:

- list/get monitoring jobs
- list/get data sources
- list/get feeds
- list/get notifier lists
- list filter metadata definitions
- detailed account permissions

Create interfaces first:

```ts
export interface Ns1ReadClient {
  listZones(): Promise<unknown>;
  getZone(zone: string): Promise<unknown>;
  getRecord(zone: string, domain: string, type: string): Promise<unknown>;
  getActivity?(query?: ActivityQuery): Promise<unknown>;
  listMonitors?(): Promise<unknown>;
  listDataSources?(): Promise<unknown>;
  listFeeds?(sourceId?: string): Promise<unknown>;
}
```

Optional methods must remain disabled until their endpoint and response contract are verified.

---

## 6. Raw object preservation

RADAR must store both the raw and interpreted forms.

```ts
export interface Ns1ResourceSnapshot {
  id: string;
  resourceKind: "zone" | "record" | "activity" | "monitor" | "source" | "feed";
  resourceKey: string;
  retrievedAt: string;
  sourceEndpoint: string;
  raw: unknown;
  canonical: unknown;
  checksum: string;
}
```

### 6.1 Why `unknown` is intentional

Do not immediately cast the entire payload to a narrow interface. First:

1. validate only the fields required for the current screen;
2. preserve the full raw payload;
3. record unrecognised fields;
4. add fixtures before broadening the typed model.

### 6.2 Canonicalisation

Canonical JSON should:

- sort object keys recursively;
- preserve array order where order is meaningful;
- preserve Filter Chain order;
- preserve answer order;
- optionally remove known volatile runtime fields only for a separate structural checksum;
- never alter the raw snapshot.

Maintain two checksums if needed:

```text
raw_checksum
structural_checksum
```

---

## 7. Record model for RADAR

The exact NS1 JSON shape must be inferred from real fixtures. RADAR’s internal model should remain independent of the wire shape.

```ts
export interface RadarDnsRecord {
  zone: string;
  domain: string;
  type: string;
  ttl?: number;
  answers: RadarAnswer[];
  filterChain: RadarFilterStep[];
  useEcs?: boolean;
  raw: unknown;
}
```

```ts
export interface RadarAnswer {
  id: string;
  value: unknown;
  label?: string;
  deliveryPlatform?: "realta" | "fastly" | "akamai" | "cloudfront" | "unknown";
  metadata: Record<string, RadarMetadataValue>;
  answerGroup?: string;
  raw: unknown;
}
```

```ts
export interface RadarMetadataValue {
  field: string;
  value: unknown;
  source: "static" | "feed" | "monitor" | "unknown";
  sourceReference?: string;
  raw: unknown;
}
```

Do not assume a stable answer ID exists in the NS1 payload. If not, generate a deterministic RADAR ID from answer value, group and position, while retaining the original index.

---

## 8. Filter Chain fundamentals

IBM describes the Filter Chain as an ordered list of filters. Each filter processes the current answer list and either:

- **sorts/rearranges** answers;
- **sifts/eliminates** answers;
- in some cases operates in either mode;
- or modifies the response without steering.

The output of one filter becomes the input to the next.

RADAR must never reorder filters for display or evaluation.

### 8.1 Trace contract

```ts
export interface FilterTrace {
  index: number;
  filterId: string;
  filterType: string;
  behaviour: "eliminate" | "reorder" | "select" | "group" | "modify" | "unknown";
  inputAnswerIds: string[];
  outputAnswerIds: string[];
  removedAnswerIds: string[];
  orderingBefore: string[];
  orderingAfter: string[];
  metadataRead: MetadataRead[];
  explanation: string;
  complete: boolean;
  warnings: string[];
}
```

Every answer must be accounted for after every step.

---

## 9. ECS and request identity

### 9.1 What NS1 receives

For traffic-steering purposes, RADAR should model:

- resolver source IP;
- query name;
- query type;
- whether EDNS is present;
- whether ECS is present;
- ECS subnet and prefix length where present.

### 9.2 Address selection

If ECS is enabled on the NS1 record and the resolver sends ECS, relevant filters use the client subnet supplied through ECS.

If ECS is disabled on the record, IBM states that filters use the resolver IP even when the resolver sends ECS.

RADAR must show:

```text
identity_source = ecs | resolver_ip
```

### 9.3 Filters documented as using ECS

IBM lists:

- Geofence Country
- Geofence Regional
- Geotarget Country
- Geotarget Latlong
- Geotarget Regional
- Netfence ASN
- Netfence Prefix
- Weighted Sticky Shuffle
- Pulsar Availability Sort
- Pulsar Availability Threshold
- Pulsar Performance Sort
- Pulsar Performance Stabilize

### 9.4 Confidence

RADAR should label identity confidence:

- **High** — ECS present and enabled; country/ASN derived from client subnet
- **Medium** — ISP recursive resolver likely colocated with client network
- **Low** — public/corporate resolver with no ECS
- **Unknown** — insufficient information

This is a RADAR explanation feature, not an NS1 field.

---

## 10. Up filter

### Verified behaviour

The Up filter references answer `up` metadata and eliminates answers marked down/unavailable.

Monitoring jobs or external feeds can automatically update this metadata.

### RADAR evaluation

```ts
function evaluateUp(
  answers: RadarAnswer[]
): FilterResult {
  // Exact handling of missing metadata must be verified from fixture/config.
  // Never silently assume missing = true without documenting the assumption.
}
```

RADAR should distinguish:

- explicitly `up`
- explicitly `down`
- missing
- feed-controlled but unresolved
- overridden in simulation

If missing-value behaviour is not confirmed, mark evaluation partial rather than guessing.

---

## 11. Netfence ASN

### Verified behaviour

Netfence ASN maps requesters to answers using ASN metadata.

IBM states:

- answers whose ASN metadata does not match the requester ASN are eliminated;
- answers with no ASN metadata can remain;
- an option exists to remove answers without ASN metadata when at least one answer matches;
- if no ASN answer matches, untagged answers remain eligible;
- fencing must not be treated as a security control because NS1 tries to return at least one answer.

### RADAR algorithm

Inputs:

- requester ASN
- answer ASN metadata
- option equivalent to “remove untagged answers on match”

Pseudo-logic:

```text
matching_tagged = answers whose ASN metadata contains requester ASN
untagged = answers with no ASN metadata

if matching_tagged is not empty:
    retain matching_tagged
    if remove_untagged_on_match is false:
        retain untagged
else:
    retain untagged
```

The exact option name in wire JSON must be read from a fixture.

RADAR must display:

- requester ASN;
- matching answers;
- untagged/default answers;
- whether untagged answers were removed;
- final eligible set.

---

## 12. Netfence Prefix

### Verified behaviour

Netfence Prefix maps requesters using answer IP-prefix-list metadata.

IBM states:

- an answer matches when the requester IP falls within an attached prefix;
- answers without prefix metadata can remain;
- an option can remove untagged answers when at least one prefix matches;
- if no prefix matches, untagged answers remain eligible;
- up to 1000 prefixes can be attached to one answer.

### RADAR algorithm

Use a standards-compliant IPv4/IPv6 CIDR library.

Pseudo-logic:

```text
matching_tagged = answers containing a prefix that covers requester address
untagged = answers without prefix metadata

if matching_tagged is not empty:
    retain matching_tagged
    optionally retain/remove untagged according to filter setting
else:
    retain untagged
```

Prefix rules must use the address selected by ECS/resolver logic.

---

## 13. Geographic filters

### Geofence

Geofence filters eliminate answers that do not match geographic criteria.

Verified examples include:

- Geofence Country
- Geofence Regional

### Geotarget

Geotarget filters reorder answers based on geographic proximity.

Verified examples include:

- Geotarget Country
- Geotarget Regional
- Geotarget Latlong

### RADAR implementation strategy

Do not implement exact geodesic or NS1 database behaviour from intuition.

For Version 1:

- fully evaluate only filters whose necessary metadata and semantics are available in fixtures;
- otherwise show the configuration and mark evaluation partial;
- clearly state whether resolver IP or ECS was used.

Geofence and Geotarget must not be conflated.

---

## 14. Weighted Shuffle

### Verified behaviour

Weighted Shuffle randomises answer order while prioritising answers with higher weight values. IBM states that placement at the top is proportional to relative weight.

With `Select First N = 1` later in the chain, the probability of being returned first is based on relative weight among the eligible answers.

Example:

```text
Réalta 70
Fastly 20
Akamai 10
```

Theoretical top-answer probabilities:

```text
Réalta 70%
Fastly 20%
Akamai 10%
```

provided:

- all three answers enter Weighted Shuffle;
- no grouping or other later filter changes the candidate set;
- all weight semantics are standard;
- Select First N returns one answer.

### Important limitation

This is not guaranteed viewer traffic share because of:

- recursive resolver caching;
- TTL;
- ECS scope;
- request volume by resolver/subnet;
- session duration;
- HTTP retries;
- downstream CDN/load-balancer behaviour.

### Seeded simulation

For repeatable demos/tests:

```ts
export interface WeightedShuffleOptions {
  seed?: string;
}
```

Production explanation should show expected probability, not claim the specific random ordering that NS1 used for a historical request unless DNS query-level evidence exists.

---

## 15. Select First N

### Verified behaviour

Select First N eliminates all but the first N answers.

IBM states:

- default N is typically 1;
- it is commonly placed at the end of a Filter Chain;
- when N=1 only the first remaining answer is returned.

RADAR must read N from configuration rather than assume 1.

If the exact JSON configuration field is not yet known, fixture the record before implementing.

---

## 16. Answer groups

IBM supports answer groups, and filters can operate on groups.

Verified example chain:

```text
Geotarget Regional
→ Select First Group
→ Weighted Shuffle
→ Select First N
```

The example behaviour:

1. reorder all answers/groups geographically;
2. retain only answers in the first group;
3. weighted-shuffle answers within that group;
4. return first N.

RADAR should model groups explicitly:

```ts
export interface RadarAnswerGroup {
  id: string;
  name?: string;
  metadata: Record<string, RadarMetadataValue>;
  answerIds: string[];
  raw: unknown;
}
```

Do not flatten groups and lose group identity.

---

## 17. Priority, Cost, Shed Load and Pulsar

These filters exist in IBM NS1 Connect but should be implemented only if they appear in RTÉ fixtures.

### Priority

May sort or sift according to configuration.

### Cost

Steers toward lower-cost answers. RTÉ has explicitly stated cost is not an optimisation factor, but RADAR must still accurately display the filter if it exists.

### Shed Load

Uses a selected load metric and low/high watermarks to steer traffic away from overloaded endpoints.

### Pulsar filters

Use RUM performance or availability data.

Version 1 rule:

> Display unknown/unsupported filters, preserve raw configuration, and mark all evaluation after that step as partial.

---

## 18. Monitoring jobs, data sources and feeds

IBM distinguishes:

### Monitoring job

A synthetic check such as:

- PING
- TCP
- HTTP/S
- DNS

### Data source

The origin of data, such as:

- NS1 monitoring
- third-party monitoring
- custom NS1 API integration
- Pulsar

### Data feed

Connects an individual monitored metric/job to answer metadata.

A change in a monitor or external source can be pushed through a feed to update answer metadata such as `up`.

### RADAR display requirements

For every metadata field, show:

```text
value
ownership/source
source ID
feed ID
monitor/job ID
last known update, if available
```

Classification:

- static/manual
- monitor-controlled
- third-party-feed-controlled
- Pulsar-controlled
- unknown

Do not allow the UI to imply that a feed-controlled value is ordinary static configuration.

---

## 19. Activity log

Use:

```http
GET /v1/account/activity
```

RADAR should correlate account activity with stored snapshots.

Display:

- timestamp
- actor/user/API key
- activity type
- object/resource
- detail where supplied

The activity log is read-only and cannot be modified.

---

## 20. Error handling

### 20.1 Common categories

RADAR should normalise upstream failures into:

- authentication/permission failure
- not found
- rate limited
- upstream timeout
- invalid NS1 response
- unsupported payload version/shape
- temporary upstream failure

### 20.2 Do not expose upstream secrets

Safe error example:

```json
{
  "code": "NS1_UPSTREAM_UNAVAILABLE",
  "message": "Unable to retrieve the NS1 record.",
  "correlationId": "..."
}
```

Do not return raw request headers.

### 20.3 Timeouts and retry

Use short explicit timeouts.

Retry only safe idempotent GET requests and only for transient failures. Use bounded exponential backoff with jitter.

Do not retry authentication or validation errors.

---

## 21. Rate limiting and caching

IBM applies account-level API rate limits.

RADAR should:

- fetch a complete record once per screen load;
- avoid a separate upstream call for every panel;
- use a short in-memory cache;
- store explicit snapshots in PostgreSQL;
- show data freshness;
- never treat cache as authoritative.

Suggested configuration:

```text
NS1_CACHE_TTL_SECONDS=30
NS1_REQUEST_TIMEOUT_MS=5000
NS1_MAX_RETRIES=2
```

These are initial defaults, not IBM-mandated values.

---

## 22. Security requirements for the NS1 client

1. API key only in `radar-api`.
2. Load from `/run/secrets/ns1_api_key` first.
3. Allow environment variable only for development.
4. Never expose a generic proxy.
5. Validate zone/domain/type.
6. Keep an allow-list for production zones if appropriate.
7. Use HTTPS only.
8. Redact `X-NSONE-Key` from logs.
9. Use a dedicated read-only NS1 key.
10. Record correlation IDs and upstream latency.

---

## 23. Suggested TypeScript client

```ts
export class IbmNs1ReadClient implements Ns1ReadClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number
  ) {}

  async listZones(): Promise<unknown> {
    return this.getJson("/zones");
  }

  async getZone(zone: string): Promise<unknown> {
    return this.getJson(`/zones/${encodeURIComponent(zone)}`);
  }

  async getRecord(
    zone: string,
    domain: string,
    type: string
  ): Promise<unknown> {
    return this.getJson(
      `/zones/${encodeURIComponent(zone)}/${encodeURIComponent(domain)}/${encodeURIComponent(type)}`
    );
  }

  async getActivity(): Promise<unknown> {
    return this.getJson("/account/activity");
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-NSONE-Key": this.apiKey,
        "User-Agent": "radar/1.0"
      },
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    if (!response.ok) {
      throw await Ns1Error.fromResponse(response);
    }

    return response.json();
  }
}
```

Base URL configuration:

```text
NS1_BASE_URL=https://api.nsone.net/v1
```

No method accepting an arbitrary user-supplied URL may exist.

---

## 24. Wire-schema validation strategy

Use Zod or an equivalent runtime validator.

### 24.1 Minimal outer schema

Validate only known required fields and allow passthrough.

```ts
const Ns1RecordEnvelopeSchema = z.object({
  domain: z.string().optional(),
  type: z.string().optional(),
  ttl: z.number().optional(),
  answers: z.array(z.unknown()).optional(),
  filters: z.array(z.unknown()).optional()
}).passthrough();
```

Field names in this example are provisional until confirmed from a real fixture.

### 24.2 Contract fixtures

Store sanitised fixtures:

```text
fixtures/ns1/
  zones-list.json
  zone-rte-ie.json
  record-live-rte-ie.json
  record-answer-groups.json
  record-ecs-enabled.json
  activity.json
```

Every fixture must record:

```text
captured_from_endpoint
captured_at
sanitised_fields
api_version/base_url
```

---

## 25. Evaluation result model

```ts
export interface EvaluationRequest {
  recordSnapshotId: string;
  resolverIp: string;
  ecs?: {
    present: boolean;
    subnet?: string;
  };
  qname: string;
  qtype: string;
  overrides?: {
    country?: string;
    asn?: number;
    clientIp?: string;
    answerHealth?: Record<string, boolean>;
  };
}
```

```ts
export interface EvaluationResult {
  identity: {
    source: "ecs" | "resolver";
    evaluatedAddress: string;
    country?: string;
    asn?: number;
    prefix?: string;
    confidence: "high" | "medium" | "low" | "unknown";
  };
  traces: FilterTrace[];
  eligibleAnswerIds: string[];
  expectedDistribution?: Record<string, number>;
  complete: boolean;
  stoppedAtFilterIndex?: number;
  warnings: string[];
  explanation: string;
}
```

---

## 26. Required UI disclosures

Every detailed evaluation page must show:

### Received

- resolver IP
- QNAME
- QTYPE
- ECS present/absent
- ECS subnet where supplied

### Derived

- identity source
- country
- ASN
- matched prefix
- confidence

### Configured

- answers
- metadata
- filter order
- groups
- weights
- N
- ECS enabled/disabled

### Result

- answer set after each filter
- expected distribution
- complete/partial status
- unsupported filters
- next component after DNS

### Disclaimer

```text
Configured DNS-answer probability is not identical to delivered viewer traffic share.
Resolver caching, ECS scope, TTL, player behaviour and downstream load balancing may alter observed traffic.
```

---

## 27. RTÉ-specific delivery mapping

RADAR-owned mappings should associate NS1 answers with delivery platforms.

Example only:

```json
{
  "answer_match": "live-realta.example",
  "delivery_platform": "realta",
  "next_component": "cloudflare_load_balancer"
}
```

Topology after NS1:

```text
NS1 answer = Réalta
→ Cloudflare load balancer
→ Réalta Varnish pool
→ cache node
```

RADAR must not infer that NS1 selected a particular Varnish pool unless that pool is directly represented as an NS1 answer.

PNI, INEX and transit associations are RADAR topology context and must be explicitly labelled as:

- manually maintained;
- imported;
- observed;
- simulated.

---

## 28. First vertical-slice fixtures

Create one representative record fixture containing:

- Réalta
- Fastly
- Akamai
- CloudFront
- `up` metadata
- ASN metadata
- prefix metadata
- weight metadata
- a Filter Chain
- ECS setting
- one feed-controlled value
- one answer group if RTÉ uses groups

Create scenarios:

1. Ireland, AS5466, ECS present
2. Ireland, public resolver, ECS absent
3. matching prefix override
4. Réalta down
5. unsupported filter inserted
6. all tagged answers fail to match, leaving default/untagged answer

Do not claim these are production payloads.

---

## 29. Contract tests

Minimum tests:

### API client

- sends `X-NSONE-Key`
- GET only
- rejects insecure base URL
- applies timeout
- redacts secret
- encodes path components
- handles non-2xx responses

### Normaliser

- preserves raw payload
- preserves unknown fields
- preserves filter order
- preserves answer order
- preserves answer groups

### ECS

- uses ECS when present and enabled
- uses resolver when ECS absent
- uses resolver when ECS disabled
- reports identity source

### Netfence ASN

- matching tagged + untagged retained by default
- untagged removed when configured and match exists
- only untagged retained when no match exists

### Netfence Prefix

- IPv4 match
- IPv6 match
- no-match fallback
- overlap reporting

### Weighted Shuffle

- relative probabilities sum to 1
- zero/invalid weights handled safely
- seeded simulation is repeatable
- result labelled probabilistic

### Unsupported filter

- trace shows unsupported step
- evaluation marked incomplete
- no definitive final answer claimed

---

## 30. Known documentation constraints

The IBM API Hub page requires JavaScript and cannot always be scraped by coding agents.

Therefore:

- this guide is authoritative for verified behaviour listed here;
- exact wire schemas not included here must come from real fixtures or an exported OpenAPI document;
- Claude must not “fill in” unknown JSON field names;
- provisional TypeScript schemas must use `.passthrough()` and preserve raw data;
- every assumption must be listed in `docs/ns1/assumptions.md`.

---

## 31. Implementation checklist for Claude

Before coding the real NS1 adapter:

- [ ] Confirm API base URL
- [ ] Add read-only secret loading
- [ ] Confirm `/zones`
- [ ] Confirm `/zones/{zone}`
- [ ] Confirm `/zones/{zone}/{domain}/{type}`
- [ ] Capture sanitised record fixture
- [ ] Identify actual answer array field
- [ ] Identify actual Filter Chain field and filter IDs
- [ ] Identify ECS-enabled field
- [ ] Identify weight metadata representation
- [ ] Identify ASN metadata representation
- [ ] Identify prefix metadata representation
- [ ] Identify feed references
- [ ] Verify answer-group representation
- [ ] Add contract tests
- [ ] Add unsupported-field telemetry
- [ ] Prove no write method exists

---

## 32. Official source index

Use these IBM pages as the source of truth:

- IBM NS1 Connect API introduction  
  https://www.ibm.com/docs/en/ns1-connect?topic=introduction-using-api

- IBM NS1 Connect API Hub  
  https://developer.ibm.com/apis/catalog/ns1--ibm-ns1-connect-api/

- Traffic steering filter overview  
  https://www.ibm.com/docs/en/ns1-connect?topic=filters-overview-traffic-steering

- Introduction to Filter Chain  
  https://www.ibm.com/docs/en/ns1-connect?topic=chain-introduction-filter

- Creating a Filter Chain  
  https://www.ibm.com/docs/en/ns1-connect?topic=chain-creating-filter

- Shuffle filters  
  https://www.ibm.com/docs/en/ns1-connect?topic=filters-shuffle

- Netfence filters  
  https://www.ibm.com/docs/en/ns1-connect?topic=filters-netfence

- Geographic filters  
  https://www.ibm.com/docs/en/ns1-connect?topic=filters-geographic

- EDNS Client Subnet  
  https://www.ibm.com/docs/en/ns1-connect?topic=chain-edns-client-subnet-ecs-extension

- Answers and answer groups  
  https://www.ibm.com/docs/en/ns1-connect?topic=answers-answer-groups

- Data sources and feeds  
  https://www.ibm.com/docs/en/ns1-connect?topic=monitoring-data-sources-feeds

- Monitoring endpoints and services  
  https://www.ibm.com/docs/en/ns1-connect?topic=monitoring-endpoints-services

- Automatic failover  
  https://www.ibm.com/docs/en/ns1-connect?topic=configurations-configuring-automatic-failover

- Automatic load shedding  
  https://www.ibm.com/docs/en/ns1-connect?topic=configurations-configuring-automatic-load-shedding

- Exporting zone data  
  https://www.ibm.com/docs/en/ns1-connect?topic=zones-exporting-zone-data

- Activity log  
  https://www.ibm.com/docs/en/ns1-connect?topic=reports-activity-log

- Account permissions  
  https://www.ibm.com/docs/en/ns1-connect?topic=management-account-permissions

---

## 33. Final instruction to the coding agent

Treat this document and checked-in fixtures as the project-local NS1 specification.

Do not scrape the IBM site during the build.

Do not invent endpoints, field names or filter semantics.

When a wire-schema detail is unknown:

1. define an interface;
2. use mock fixtures;
3. preserve raw data;
4. document the uncertainty;
5. wait for a real read-only response before finalising the adapter.

RADAR must prefer an explicit “evaluation incomplete” result over a convincing but inaccurate explanation.

## §30. Read-only live validation (production readiness)

Before finalising any adapter against real NS1 data, RADAR provides a **read-only validation**
capability (docs/validation/ns1-live-validation.md) that operationalises §24/§29: it fetches
live (or mock) zones/records/activity via the existing read-only client, preserves the raw
response, and compares it — without coercion — against RADAR's runtime wire schemas, the engine
adapter and the synthetic fixtures.

It reports, per target: schema compatibility, adapter compatibility, supported vs unsupported
filters, unknown metadata fields, unexpected fields, missing expected fields, field-type
mismatches, answer-group presence, feed-controlled metadata presence, ECS configuration, and an
overall status (`compatible` / `compatible_with_warnings` / `partial` / `incompatible` /
`unavailable`). Answer order, filter-chain order, answer-group structure and unknown fields are
all preserved.

Rules this enforces:
- **Never coerce** incompatible live data into the model — report the divergence (a partial or
  incompatible status) instead, consistent with §17's "evaluation incomplete over confidently
  wrong".
- **Provisional fixtures** (§24) are confirmed or corrected against live via this tooling; a
  **sanitised fixture candidate** is a reviewed draft, never an automatic commit.
- Live validation is gated (`NS1_VALIDATION_ENABLED`) and, like everything in v1, **GET-only**.
