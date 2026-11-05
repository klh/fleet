# IKEA Azure deployment plan — W2759

Status: plan + readiness landed 2026-11-05. Azure ground truth measured live
via `az` CLI under `klaus.lynggaard.hougesen@inter.ikea.com` (tenant
`a33c6ac4-a52e-45c5-af07-b972df9bd004`, Inter IKEA Group).

## Target architecture (mission brief)

```
AD users (Entra ID, OneIIG tenant)
        │  OIDC/JWT (delegated) + client-credentials (daemon lanes)
        ▼
AZURE hub — docker containers: buckle + litellm (+ belt optional)
  │  Buckle gate = the front door (auth, keys, budgets, routing)
  │  LiteLLM behind it (W2595 owner ruling: litellm behind EVERY buckle)
  │  Entra auth: BUCKLE_OIDC_* (W372 — config-only, base code)
  ▼
4× H100 hubs — each exposes its served models in its /v1/models
  (buckle front + health sidecars; the Azure hub lists them as spoke peers)
        │
        ▼
Azure OpenAI models (the hub's "with Azure models" inventory)
```

## Measured Azure ground truth (2026-11-05)

Subscription `cbf-imcdigitalassetsearch-prd` (05021989-e6c5-43a5-b6da-7bf4780c2594)
is the alignment target — it already runs the 3DBanken Container Apps estate:

- **Compute shape**: 28 Container Apps in 2 managed environments
  (`cae-3db-prod`, `cae-3db-stage`), all `westeurope`. Entra-authed webapp
  (`AUTH_MICROSOFT_ENTRA_ID_*`, issuer
  `login.microsoftonline.com/<tenant>/v2.0`, managed-identity mode),
  external ingress on `*.azurecontainerapps.io` behind
  `3dbanken.inter-ikea.com`.
- **Registry**: `cr3db.azurecr.io` (Premium, RBAC). Images pulled via
  user-assigned managed identity (`id-3db-ca-prod`), no dockerconfig secrets.
- **Secrets**: Key Vault `kv-3db` (RBAC), Container App secret refs point at
  Key Vault URLs.
- **Observability**: 13 Log Analytics workspaces (`log-cae-3db-*`, `log-3db`).
- **My RBAC (all 9 visible subscriptions)**: Reader + Key Vault Secrets
  Officer on the target sub; no PIM-eligible elevation; no write anywhere.
  App-registration creation is denied (no directory permission).
- **H100 quota**: `StandardNCadsH100v5Family` and `standardNDSH100v5Family`
  are **0/0 in every subscription**. SKUs exist in westeurope
  (`Standard_NC40ads_H100_5`, `Standard_NC80adis_H100_5`,
  `Standard_NCC40ads_H100_5` — zone 2) but need a quota grant before any
  H100 hub VM can exist.
- **Azure OpenAI**: zero `Microsoft.CognitiveServices/accounts` resources in
  any visible subscription.

## What this lane can land (code + config, all inside fleet law)

The full hub already exists as ONE parameterized compose
(`packages/suspenders/deploy/hub-compose.yaml`) driven by a stack.json
profile; Azure deployment = the same hub with an Azure profile +
`litellm:` block + Entra `auth.oidc` — config-over-code, zero fork:

1. **`packages/buckle/upstreams.azure.json`** — the Azure OpenAI upstream
   template (the `upstreams.copilot.json`/`upstreams.zai.json` precedent):
   `azure-openai` adapter (tier-2, shipped W150), Entra client-credentials
   via `adapter_config.entra` (secret = env NAME only), per-deployment
   `deployment:` names, `api-version` pinned. Merge target: the machine
   stack.json `hubs.<label>.upstreams.groups` (values live only in the
   machine 0600 config — template carries placeholders).
2. **H100 spoke hubs**: same compose, one per H100 host, `peers:` pointing
   at the Azure hub label; the Azure hub's ladder carries rows for each
   H100 hub's buckle front (hub-to-hub spoke keys minted per label).
