// hooks/gate-dispatch.ts — the gate event switch, shared by the per-call
// entrypoint (gate.ts) and the hub governor daemon (lib/gate-daemon/host.ts).
// Every case imports its gate lazily: an event pays only for the modules it
// runs (the old top-level import block loaded every gate on every tool call).
// Gate functions keep their `: never` contract — they decide and exit; the
// daemon host intercepts that exit, the per-call process simply ends.
import type { HookInput } from "./lib/hookio.ts";

export async function dispatchGate(
	event: string,
	hook: HookInput,
): Promise<void> {
	const { allow } = await import("./lib/hookio.ts");
	switch (event) {
		case "pre-bash":
			(await import("./gates/bash.ts")).bashGate(hook);
			return;
		case "runaway":
			// W830: transcript-backed repeat/fail-streak/dollar breaker (lanes)
			(await import("./gates/runaway.ts")).runawayGate(hook);
			return;
		case "pre-skill":
			// W1144: Skill-invocation instrumentation (NDJSON append, always allows)
			(await import("./gates/skill-log.ts")).skillLogGate(hook);
			return;
		case "pre-files":
			(await import("./gates/chain.ts")).preFilesChain(hook); // W14 chain
			return;
		case "post-files":
			(await import("./gates/files.ts")).filesGate(hook);
			return;
		case "post-fail":
			// W514: tool-failure counter + anti-thrash guidance
			(await import("./gates/post-fail.ts")).postFailGate(hook);
			return;
		case "push":
			// W417.4: tail new subscribe-log lines into context
			(await import("./gates/push.ts")).pushGate(hook);
			return;
		case "claude-wake": {
			const { waitForClaudeWake } = await import(
				"./lib/executors/claude-wake.ts"
			);
			const { hookLaneId } = await import("./lib/lanes/subscribe-attach.ts");
			const text = await waitForClaudeWake(hookLaneId(hook));
			if (text) {
				process.stderr.write(`${text}\n`);
				process.exit(2); // asyncRewake delivers a native system reminder
			}
			allow();
			return;
		}
		case "pre-read":
			// W110: void — fat-read deny / re-read nudge, else falls through
			(await import("./gates/read.ts")).readGate(hook);
			allow();
			return;
		case "governor":
			// standalone registration (MultiEdit matcher) — no longer chains
			(await import("./gates/governor.ts")).governorGate(hook);
			allow();
			return;
		case "stop":
			(await import("./gates/stop.ts")).stopGate(hook);
			return;
		case "precompact":
			// W642: flush lane state to .fleet/state-<sid>.md pre-compaction
			(await import("./gates/precompact.ts")).preCompactGate(hook);
			return;
		case "codex":
		case "copilot":
		case "grok":
		case "cline":
			// W73/W296 dialect adapters — dialect bound by argv
			// (`gate.ts <dialect> <mode>`); gates keep zero dialect knowledge
			await dialectGate(event, process.argv[3] ?? "", hook);
			return;
		case "session":
			await motd();
			return;
		case "ask":
			// W817 ask-in-session: UserPromptSubmit fleet-meta triage (kev-gated)
			await (await import("./gates/ask.ts")).askGate(hook);
			return;
		default:
			process.stdout.write("{}");
			process.exit(0);
	}
}

async function dialectGate(
	dialect: string,
	mode: string,
	hook: HookInput,
): Promise<void> {
	const payload = hook as Record<string, unknown>;
	if (dialect === "codex")
		await (await import("./dialects/codex/gate.ts")).codexGate(mode, payload);
	else if (dialect === "copilot")
		await (await import("./dialects/copilot/gate.ts")).copilotGate(
			mode,
			payload,
		);
	else if (dialect === "grok")
		await (await import("./dialects/grok/gate.ts")).grokGate(mode, payload);
	else
		await (await import("./dialects/cline/gate.ts")).clineGate(mode, payload);
}

// optional operator motd — drop a file at ~/.cache/claude-governor/motd.md
// and it surfaces at every session start; absent file = silent no-op
async function motd(): Promise<void> {
	const { existsSync, statSync, readFileSync } = await import("node:fs");
	const file = `${process.env.HOME ?? ""}/.cache/claude-governor/motd.md`;
	if (existsSync(file) && statSync(file).size > 0) {
		const { context } = await import("./lib/hookio.ts");
		context(readFileSync(file, "utf8").slice(0, 2000), "SessionStart");
	}
	process.stdout.write("{}");
	process.exit(0);
}
