# Consult federation (W934.1)

## Decision

Use the existing coord event and WebSocket plane for short consultations. A
consult has one durable ID and can run locally or cross an entitled hub edge.
Keep large source material at its source; return a short answer with exact
citations and fetch only the cited ranges when the agent needs to inspect them.
The transport can later carry the same envelope over another channel, but
WebRTC is not required for question/answer traffic. It needs signaling and
may require a TURN relay on enterprise networks, adding a second network
control plane without removing the hub.

This design extends, rather than replaces, W927's contrastive local consult
and W931's external-agent identity. W923 owns refused-consult event stamping.

## Current boundary

`coord consult --best` checks same-project RUNNING sessions after local
`consult_kb` and verified fact lookup. Expert ranking sees local claims,
recent work, and events. The knowledge port explicitly refuses a remote
`KNOWLEDGE_STORE_URL` today. Federation already has declared peer labels,
hub resolution, and work/policy edges; it has no consult edge. These are
implementation gaps, not an assertion that hub consultation works now.

W94 showed that a broad hub read followed by reading the same file cost 45%
more tokens in its A/B task. The narrower claim that _exact line citations_
save tokens needs its own controlled measurement. Thus a doc-covered local
question skips hub escalation, while a cross-repo or enterprise question may
use the hub and fetch only cited lines.

## Routing

1. Classify the question's tenant, project, data domain, topic, deadline, and
   likely source. Never send a private-domain prompt to a hub merely because
   local retrieval missed.
2. Consult local verified `consult_kb` or facts. Return directly when the
   answer is current and adequately cited. A row that simply restates a
   single local document should point to it instead of duplicating its body.
3. Ask a local specialist or ranked live agent with a compact brief and
   references. A specialist model's internalized knowledge is a lead until
   its source or an authoritative owner verifies it.
4. If policy permits, send one bounded request to the selected team or central
   hub. That hub may use its verified knowledge, live experts, or specialist
   models with entitled retrieval. The hub answers only within the caller's
   effective ACL and data domain; it must recheck those on cache hits.
5. If the hub cannot support an answer, use an entitled indexed-search
   adapter over the allowlisted organizations/repositories. GitHub's REST
   `GET /search/code` is one possible adapter; it has a separate search rate
   limit. Search returns candidates, then the source adapter resolves an
   immutable revision and exact line ranges. Search snippets alone cannot
   become verified answers.
6. Return `unanswered`, `pending`, or `degraded` with the failed stage and
   next safe action when the deadline or budget is exhausted. Do not invent a
   confident answer from a model that lacks evidence.

The selected hub acts as a gateway to its cloud providers and knowledge
sources. A request does not fan out across all hubs. A hub may forward once
to its configured parent when policy permits; `visited_hubs` and `max_hops`
prevent loops.

## Contract

Each request has `consult_id`, W3C `trace_id`, idempotency key, caller
principal and session, tenant/project, work item, scope, data domain,
question, deadline, token budget, hop limit, and allowed source classes.
The server derives principal and project authorization from a revocable
per-agent credential; caller-supplied IDs are correlation hints, never an
authorization grant. W931's board identity should bind the HTTP caller to
the same principal used by the WebSocket event. The shared board write token
is too broad for an external-agent consult credential.

Each response has state, concise answer, answer source (`verified_kb`,
`expert`, `specialist`, or `indexed_search`), confidence/trust state,
observation time, source revision, citations, and measured fresh/cache/output
tokens. A code citation contains repository identity, full commit SHA,
repo-relative path, and inclusive start/end lines. A document citation
contains a document ID, version or ETag, and stable section anchor plus a
bounded excerpt location. No citation may point to an unpinned moving branch
when the answer is marked verified. The reader can request just those ranges;
stale or unauthorized citations require re-resolution or an explicit miss.

The answer event and every hop share `consult_id` and `trace_id`. The work
item timeline records route stages, selected hub/provider/model, queue and
execution time, cache reuse, source checks, token cost, and why escalation
occurred. Redact question and answer bodies in cross-tenant telemetry.

