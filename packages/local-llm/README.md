# packages/local-llm

The local MLX swarm: resident models, router shim, spawner, and the
anthropic-shim (`:4000`, Anthropic↔OpenAI translation seam).

**Provenance (owner, 2026-10-05): the kit CAME FROM speedy.** Today it is
split: the core kit (`swarm.ts`, `registry.ts`, `router-shim.ts`) lives in
`packages/suspenders/hooks/local-llm/`, speedy carries its own variants
(`hooks/local-llm/newsroom-swarm.ts`), and the runtime home
(`~/.claude/local-llm/`) is machine-level config per the enterprise-config
law. The extraction (W422.4) must subtree BOTH sources' local-llm history
into this package — speedy first, then the suspenders kit — and retire the
copies. Speedy's install path (`bin/install-fleet.ts`) owns the
config-layer wiring and must keep working through the move.
