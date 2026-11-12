# Canonical provider and peer connections

W3033 owns this source migration. Actual machine configuration belongs to
W3025. The existing `providers` map remains the single operator surface in
`settings.json`; entries represent upstream accounts or other Buckle gateways.

## Contract

Named strict Zod schemas in `settings.connections.ts` use a discriminated
`kind`: `provider` or `buckle`. Both share validated HTTP(S) endpoints,
optional authentication, output env binding, transport limits, model selection
and discovery. Retain `openai`, `anthropic`, and `catalog` endpoint names so
dual-dialect legacy profiles lose no information. Native providers use `base`
and protocol `native`, without an invented OpenAI endpoint. Optional `protocol`
must select a declared endpoint. Adapter names are bounded identifiers; their
owning consumer validates them against its existing registry.

Optional auth has exactly one source: `inline` with private `key`, `file` with
private `path` and optional dotenv `key_name`, or `env` with variable `name`.
The separate entry `env` is an OUTPUT binding. Keys reject control bytes;
URLs reject userinfo, queries and fragments. Templates contain no credentials.

Transport `max_connections` applies to a relay. Provider-only `account`
carries an explicit identity, `concurrency` and `queue_limit`; peers cannot
acquire upstream account capacity through those fields. Omitted limits stay
unknown. `allowed_models` defaults to `["*"]`, a local allowlist that never
grants upstream entitlement. `default_model` must satisfy that allowlist.
Discovery defaults enabled for catalog visibility. Providers
declare their family; peers explicitly use adapter `buckle`. No extension bags.

## Resolution and secrecy

Canonical file: `~/.config/klh/settings.json`, or explicit `KLH_SETTINGS`.
An existing canonical file wins as a whole. Invalid, unreadable or insecure
canonical configuration refuses; only absence permits legacy `stack.json`.
Normalize refs-only settings and raw legacy profiles without losing endpoints.
Read private credentials through the same bounded opened descriptor checked
for regular single-link ownership, mode 0600 and rejecting symlink file entries.

Speedy delegates to settings. Dependencies stay acyclic: settings imports
kernel and Zod; Speedy may import settings. Belt's flat runtime receives a
bundled closure from that same resolver, replacing its parser twin.
Packed consumers and flat runtime must resolve without checkout paths.

Raw-key support lands WITH redaction for `show`, `get`, origin views,
validation errors, migration, hub inventory and render diagnostics. Redact
malformed/unknown auth fields too. JSON errors never echo source snippets.
Generated private env files are outputs, never logged; reject newline injection.

## Verification and delivery

Freeze this design, additive schema and pure tests before consumer migration.
Then wire root schema, private reader, compatibility, redaction and consumers
together. Test no-auth peers, dual dialects, each auth source, model defaults,
invalid URLs/keys, relay/account separation, canonical-invalid refusal,
absence-only fallback, no account borrowing, sentinel-secret diagnostics,
env injection, packed install and the actual flat runtime closure.

Ship placeholder-only root `settings.template.json`; ignore root `settings.json`.
Instructions copy the template to the canonical private path or select
`KLH_SETTINGS`. No live config changes, discovery/API calls, restarts or deploy.

## Installation and operation

Copy the root template to an owned private directory as mode 0600 at
`~/.config/klh/settings.json`, or explicitly set `KLH_SETTINGS` to that file.
Keep the private file outside Git; root `/settings.json` is ignored solely to
protect a local copy, not to introduce another automatic search location.
Replace example endpoints, model IDs and keys privately. Example policy
numbers are illustrative operator inputs, not discovered subscription limits.
Root keys and actual machine activation remain separate operator work.

`provider_requirements` selects connection IDs for a hub. Existing upstream
rows bind by `providerProfile` or the unique generated `api_key_env` output.
Model defaults fill absent upstream model pins; allowed models filter those
actual pins. Discovery controls catalog visibility without granting access.
Native audio entries supply native consumers; projecting them as chat rows
refuses instead of inventing a compatible endpoint.

Account pacing must be complete in `account.pacing`, or already explicitly
configured under the same hub provider pool ID. Concurrency and queue limits
overlay that native policy. Peers never inherit an upstream account binding.
`transport.max_connections` caps active outbound requests, including response
streams through EOF/cancel; it is separate from provider-account pacing and
does not claim a physical TCP socket census. Saturation refuses locally.
Generated private `provider.env` files are outputs, never the credential source.
