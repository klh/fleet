# W596 — knowledge-worker INGEST_LLM_URL parity drift: already resolved

Minted from the W427 A/B: `deploy/services.yaml` knowledge-worker env carried
`INGEST_LLM_URL http://127.0.0.1:8903/v1/chat/completions` while the
`hooks/launchd/com.suspenders.knowledge-worker.plist` template did not, so
`test/install-launchd-parity.test.ts` ("step render is field-equivalent" +
"renders the template file set") failed at the then-HEAD.

Resolution landed on another lane: **W597** (66a2092, 2026-10-07,
"services-manifest parity — commit missing local-dns + cloud-gateway plists,
drop stale INGEST_LLM_URL pin") removed the stale :8903 pin from BOTH
surfaces. Neither services.yaml nor the plist template renders
`INGEST_LLM_URL` anymore; the env override still wins in
`makeDistillClient()` (hooks/lib/knowledge-ports.ts:993), so the enterprise
override path is intact.

Verified at HEAD e0f1f9e (branch suspenders/W596):

- `bun test test/install-launchd-parity.test.ts test/belt-hint.test.ts` — 5 pass, 0 fail
- `bun test test/services-manifest.test.ts test/services-envfile.test.ts test/install-launchd-verified-load.test.ts` — 56 pass, 0 fail

No code change was needed; this record is the product of the closure.
