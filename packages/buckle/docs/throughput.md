# Throughput evidence

Buckle's existing authenticated `GET /v1/admin/metrics` connector exposes
node-local throughput evidence alongside Buckle and LiteLLM metrics. It
uses the existing ledger SQLite database. There is no additional service.

## Identity and counting

`requested_group` is the client's route alias. `served_model` and provider
identity describe the delivered deployment, including fallback. A deployment's
optional `provider` and `providerProfile` are non-secret canonical IDs from
the central provider profile. The generator owns their materialization.
An Anthropic wire does not imply Anthropic is the provider.

Only a configured Buckle peer can supply `x-klh-served-model`,
`x-klh-served-provider`, and `x-klh-served-provider-profile`. Arbitrary client
or native-provider headers cannot override configured identity. Audit
`served_evidence` distinguishes configured model IDs from peer evidence;
these IDs are not claims that a provider independently attested its model.
Missing identity remains unknown.

Every client request contributes once per node and request ID. Attempts and
retries have separate counts. These are **node-local** measurements. They
must not be summed across relayed hops as fleet throughput. Existing trace
and call IDs remain the authoritative join for a federated view.

Unknown usage is not zero tokens. Unknown token rates are omitted and
`unknown_usage_samples` reports coverage. Service rate divides reported
successful output by the winning outbound hop duration, excluding measured
local admission dwell. It includes prefill and any unmeasured downstream
wait; it is not a pure decoder-speed estimate. End-to-end rate includes
the request's complete elapsed time. Queue and request means remain separate.

## Comparable baselines

Persisted cohorts separate requested group, delivered model, provider,
provider profile, declared effort where available, and input-context bins.
Context bins retain the input wire and mean **reported input**, not an
estimated complete context. Anthropic fresh-input accounting and OpenAI
prompt-input accounting are never merged by adding cache counters.
Closed windows require known usage, enough successful samples, observed
concurrent or queued demand, fresh measurements, and known route identity.
Idle, missing, stale, paused or capacity-limited evidence cannot train or
trigger a degradation warning. They also break a sustained-warning streak.

The shared statistical component keeps an EWMA reference, freezes it on
suspected drops and active incidents, and requires sustained warning and
recovery windows. Service and end-to-end relative rates distinguish outbound
service slowdown from queue/admission slowdown. Statistical evidence does
not establish a provider's contractual concurrency limit.

The optional `gateway.throughput` object configures the complete bounded
policy. Defaults:

```json
{
  "bucketMs": 60000,
  "retentionBuckets": 120,
  "maxDimensions": 128,
  "maxSamplesPerBucket": 4096,
  "minSamples": 20,
  "baselineBuckets": 8,
  "dropPercent": 50,
  "sustainBuckets": 3,
  "recoveryPercent": 75,
  "recoveryBuckets": 2,
  "alpha": 0.2
}
```

Bucket/cardinality exhaustion invalidates comparison rather than presenting
a partial sample as healthy evidence. Durable incident IDs survive repeated
scrapes; a consumer must deduplicate publication and investigation by that
ID. A warning does not automatically change routing, reclaim a lane or ask
for a human decision.

## Integration status

The measurement and statistical contracts are the first slice of W1124.23.
The Suspenders consumer, deployment-pause binding, canonical incident/work
publication, browser display, provider-profile generator wiring and full
public/private rollout are separate acceptance work. This document does
not certify those integrations or production capacity.
