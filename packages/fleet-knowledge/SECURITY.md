# Security

## Reporting

Open a GitHub security advisory at
https://github.com/klh/fleet-knowledge/security/advisories/new.

Please do not report vulnerabilities through public issues or pull requests.
If one lands publicly anyway, maintainers may limit discussion and redirect
to the advisory channel. Include: the affected route or file, reproduction
steps, and impact.

## Security model

fleet-knowledge is a knowledge plane, not a multi-tenant service. The
threat model assumes a trusted LAN boundary plus layered application
perimeters. What that means, face by face:

### Anonymous /search — scrubbed by construction

`POST /search` needs no credential. Unauthenticated answers have the
fields that feed re-verification — `source_ref`, `source_hash`,
`code_origin` — removed before the response leaves the process, so an
anonymous caller gets the knowledge but not the filesystem layout or a
hash/existence oracle. Presenting the install write token unlocks the
unscrubbed form.

### Keyed /knowledge/query and /knowledge/sql — buckle-verified scopes

Both faces require a bearer key verified against the buckle front's
`/v1/admin/keys/verify`. The key's scopes must name the face:
`buckle:knowledge:QUERY_` for NL→SQL, `buckle:knowledge:READ_` for direct
SQL. Unkeyed calls get 401; mis-scoped keys are refused. Keys are revocable
and minted per consumer.

Both faces execute over a SQLite `mode=ro` connection behind a
SELECT/WITH-only, single-statement lint with an allowlisted table set and
LIMIT enforced and capped. **There is no row cap and no additional
SQL-level read-only enforcement beyond the lint plus the read-only
connection.** A defensive SELECT-only gate (parse-tree level, not
token-level) is roadmap, not reality — we say so plainly rather than
imply the lint is a sandbox. Treat `/knowledge/sql` as exposing the full
allowlisted tables' content to any QUERY_/READ_ key holder.

### Host-guard perimeter

Every request — reads included — is gated on the `Host` header naming a
loopback host, an allowlisted `*.local` name (`SUSPENDERS_ALLOWED_HOSTS`),
or the configured bind address. This is DNS-rebind defense: a browser
pointed at an attacker-chosen hostname cannot reach the API. A request
carrying an `Origin` header must also present a same-allowlist,
Host-equal origin (CSRF defense).

Mutating routes additionally require the per-install write token: a
random 32-byte hex secret generated on first start, stored 0600
(`SUSPENDERS_WRITE_TOKEN_FILE`, default under `~/.cache/claude-governor/`),
presented as the `x-klh-write-token` header. A missing or mismatched
token is 403, never 500.

### Key hygiene

Key material lives in 0600 single-line files wherever a `*_KEY_FILE` /
`*_TOKEN_FILE` knob exists; the env-var forms exist for containers and
tests. Roll keys (the spoke-to-hub claim credential) are stored
sha256-hashed only and printed once at mint time. Anti-entropy peer
calls authenticate with the install write token or a token file.

### Default posture

The default bind is `127.0.0.1`. A LAN or container deployment opts in
via `KNOWLEDGE_API_BIND` and then rides the host allowlist. The compose
file publishes :7802/:7803 — put a fronting proxy with its own auth in
front of it before exposing beyond a trusted network.

### What is out of scope

No encryption at rest (SQLite on disk, unencrypted), no per-tenant
isolation, no rate limiting beyond the ingest budget knobs, and no
audit log of keyed reads beyond the HTTP access surface. If your threat
model includes hostile processes on the same host, this is not the
right tool unmodified.
