# Discovery sandbox foundation

This foundation isolates public-network retrieval from strategy parsing and from JobTrack's
durable store. The trusted CLI importer stores proposal bundles and explicit review decisions,
but it does not schedule scans, create applications, apply to jobs, contact employers,
authenticate to job sites, or crawl LinkedIn.

The existing `scripts/scan-public-jobs.js` remains an operator-reviewed tool. Do not schedule
its `--all --ingest` mode. Unattended discovery should produce proposal bundles through this
foundation and stop for review.

## Trust boundaries

```text
untrusted public network
          |
          v
  HTTPS egress broker                 exact policy + public DNS/IP validation
          |
          | retrieval-envelope JSON
          v
 internal-only strategy worker        no direct internet, DB, CLI, browser, or credentials
          |
          | content-addressed proposal-bundle JSON on stdout
          v
  trusted CLI proposal importer        strict revalidation + append-only evidence/decisions
          |
          v
 pending review -> opportunity -> explicit pursue decision -> application
```

The broker is the only dual-homed container. The worker image contains no broker/network
module and its executable imports no HTTP, DNS, socket, browser, SQLite, or JobTrack writer.
It accepts one bounded JSON input and emits one validated JSON output. Posting text is data,
never an instruction or executable payload.

## Versioned contracts

`discovery-sandbox/contracts.js` implements strict version-1 validators for:

- `plugin-manifest`
- `fetch-intent`
- `retrieval-envelope`
- `candidate-observation`
- `proposal-bundle`

Unknown or missing fields fail. Identifiers, sizes, timestamps, URLs, enum values, evidence
references, parser revisions, run/source linkage, and manifest limits are checked. Retrieval
evidence must match the referenced envelope's exact `finalUrl` and `bodySha256`; sharing only a
request ID is insufficient. Proposal bundles include their manifest and immutable retrieval
bodies and are addressed by the SHA-256 of their canonical JSON content. Changing any covered
fact invalidates the bundle ID.

Each candidate also carries two bundle-independent digests for a future importer:

- `sourceFingerprint` groups revisions of the same source/provider identity without depending
  on run IDs or observation timestamps.
- `observationFingerprint` identifies the normalized facts, parser revision, evidence URLs,
  and evidence body hashes while excluding volatile run/capture timestamps.

Both are recomputed by validation; callers cannot substitute arbitrary dedupe keys.

A network-backed manifest must have `fetch` and `parse`, a non-null policy ID, and a positive
request budget. An `imported-leads` manifest must have `import-leads`, `maxRequests: 0`, no
`fetch` capability, and `networkPolicyId: null`.

## HTTPS egress broker

`discovery-sandbox/egress-broker.js` accepts only validated GET/HEAD fetch intents. Callers
cannot supply arbitrary headers. The broker constructs only:

- `Accept`
- `Accept-Encoding`
- its configured `User-Agent`
- optional `If-None-Match` and `If-Modified-Since`

It never forwards cookies, authorization, proxy authorization, ambient proxy settings, or URL
credentials. Outbound requests use Node's direct HTTPS transport on port 443 with normal TLS
certificate verification.

Cache validators are origin-scoped. A same-origin redirect may retain them; the first
cross-origin redirect strips them for that and every later hop.

Before every initial request and redirect, the broker:

1. Matches an exact hostname and an explicit exact/prefix pathname rule.
2. Checks the query-key allowlist and required query values.
3. Resolves every DNS answer.
4. Rejects the entire resolution if any answer is non-public.
5. Pins the HTTPS connection to a validated address while retaining the original TLS name.

Rejected ranges include loopback, private IPv4, link-local, metadata, Carrier-Grade NAT and
Tailscale IPv4 (`100.64.0.0/10`), multicast/reserved/documentation ranges, IPv4-mapped IPv6,
IPv6 unique-local/Tailscale, link-local, multicast, documentation, and tunnel ranges. IPv6 is
conservatively restricted to globally routable `2000::/3` after explicit exclusions.

Responses are streamed through separate compressed and decompressed counters. The broker
limits redirects, both socket inactivity and an absolute wall-clock deadline, declared and
observed compressed bytes, decompressed bytes, content types, and encodings. Hard compressed
and decompressed body ceilings are 16 MiB; contract input/output ceilings are 32 MiB, keeping
temporary decode/base64/JSON copies within the 256 MiB container budget. It records only
bounded response metadata and body bytes in the retrieval envelope. It never executes HTML or
JavaScript.

429 and 503 responses call a backoff hook with parsed `Retry-After`; there is no automatic
retry or sleep. A fail-fast in-memory minimum-interval hook is included for local embedding.
Its next-allowed time only moves later: it takes the maximum of existing cooldown, minimum
interval, status-specific floor, and `Retry-After`, including when `Retry-After` is zero.
A future durable scheduler must own cross-process rate state, jitter, leases, and backoff.