3. **Entra**: `auth.oidc` in stack.json → hubctl renders
   `HUB_BUCKLE_OIDC_ISSUER/JWKS_URI/AUDIENCE` → base-code JWT validator.
   No fleet code change needed (W372 verified end-to-end in code).
4. **Litellm rows**: `litellm:` profile block enables the compose service;
   azure/azure_ai rows in the hub-side `litellm.yaml` ride the same
   `upstream.env` credential law.

## Blockers (owner/IAS actions — not code)

| # | Blocker | Evidence | Who must act |
|---|---------|----------|--------------|
| 1 | No deploy rights on the sub (Reader only) | `AuthorizationFailed` on `group create` | IAM team: grant Contributor (or Container Apps + ACR push) on a new `rg-fleet-ai-*` |
| 2 | H100 quota 0/0 everywhere | `vm list-usage` all subs | Quota request: NCadsH100v5 (e.g. 4× NC80adis_H100_5 = 640 vCPU, westeurope z2) |
| 3 | No Azure OpenAI resource | `cognitiveservices list` empty | Create AOAI + deployments (gpt/gpt-meta model family) in the RG |
| 4 | No app-registration rights | `ad app create` denied | Register the buckle Entra app (audience `api://<appId>`, roles `buckle:proxy:READ_/WRITE_` per the L3 finding) + client-credentials SP for the gate's upstream auth |
| 5 | H100 hosts must exist (docker reachable) | n/a | After quota: 4× NC-series VMs (or Container Apps GPU host) with docker, then the standard `hubctl mint/push/up` |

## Execution order once unblocked

1. IAM grants RG + ACR push + Key Vault Secrets Officer on the new RG.
2. `az cognitiveservices account create` + model deployments; keys → Key
   Vault; entra SP secret → Key Vault.
3. Register buckle app in Entra (redirect = the hub front URL, app roles
   per `finding.ikea-l3-details` naming); record issuer/audience into
   stack.json `auth.oidc`.
4. Build+push the two images the compose needs where the ACR can reach
   them: `oven/bun:1` (digest-pinned) and `ghcr.io/berriai/litellm:v1.103.0`
   — docker save/load or ACR import (no registry pushes of secrets; the
   compose law "no registry pushes" concerns hub code volumes, which stay
   git-pulled).
5. Machine stack.json: new hub profile `azure` (+4 h100 labels), litellm
   block, azure upstream groups merged from the template, peers wired.
6. `hubctl mint/push/up/status azure` (and per H100 hub) — the standard
   chain; Entra JWT validation live at the gate.
7. Canary: `buckle-ready` inference route check per hub; the Azure hub's
   `/v1/models` lists the 4 H100 hubs' exposed models (spoke peer rows).

## Azure-specific deltas vs the NAS hub (operator notes)

- `repos.origin` must be reachable from the ACI/VM: the private
  fleet-enterprise git needs a deploy token ON the hub host (0600), same
  law as the NAS.
- Container Apps cannot run `network_mode: host`; the Azure hub on ACA
  uses explicit `ports:`/ingress (the belt-hub pattern) and the compose
  `buckle-hub` binds must translate: BUCKLE_BIND=0.0.0.0 with ACA ingress
  in front (Entra JWT still enforced at the gate; ACA ingress is
  transport, not authz). A docker-on-VM host keeps `network_mode: host`.
- Health sidecars: ACA/K8s probes replace `docker compose` healthcheck on
  Container Apps; the outside-process probe law still holds (probe sidecar
  container per service, ACA liveness probe hits the SIDECAR port).

## Fleet-internal intel placement

All customer-internal facts (platform capabilities, gateway onboarding,
OAuth specifics, IAM matchup) live in the coordination plane fact store (the finding.* namespace) only —
never this repo. This doc carries only the deployment-facing architecture
and the measured Azure ground truth.