## Herd control and failure semantics

- Singleflight concurrent questions by normalized question, tenant, project,
  caller ACL fingerprint, source revision, and answer domain. Joiners receive
  one result but retain individual attribution; a broader ACL cannot reuse
  a narrower caller's answer without checking every citation.
- Bound each caller, team, specialist, and hub with token buckets and queues;
  reserve capacity for interactive traffic. One retry per stage with jitter
  and deadline-aware backoff. Use a short negative cache and cooldown for
  repeated refusal or outage. A circuit breaker makes a bad hub visibly
  degraded rather than sending a stampede to its parent.
- An accepted answer is not automatically durable knowledge. Promote only
  after source verification or owner confirmation; retain provenance,
  supersession, and domain restrictions. A stale fact is a lead, not a
  permission to act. Revocation invalidates relevant cached answers.

## Acceptance and measurement

Create a sealed synthetic enterprise API fixture with three organizational
areas, at least twelve repositories, versioned service documentation, a
private team-only page, and a hidden API-version change. The evaluator gets
questions but not the answer key. Its action is to write a minimal working
client against the current API; the private oracle runs the client against a
mock service, checks the versioned contract and source citations, and rejects
any use of the forbidden page. This tests useful output rather than the
plausibility of an answer.

Use the same model, question, fixture revision, time/token budget, and source
permissions in paired arms:

| Arm                 | Available path                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Self                | CLI search/read across the allowed corpus                                                                  |
| Broad consult       | Hub returns a general answer; agent searches/reads as needed                                               |
| Cited consult       | Hub or local specialist returns a short answer and immutable exact line ranges; agent fetches those ranges |
| Specialist fallback | Specialist tries first, then authorized indexed org search on an evidence miss                             |

Include a doc-covered local question to catch W94 double-spend, an API
question only the hub can answer, a stale citation, and an ACL-denied
question. Randomize arm order across repetitions, clear answer caches between
cold trials, and separately report warm trials. Freeze source revisions and
include consultation, search, and source-fetch tokens in each arm. Report
answer and client correctness, citation correctness, denied-data leaks,
fresh/cache/output tokens, wall time, rate-limit waits, and cost per correct
answer. Pair each question across arms and show distributions, not only means.
The live study should have multiple held-out questions and repeated trials;
the deterministic oracle is a precondition, not a substitute for live agent
measurements. A single fixture cannot establish an enterprise-wide speedup.

The first benchmark uses synthetic data only. A later private validation may
query the available Confluence, Azure, and GitHub CLIs without copying IKEA
content, credentials, or repository names into Fleet or BLAM. The private
runner records corpus size, indexed revision, search latency, and aggregate
token costs. It retains only redacted metrics in the public benchmark report.

## Specialist model pilot

Use Kev as a short-question classifier for scope and escalation; its current
System One service is a typed-question decision model with a 384-token state
limit, not a long-document answer model. The available Qwen3 0.6B embedding
and reranking models and Qwen3 4B Instruct are better initial retrieval and
answer components. Ask Qwen3 4B to synthesize from a handful of retrieved
passages with exact source locations or abstain; route harder questions to a
larger specialist or entitled hub. Test the base stack before fine-tuning.

Training the weights on the entire changing corpus would not provide reliable
revision citations or deletion/permission behavior. Fine-tuning is reserved
for consult behavior (query classification, concise synthesis, citation and
abstention format) using a curated, sanitized question/answer set. Compare
base model plus retrieval with LoRA/QLoRA plus the same retrieval; keep the
fine-tune only if held-out answer quality or cost per correct answer improves.

The current desktop is an Apple M5 Max with 128 GB unified memory. Native
MLX has LoRA and QLoRA support; Docker Desktop presently exposes about 8 GB
to its Linux VM, so the training pilot should run natively on macOS while
the index and service may be containerized. Do not state a duration for an
unknown corpus. Measure a short fixed-step pilot on this machine, then
extrapolate from observed tokens/second and selected training examples,
including indexing and evaluation time. Record peak unified memory and
energy so the pilot does not starve active local inference lanes.