## Broker policy

Policies are strict JSON. Keep one reviewed policy revision per source/board, with the narrowest
possible path and query rules. A representative board policy looks like:

```json
{
  "schemaVersion": 1,
  "policyId": "ashby-example-board",
  "userAgent": "JobTrack-discovery-egress/0.3 (+private operator tool)",
  "allowedOrigins": [
    {
      "hostname": "api.ashbyhq.com",
      "port": 443,
      "paths": [
        { "match": "exact", "value": "/posting-api/job-board/example" }
      ],
      "allowedQueryKeys": [],
      "requiredQuery": {}
    }
  ],
  "allowedContentTypes": ["application/json"],
  "limits": {
    "maxRedirects": 0,
    "timeoutMs": 20000,
    "maxCompressedBytes": 10485760,
    "maxDecompressedBytes": 10485760
  }
}
```

Terms/robots review and source approval remain external policy decisions; DNS safety and
`robots.txt` alone do not grant permission. The checked-in Compose policy points only to the
reserved `example.invalid` domain and therefore fails closed until deliberately replaced.

One-shot broker use reads an intent from stdin unless `--intent` is supplied:

```sh
npm run discovery:broker -- once --policy /path/to/reviewed-policy.json < fetch-intent.json
```

Serve mode binds an internal JSON endpoint and holds policy server-side, so callers cannot
replace it:

```sh
npm run discovery:broker -- serve --policy /path/to/reviewed-policy.json --host 127.0.0.1 --port 8787
```

The API is `POST /v1/fetch`; `GET /healthz` is the only other route. The service permits four
concurrent requests and rejects oversized request bodies.

## Strategy worker and built-in parsers

The worker input is a `strategy-work-request` containing a manifest, frozen run facts,
retrieval envelopes, and strictly bounded input. It performs no retrieval and no durable
write. Version 1 remains accepted for the original validated-observation and imported-lead
flows. Version 2 removes caller-constructed observations: it accepts only `parserConfig` and
derives candidates from the exact retrieval body inside the networkless worker.

The version-2 registry is closed over these exact `pluginId` / `parserName` pairs:

- `jobtrack.ashby-public-board` / `ashby-json` — Ashby public posting API version 1.
- `jobtrack.greenhouse-public-board` / `greenhouse-json` — Greenhouse public board JSON.
- `jobtrack.lever-public-board` / `lever-json` — Lever public postings JSON.
- `jobtrack.funding-json-feed` / `funding-json-feed` — JSON Feed 1/1.1 with the conservative
  structured `_jobtrack_funding` extension described below.

All four parser revisions are `1`. Their manifests must use input schema
`jobtrack.discovery.parser-work-request.v2`, output schema
`jobtrack.discovery.proposal-bundle.v1`, and exactly the `fetch` + `parse` capabilities.
Names are registry keys, never module paths; unknown identities, versions, response fields,
or response schemas fail closed. Each parser requires exactly one successful UTF-8 JSON GET
retrieval. The retrieval's declared media type must be JSON.

Board parser configuration has exactly three bounded fields:

```json
{
  "companyName": "Example Co",
  "boardKey": "example",
  "maxItems": 500
}
```

Funding configuration has exactly `feedName` and `maxItems`. The company name for public ATS
boards is trusted operator configuration because those APIs do not consistently return a
display name; the exact configuration is copied into every observation's hashed attributes.
All candidate observations cite the retrieval's exact `requestId`, `finalUrl`,
`bodySha256`, and `fetchedAt`. Provider HTML is decoded and reduced to normalized text; no
HTML, script, event handler, or instruction is executed.

A minimal version-2 request looks like:

```json
{
  "schemaVersion": 2,
  "kind": "strategy-work-request",
  "manifest": {
    "schemaVersion": 1,
    "kind": "plugin-manifest",
    "pluginId": "jobtrack.ashby-public-board",
    "pluginVersion": "0.3.0",
    "strategyKind": "direct-board",
    "parserName": "ashby-json",
    "parserVersion": "1",
    "networkPolicyId": "ashby-example-board",
    "capabilities": ["fetch", "parse"],
    "inputSchemaId": "jobtrack.discovery.parser-work-request.v2",
    "outputSchemaId": "jobtrack.discovery.proposal-bundle.v1",
    "limits": {
      "maxRequests": 1,
      "maxCompressedBytes": 10485760,
      "maxDecompressedBytes": 10485760,
      "maxInputBytes": 16777216,
      "maxOutputBytes": 16777216,
      "maxRuntimeMs": 20000
    }
  },
  "run": {"runId": "run-1", "sourceKey": "ashby-example", "strategyKind": "direct-board", "startedAt": "2026-07-17T20:00:00Z", "completedAt": "2026-07-17T20:00:01Z"},
  "retrievals": ["one validated retrieval-envelope object"],
  "input": {"parserConfig": {"companyName": "Example Co", "boardKey": "example", "maxItems": 500}}
}
```

