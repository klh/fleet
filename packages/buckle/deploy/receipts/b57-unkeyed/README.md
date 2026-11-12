# Unkeyed negative controls and explicit disposal

[Summary](summary.json) and [actual results](negative-controls.json) record two
additional controls on the same existing b57/f19 seed. Each returned anonymous
catalog401 and chat401 with no additional upstream requests in that request window.
The [safe log](execution.log) records the fresh full CID/UUID, Running=true,
OOM=false and exit0 before each disposal intent. The UTC intent and exact bounded
Docker stop argv precede the checked stop; the same CID subsequently reports
NotRunning, OOM=false and exit137, then removal and daemon absence are proved.

Both results explicitly record `graceful:false`, `expectedForcedDisposal:true`
and `preintentRunningVerified:true`. No admin credential was invented. These
negative fixtures intentionally cannot use authenticated planned drain.
Pre-intent death, OOM, ownership drift, missing state, stop failure or uncertain
absence refuse; ordinary/keyed exit137 still fails qualification.

ARM64 completed in 10164 ms; AMD64 completed in 11073 ms through Docker Desktop
emulation on the arm64 host. Durations include setup, checks and disposal and are
not startup, throughput, performance, hardware or model-quality measurements.

[Frozen delta](source-freeze.json) binds the separately reviewed helper bytes
used here, based on preparation commit b2e0b6d. The earlier
[six keyed cases](../b57-qualification/summary.json) used their own c03 snapshot;
their receipts and historical NOT_RUN statements remain immutable. The combined
result is eight controls, comprising six planned exits and two intentional forced
negative-fixture disposals. It is **not eight graceful shutdowns**.

No image was rebuilt or published, no production service or operator configuration
was changed, and no deployment, new privacy audit or signature claim follows.
