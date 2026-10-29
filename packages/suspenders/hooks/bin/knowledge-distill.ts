#!/usr/bin/env bun
// knowledge-distill.ts — the hub's idle-time knowledge distiller (fork G).
// Bare argv = `watch` (the long-running loop: one run per interval_s, each
// gated on the kill switch, the hub lease and the idle verdict). The
// fleet-loop maintenance task fires `run --once`; operators use status /
// pause / resume. Graph queries live on `coord knowledge-graph`.
import { DISTILL_VERBS } from "../lib/knowledge/distill/cli.ts";
import { runCli } from "../lib/verb-kit.ts";

await runCli({
	prog: "knowledge-distill",
	about:
		"Idle-time knowledge distiller (cross-link, dedupe, distill, staleness, contradictions, decant).",
	verbs: DISTILL_VERBS,
	defaultVerb: "watch",
});
