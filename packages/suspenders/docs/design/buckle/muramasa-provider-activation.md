# Muramasa provider activation

Muramasa's Buckle is a gateway. A route group is a request alias, not proof of
an independently hosted model. The current desktop profile has no direct
Anthropic, OpenAI, or OpenRouter key. These providers must remain **unconfigured**
in the network view until an operator adds credentials and routes. An OpenRouter
account balance alone does not activate a route.

## Add one provider at a time

Edit the machine's mode-600 `~/.config/klh/stack.yaml`, under
`hubs.desktop`. Use an absolute key-file path on the Docker Desktop **host**;
`hubctl push` reads it there and writes the secret into the hub's mode-600
`upstream.env`. Never put a key value in the stack file or repository. Keep
existing `upstreams.groups` and `secrets.upstream_keys` entries when adding
these rows. Replace each angle-bracket value with a model ID verified against
that provider's catalog and the account's permissions.

```yaml
hubs:
  desktop:
    secrets:
      upstream_keys:
        ANTHROPIC_API_KEY: /absolute/path/to/anthropic.key
        OPENAI_API_KEY: /absolute/path/to/openai.key
        OPENROUTER_API_KEY: /absolute/path/to/openrouter.key
    upstreams:
      groups:
        anthropic-direct:
          - url: https://api.anthropic.com
            dialect: anthropic
            adapter: anthropic
            api_key_env: ANTHROPIC_API_KEY
            model: <verified-anthropic-model-id>
            adapter_config:
              headers:
                anthropic-version: "2023-06-01"
        openai-direct:
          - url: https://api.openai.com
            dialect: openai
            adapter: openai-compat
            api_key_env: OPENAI_API_KEY
            model: <verified-openai-chat-model-id>
        openrouter-free:
          - url: https://openrouter.ai/api/v1
            dialect: openai
            adapter: openrouter
            api_key_env: OPENROUTER_API_KEY
            model: <verified-openrouter-model-slug>
            adapter_config:
              path_rewrite:
                /v1/chat/completions: /api/v1/chat/completions
                /v1/responses: /api/v1/responses
```

Only add a provider's key mapping and group together when its key file exists.
Each file contains the raw API key on one line, with mode 600. The three
examples are independent; a missing OpenRouter key must not block Anthropic or
OpenAI activation. `hubctl push desktop` fails when a declared key file is
missing, and `hubctl up desktop` is needed after push to refresh Buckle's env
and upstream ladder. Set `hubs.desktop.buckle_prefs.allow_cloud: true` when
direct cloud egress is intended; the default is closed. A configured group is
still only a configured path: test a real request through Muramasa Buckle
before calling it available.

Buckle forwards absolute request paths, so the OpenRouter rewrite is required:
its API lives under `/api/v1`, while Buckle receives `/v1`. Anthropic's API
requires the non-secret `anthropic-version` header. Do not copy the three
rows without those adapter settings.

OpenRouter exposes account-specific model access and limits. Select a model
from the account's current catalog after funding; do not hardcode a free-tier
quota or infer availability from the account balance. The model list in the
network overview should derive from the active hub configuration and observed
traffic, never from this example.

Sources: [Anthropic API overview](https://platform.claude.com/docs/en/api/overview),
[OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat/create),
[OpenRouter Chat Completions API](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request).
