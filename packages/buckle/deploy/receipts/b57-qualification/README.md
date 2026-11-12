# Existing b57 seed: keyed qualification evidence

[Summary](summary.json) records six successful keyed checks against the existing
published `0.1.2-experimental.w2990.2` index. No image was rebuilt or published.
Both platform manifests/configs, raw OCI hashes, labels and rootFS were checked.
AMD64 ran through Docker Desktop emulation on an arm64 host; this is not native
AMD64, hardware, performance, model-quality or deployment acceptance evidence.

| Platform | Check | Local qualification duration |
|---|---|---:|
| arm64 | main | 5679 ms |
| amd64 (emulated) | main | 7749 ms |
| arm64 | fallback mismatch | 5484 ms |
| amd64 (emulated) | fallback mismatch | 6549 ms |
| arm64 | neutral configuration | 5271 ms |
| amd64 (emulated) | neutral configuration | 7480 ms |

[ARM main](arm64-main.json) and [its safe HTTP/cleanup log](arm64-main.log) bind
seven actual catalog fields, finite scoped CRUD/self-whoami, control-key chat and
admin denial, synthetic SSE, revocation and authenticated/denied probes.
[Remaining keyed results](remaining-keyed.json) and [log](remaining-keyed.log)
bind the other five cases. Every accepted case removed its exact owned CID and
proved absence after natural planned exit0. Original log mtime timestamp semantics
and evidence SHA256 values are explicit in the summary.

[Frozen source](source-freeze.json) records exact paths/hashes and the uncommitted
working-tree aggregate used for execution. That capture predates its banking
commit; it does not claim the test helper was already committed when run.
[Failure history](failure-history.json) preserves invalid identity assumptions,
scope-order and cleanup defects, the irretrievably masked primary exception, and
the failed exit137 run's separately authorized disposal. Sanitized unit RED logs
declare their precise path-only redaction and original/stored hashes.

Two unkeyed checks remain NOT RUN pending a separately reviewed explicit disposal
contract. Six keyed passes do not mean all eight modes passed. Registry privacy,
SLSA/SPDX and signature properties were not re-audited by these runtime checks;
the summary links the separate historical publication receipt.