The funding parser intentionally does not extract company identity from prose. It accepts
JSON Feed version 1 or 1.1 only when each item contains an explicit extension:

```json
{
  "id": "acme-series-b-2026",
  "url": "https://publisher.example/news/acme-series-b",
  "title": "Acme raises a Series B",
  "date_published": "2026-07-17T20:00:00Z",
  "content_text": "Acme will expand engineering.",
  "_jobtrack_funding": {
    "company_name": "Acme",
    "round": "Series B",
    "amount": "$40M",
    "careers_url": "https://acme.example/careers"
  }
}
```

It emits `funding-signal` candidates for later company/careers review. It never invents a job,
creates an application, or treats a funding announcement as proof that a position exists.

The original imported-lead fixture still runs as a version-1 request:

```sh
npm run discovery:worker < test/fixtures/discovery/imported-leads-work-request.json
```

The output is exactly one proposal-bundle JSON line. Diagnostics go to stderr. File input must
be a non-symlink regular file, and both hard CLI limits and manifest-specific input/output/time
limits apply.

LinkedIn is intentionally an imported-lead provider only. A LinkedIn lead must already have
been supplied by a person, email-alert pipeline, or future licensed API, and its URL must be on
`linkedin.com`. The manifest cannot request networking, the bundle cannot contain retrievals,
and imported evidence cannot claim a response-body digest. There is no LinkedIn login,
credential/session reuse, scraping, CAPTCHA handling, page fetching, auto-apply, or employer
contact code.

## Container topology

Validate the topology without starting it:

```sh
docker compose -f docker-compose.discovery.yml --profile worker config
```

Both services run as UID/GID `65532`, with read-only roots, bounded tmpfs, all capabilities
dropped, `no-new-privileges`, PID/file-descriptor/memory/CPU limits, and no published ports.
The worker joins only the `internal: true` network. The broker joins that network plus the
egress bridge. There are no JobTrack-store, Docker-socket, browser-profile, home, SSH, GPG, or
credential mounts. The only mounted config is a read-only, non-secret network policy.

Run the worker as a one-shot process and provide JSON on stdin. Do not use `compose up` as a
scheduler. Import a completed bundle through the trusted host CLI, then review it explicitly:

```sh
jobtrack discovery proposal import --input proposal-bundle.json --imported-by operator --json
jobtrack discovery proposal list --status pending --json
jobtrack discovery proposal accept --proposal-id sha256:... --decided-by Cole \
  --rationale "Public ATS identity and evidence verified" --idempotency-key proposal-review-1 --json
```

Acceptance creates only a reviewed, digest-bound ingestion intent. It does not create an
opportunity or application and grants no network or submission authority. Rejection is equally
append-only. Scheduling remains outside this release until durable source leases, rate state,
backoff, and reviewed per-source policy are in place.

## Verification

All tests are fixture-backed and make no live network calls:

```sh
npm run test:discovery-sandbox
node --test test/discovery-parsers.test.js
npm test
docker compose -f docker-compose.discovery.yml --profile worker config
JOBTRACK_RUN_CONTAINER_TESTS=1 node --test --test-name-pattern='containerized worker' test/discovery-worker.test.js
git diff --check
```

The fixture suite covers strict schemas and content hashes; pure Ashby, Greenhouse, Lever,
and funding-feed parsing; HTML-to-text handling; exact retrieval evidence; unknown parser and
schema rejection; hostile JSON keys; size bounds; deterministic output; imported-lead isolation; exact
host/path/query policy, redirect scheme/port validation, cross-origin cache-validator stripping,
DNS rebinding-style mixed answers, private and Tailscale IPv4/IPv6 rejection, a real local TLS
socket proving pinned-address/SNI behavior, absolute deadlines, content types,
compressed/decompressed size limits, monotonic `Retry-After` backoff, deterministic output,
stdin bounds, rendered Compose isolation, and an opt-in container egress-denial smoke against a
host-local listener. No test contacts a live external service.

## Deliberate follow-ups

- Add a separate, explicit materialization command from an accepted ingestion intent to the
  opportunity inbox, preserving the proposal digest and occurrence evidence.
- Store durable source rate state and leases in the later scheduler slice.
- Pin production images by digest and add a deployment-specific seccomp profile if the host
  runtime supports it.
- Consider an external firewall/egress proxy for defense in depth; Docker network topology
  prevents worker internet access but is not a substitute for host egress policy.
