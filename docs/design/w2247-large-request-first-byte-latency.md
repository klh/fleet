# W2247 — large-request first-byte latency diagnosis

2026-10-29 · lane autow2247-p98b319584008df14 · packages/buckle

## Question

Trace 31b39cbcc0379baec23fbb7528800916: 912384 request bytes, queue_wait_ms=0,
headersMs=76562, status 200. Is a large request body the driver of slow
first-byte latency, and can we expose safe progress/timeout reporting
without changing prompt semantics or model?

## Method

`bun packages/buckle/bin/latency-report.ts` (landed this item) reads the
buckle ledger read-only and renders matched request-size vs transport
latency from `route_attempt.transport_json` (requestBodyBytes, headersMs,
firstBodyByteMs) joined to `route_audit.stream_receipt`. headersMs and
firstBodyByteMs render SEPARATELY (W2247.1): headersMs is time-to-headers,
firstBodyByteMs is the actual first body byte, aggregated from observed
values only. Verified live 2026-10-29 (~133k attempts) — the render below
predates the W2247.1 metric correction (headers-only columns):

```
attempts with transport evidence: 133102
pearson r(requestBytes, headersMs): -0.061
streaming headersMs p50: 3697 ms (n=71469)
non-streaming headersMs p50:   930 ms (n=61633)
bucket      n      hdrMs p50/p90/max      reqKB avg   queueWait p50
<10k         4490     1709/7543/1012325           2              0
10-100k     23286      939/23096/352005          67            476
100-500k    82744      2741/7353/928515         266            78
500k+       22582      3086/8022/383548         732              0
```

## Correction (W2247.1 — review B1-first-byte-metric)

The original report labelled `headersMs` "first-byte latency". headersMs
is time-to-HEADERS: for non-streaming requests it includes the provider's
whole generation (finding 2), so it is NOT a first-byte metric. The report
now renders the two separately:

- `headersMs` aggregates keep the historical size-vs-latency finding
  (r = −0.061 across all four size buckets, multi-minute tail in every
  bucket) — correctly labelled a HEADERS finding.
- `firstBodyByteMs` is aggregated from observed values only, with its n
  rendered beside it; rows without a first-body byte are excluded — never
  backfilled from headersMs, never fabricated when absent (the report
  prints `no first-body observations` instead of an invented aggregate).
- The routing/timeout semantics are untouched: no fabricated live
  first-byte aggregate is claimed beyond what `firstBodyByteMs` observed.

## Findings

1. **Request size is NOT the driver — of headers time.** Pearson r(requestBytes, headersMs)
   = −0.061 over ~133k attempts. The medians climb only mildly with size
   (0.9 s → 3.1 s p50 from <10k to 500k+); the multi-minute tail exists in
   EVERY size bucket (max 1012 s on <10KB requests).
2. **The trace's 76 s was generation time, not transport.** The request was
   non-streaming (`stream_receipt` null): a provider sends no response
   headers until the full completion is generated. The trace's
   `headersMs=76562` matches its out_tok=4106 at ≈18.6 ms/token — normal
   glm-5.3 generation pace. Correlation r(out_tok, headersMs) = 0.435
   (measured 2026-10-28+ window, n≈10.8k) versus r(requestBytes) = −0.061.
   The 912 KB upload rode fine (queue_wait_ms=0, connect + headers timing
   shows no upload stall). Note: the aggregate streaming p50 above exceeds
   the non-streaming p50 because routing steers LONG-generation requests to
   streaming — a confound, not a contradiction.
3. **queue_wait_ms is honest.** p50 ≈ 0-476 ms across buckets; admission
   never contributed to this trace (queue_wait_ms=0, single attempt,
   status 200 first try).
4. **Existing instrumentation already covers "progress/timeout"**:
   `TransportEvidence` banks requestBodyBytes / headersMs /
   firstBodyByteMs / timeoutBudgetMs / timeoutPhase per attempt in
   `route_attempt.transport_json`, and the ledger exposes
   `queue_wait_ms` per attempt. The tail phases ("headers" timeout) are
   already classified. No new timeout semantics are needed; lowering the
   first-byte deadline for large requests would break legitimate
   long-generation completions.

## Disposition

- Landed: `src/latency-report.ts` + `bin/latency-report.ts` (read-only
  diagnostic face, `--db` override) + `test/latency-report.e2e.ts`.
  W2247.1 corrected the metric: `firstBodyByteMs` renders separately from
  `headersMs` with honest n counts; regressions cover distinct values and
  missing-first-body rows (never fabricated).
- Recommended, NOT landed (owner call): callers wanting low first-byte
  latency should request streaming (SSE first chunk ≈ headers+1 frame);
  for non-streaming requests no safe mid-flight progress signal exists —
  the provider buffers the whole completion, so any "progress" we could
  report before headers would be fabricated. Prompt semantics and model
  choice are untouched.
