# packages/local-llm

The local MLX swarm: resident models, router shim, spawner, and the
anthropic-shim (`:4000`, Anthropic↔OpenAI translation seam).

**Status: extraction pending (W422.4).** The kit currently lives in
`packages/suspenders/hooks/local-llm/` and the operator's runtime home at
`~/.claude/local-llm/` (registry, belt.env, routing-policy, upstreams
overrides). This package becomes the kit's home; the runtime home stays
machine-level config per the enterprise-config law.