A 20-step synthetic QLoRA calibration on the resident 4B model at batch 1,
short ~67-token examples, and eight adapted layers ran at 2.8 steps/s after
warmup, peaked at 2.8 GB, and produced a 14.7 MB adapter alongside the
2.26 GB quantized base. These are measured lower-complexity figures, not an
estimate for long real examples or a full corpus. Run a second calibration
with representative 512-1024-token samples before scheduling training.

## Knowledge index and refresh

The source systems remain authoritative. At each entitled hub, keep a
separate corpus index: source IDs, tenant/team ACLs, current version or SHA,
content hashes, tombstones, section and line maps, compact chunks, and
connector cursors. Reuse Fleet's SQLite knowledge/FTS5 infrastructure for
facts and lexical retrieval, but put source chunks in a distinct database
with its own lifecycle. Add vector retrieval only if the held-out benchmark
shows a recall lift; keep the vector backend behind an adapter. An embedded
SQLite vector index can serve the initial hub, while a filtered service such
as Qdrant is a later option if corpus size or shared query load requires it.
Every result is filtered by the effective ACL **before** reranking and LLM
context assembly; a model never sees inaccessible candidates.

Initial ingestion enumerates entitled Confluence spaces/pages and GitHub or
Azure repositories, records source version and ACL, strips irrelevant page
chrome/build/vendor files, chunks by document section or code symbol, and
stores immutable source references. It must not copy the IKEA corpus into
the Fleet repository. After setup, process Git push and Azure code-push
events and Confluence page events where available. A daily reconciliation
scans modified content with an overlap window, compares version/hash and
ACL, re-embeds only changed chunks, and tombstones removals. A periodic full
inventory checks deletions, permission drift, and missed events. Publish a
new index generation atomically after each successful batch; stale connector
state is visible to consult and cannot masquerade as a current answer.

The local machine keeps pointers and an authorized short-lived answer cache,
not a second enterprise corpus. The owning hub fetches cited ranges from its
source adapter. Parent hubs receive only material explicitly entitled for
that level. Query logs retain IDs, route, latency, and token counts; raw
question and source content follow the source retention policy.

Capacity estimate for planning: the current 4B 4-bit model is 2.26 GB on
disk; the short pilot adapter is 14.7 MB. A real adapter may be tens to
hundreds of MB depending on adapted layers/rank. The index is separate:
at 100,000 chunks, 1 KiB text + a 1,024-dimensional float16 embedding is
about 300 MB of raw text and vectors before SQLite indexes, metadata,
versions, and backups. Provision roughly 0.5-2 GB per 100,000 chunks as an
initial range, then replace it with measured corpus and index sizes. The
adapter does not grow with document count; the index does.

The implementation is acceptable when a local agent can ask a hub how to use
an internal API, receive a short answer with exact source locations, fetch
only those locations, and see the complete trace on its work item. Tests must
show singleflight under concurrent load, no private-domain or ACL leak,
bounded hops/retries, and honest pending/degraded states. W934.2 owns the
implementation and live benchmark.

## External capability references

- [GitHub code search REST availability](https://docs.github.com/en/rest/authentication/endpoints-available-for-github-app-installation-access-tokens) and [separate search rate limits](https://docs.github.com/en/rest/rate-limit/rate-limit)
- [GitHub push webhook payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [Confluence page API versions and pagination](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page) and [CQL LastModified](https://developer.atlassian.com/cloud/confluence/cql-fields/)
- [Azure DevOps code-push service hooks](https://learn.microsoft.com/en-us/azure/devops/service-hooks/overview)
- [MLX LoRA/QLoRA training and adapter format](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/LORA.md)
- [WebRTC connectivity and TURN fallback](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Connectivity)
