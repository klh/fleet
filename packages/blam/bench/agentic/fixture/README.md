# Relay ledger exercise

Repair the three pure functions in `src/`. They model failure modes seen in
a distributed agent control plane. Keep their signatures and return shapes.
No network service, database, or dependency is needed.

## Claim release

`releaseLease(current, request, nowMs)` decides whether a claim may be
released. A missing claim returns `none`. An expired claim (`expiresAt <=
nowMs`) returns `expired`. For a live claim, check the owner and then the
exact lease token; return `owner-mismatch` or `lease-mismatch` on failure.
Only both matching returns `released`. This is a pure decision: never mutate
the input. A fresh claim by the same owner must not be released by an old
lease token.

## Cache view

`summarizeCache(records, lane, model)` filters records by both lane and
model. Return the request count, known count, warm count, read and write
token totals, and one state. No matching records means `no-traffic`.
All matching records explicitly unsupported means `unsupported`.
Otherwise, supported records with a numeric nonnegative `readTokens` are
known; positive reads are warm. A supported record whose read count is
missing is unknown, not a miss. If no known record remains, state is
`unknown`; otherwise it is `measured`. Sum read and write counts only from
known supported records; a missing write count contributes zero. A zero
write count does not make a cache hit invalid.

## Trace hop

`nextTrace(parent, generatedTraceId, nextSpanId)` returns a W3C version-00
traceparent. A valid parent has lowercase or uppercase hex, exactly 32
trace-id digits, 16 span-id digits, and two flag digits, with nonzero IDs.
Preserve a valid parent's trace ID and flags; replace only the span ID.
For a missing or invalid parent use the supplied generated trace ID and
sampled flag `01`. Validate both supplied IDs (right length, hex, nonzero),
throwing an error if either is invalid. Return lowercase canonical wire
text. These supplied IDs make the function deterministic and testable.
