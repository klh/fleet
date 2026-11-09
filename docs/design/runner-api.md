# Durable runner control API

W2879 connects the reviewed controller to Fleet's runner-ctl service on port
7810. Desktop owns runtime and credentials; this adapter owns HTTP and CLI.

## Contract

- Live Buckle identity per request; owner is key_id, never issuer actor.
- Canonical runner scopes, explicit admin override, host-pinned model profiles.
- Private persisted key/run/epoch/expiry binding; fence wire accepts run ID only.
- Principal-namespaced readers; reconnect preserves cursor; detach never aborts.
- Bounded bodies/responses/deadlines, safe errors, no silent root fallback.
- Request IDs persist through held messages to durable conversation dedupe.
- Identity reads retain auth/scope/veto but consume no model admission slot.
- Stateless CLI help; clean JSON/NDJSON stdout, diagnostics on stderr.

## Execution plan and acceptance

1. Prove real Buckle identity fails under occupied slots, then fix only identity
   admission; retain wrong-scope, revoked and absent credential denials.
2. Test validated identity and private bindings: deny forged epochs, expired
   credentials, foreign owners and takeover losers.
3. Implement injected fetch adapter using real controller, approved admission
   profiles, submit/resume/abort and independent reader fixtures.
4. Propagate request IDs through controller and durable adapter; prove replayed
   HTTP submission cannot duplicate durable work, including held interrupts.
5. Wire coord runner and desktop service; verify real Node and installed HTTP.
6. Required tests, independent full-model review, normal publication gates.
7. BLAM matched baseline/candidate receipts for launch, reconnect, usage and
   quality. Missing usage stays unknown; infrastructure speed is not quality.

Desktop Docker remains independent of NAS shutdown. Pin immutable seed/cohort
versions; new jobs select candidate, active jobs retain their admitted version.
Record rollback and negative results. No deployment/performance claim before
its corresponding witness.
