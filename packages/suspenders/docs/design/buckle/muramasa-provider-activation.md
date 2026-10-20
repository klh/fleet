# Muramasa provider activation

Muramasa's Buckle is the front door, and LiteLLM on `:4100` is the cloud
transport. A Buckle route group is a request alias, not proof of an
independently hosted model. The route is **client → Muramasa Buckle → local
LiteLLM → Anthropic, OpenAI, or OpenRouter**. Keep providers unconfigured in
the network view until credentials, LiteLLM rows, Buckle rows, and an
authenticated request through Buckle have all been verified.

## Credentials and routes

Give LiteLLM each provider's inference key through its supervised process
environment, from a machine-local mode-600 key file. A management key can
provision a limited OpenRouter inference key, but does not itself authorize
inference. Buckle receives only `LITELLM_KEY`, the local LiteLLM master key.
All real paths belong in `~/.config/klh/stack.yaml` or other machine runtime
config, never the repository. The desktop hub's existing Buckle groups use
this shape:

```yaml
hubs:
  desktop:
    buckle_prefs:
      allow_cloud: true
    secrets:
      upstream_keys:
        LITELLM_KEY: /absolute/path/on/hub/litellm.key
    upstreams:
      groups:
        anthropic-model-alias:
          - url: http://127.0.0.1:4100
            dialect: openai
            adapter: openai-compat
            api_key_env: LITELLM_KEY
            model: anthropic-model-alias
        openai-model-alias:
          - url: http://127.0.0.1:4100
            dialect: openai
            adapter: openai-compat
            api_key_env: LITELLM_KEY
            model: openai-model-alias
```

The LiteLLM generator produces corresponding `model_name` rows from its
validated runtime config. For OpenRouter free models,
`deploy/openrouter-free-sync.ts` fetches the current public catalog and
writes a mode-600 machine-local snapshot. The configured desktop hub then
gets one Buckle route per eligible `:free` text model, each targeting the
matching LiteLLM `model_name` under `openrouter/<provider>/<model>:free`.
LiteLLM's row uses `model: openrouter/<provider>/<model>:free` and
`api_key: os.environ/OPENROUTER_API_KEY`. Buckle never calls OpenRouter's
public endpoint directly.

The catalog only establishes the advertised zero price and compatible wire
shape. OpenRouter can still reject a model for account policy, quota, or
provider availability. A real request through Buckle proves availability;
the network view must distinguish configured from observed routes. The
model list and any price display should derive from the refreshed catalog,
not from this example.

Sources: [OpenRouter model catalog](https://openrouter.ai/docs/api/api-reference/models/get-models),
[OpenRouter API key management](https://openrouter.ai/docs/api/api-reference/api-keys/list),
[LiteLLM OpenRouter provider](https://docs.litellm.ai/docs/providers/openrouter).
