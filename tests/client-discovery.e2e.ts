// tests/client-discovery.e2e.ts — W1731 proof for the client-adapter
// dispatch seam (design.client-adapter-dispatch): @vercel/detect-agent's
// determineAgent() → canonical registry id → that adapter's transcript
// evidence reader → the ONE W833 verifier. Registered launch identity is
// authoritative; detection is advisory and loud on disagreement; unknown
// names and a bare credential answer null; raw detector names and env
// values never surface; a wrong or reader-less client fails closed.
// Discovery runs in spawned children (helpers/client-discovery-probe.ts)
// whose env is the scenario's signals over a scrubbed inherited env.
// Shape law (see check-deps.e2e.ts): imports and test registrations only.
// The tag rides the describe TITLE: the runner the root tests/ specs
// resolve to from a worktree (1.63.0) reads a details-object describe as
// a title ("[object Object]") and tags nothing; title tags work in both.
import { expect, test } from "@playwright/test";
import { EXECUTOR_ADAPTERS } from "../packages/suspenders/hooks/lib/executors/registry.ts";
import {
	claimCheckVerdict,
	transcriptEventsFromText,
} from "../packages/suspenders/hooks/lib/gates/claim-check.ts";
import {
	claimOnlyTranscripts,
	claudePassingTranscript,
	probeClient,
} from "./helpers/client-discovery-probe.ts";

test.describe("@unit W1731 client discovery", () => {
	test("missing signals: nothing detected, the registry default reads", () => {
		const probe = probeClient({});
		expect(probe.detected).toBeNull();
		expect(probe.client).toBe("claude");
		expect(probe.stderr).not.toContain("warning:");
	});

	test("runtime markers canonicalize onto registry ids — one client list", () => {
		expect(probeClient({ CODEX_THREAD_ID: "thread" }).detected).toBe("codex");
		expect(probeClient({ CLAUDECODE: "1" }).detected).toBe("claude");
		expect(
			probeClient({ CLAUDECODE: "1", CLAUDE_CODE_IS_COWORK: "1" }).detected,
		).toBe("claude");
		expect(probeClient({ COPILOT_MODEL: "model" }).detected).toBe("copilot");
		expect(probeClient({ AI_AGENT: "github-copilot-cli" }).detected).toBe(
			"copilot",
		);
		const claimed = EXECUTOR_ADAPTERS.flatMap((a) => a.detect?.names ?? []);
		expect(new Set(claimed).size).toBe(claimed.length);
	});

	test("nested agent: an inherited conflicting AI_AGENT loses to the launch identity, loudly", () => {
		const probe = probeClient(
			{ AI_AGENT: "claude-code" },
			{ value: "codex", source: "dispatch" },
		);
		expect(probe.detected).toBe("claude");
		expect(probe.client).toBe("codex");
		expect(probe.stderr).toContain(
			"launch identity codex ≠ detected claude (inherited environment?) — launch identity wins",
		);
	});

	test("nested copilot lane under a claude parent keeps its board-registered identity", () => {
		const probe = probeClient(
			{ CLAUDECODE: "1", COPILOT_MODEL: "model" },
			{ value: "copilot", source: "fleet-board" },
		);
		expect(probe.detected).toBe("claude");
		expect(probe.client).toBe("copilot");
		expect(probe.stderr).toContain("launch identity copilot ≠ detected claude");
	});

	test("a lane-written executor fact is not launch identity: detection fills in", () => {
		const probe = probeClient(
			{ CODEX_CI: "1" },
			{ value: "copilot", source: "lane" },
		);
		expect(probe.detected).toBe("codex");
		expect(probe.client).toBe("codex");
		expect(probe.stderr).not.toContain("warning:");
	});

	test("a human shell carrying COPILOT_GITHUB_TOKEN alone is no agent, and the value never surfaces", () => {
		const credential = "w1731-sentinel-credential-value";
		const probe = probeClient({ COPILOT_GITHUB_TOKEN: credential });
		expect(probe.detected).toBeNull();
		expect(probe.client).toBe("claude");
		expect(probe.stdout + probe.stderr).not.toContain(credential);
	});

	test("unknown or unregistered clients answer null and the raw name is never echoed", () => {
		const raw = "w1731-unregistered-agent";
		const probe = probeClient(
			{ AI_AGENT: raw },
			{ value: "codex", source: "dispatch" },
		);
		expect(probe.detected).toBeNull();
		expect(probe.client).toBe("codex");
		expect(probe.stdout + probe.stderr).not.toContain(raw);
		expect(probeClient({ GEMINI_CLI: "1" }).detected).toBeNull();
	});

	test("a transcript read as the wrong client yields zero runs: the claim fails closed", () => {
		const t0 = Date.parse("2026-10-26T12:00:00Z");
		const transcriptText = claudePassingTranscript(t0);
		expect(
			transcriptEventsFromText(transcriptText, "claude").runs,
		).toHaveLength(1);
		expect(transcriptEventsFromText(transcriptText, "codex").runs).toEqual([]);
		const own = claimCheckVerdict({
			client: "claude",
			transcriptText,
			paths: [],
			diffText: "",
			now: t0 + 60_000,
		});
		expect(own.ok).toBe(true);
		const wrong = claimCheckVerdict({
			client: "codex",
			transcriptText,
			paths: [],
			diffText: "",
			now: t0 + 60_000,
		});
		expect(wrong.ok).toBe(false);
		expect(wrong.why).toContain(
			"no test run found in the transcript (read as codex)",
		);
	});

	test("a registered client without an evidence reader fails closed by name", () => {
		const t0 = Date.parse("2026-10-26T12:00:00Z");
		const verdict = claimCheckVerdict({
			client: "grok",
			transcriptText: claudePassingTranscript(t0),
			paths: [],
			diffText: "",
			now: t0 + 60_000,
		});
		expect(verdict.ok).toBe(false);
		expect(verdict.why).toContain(
			"no transcript evidence adapter for client grok — its runs cannot be read, so the claim fails closed",
		);
		expect(
			EXECUTOR_ADAPTERS.filter((a) => a.spawnable && !a.evidence).map(
				(a) => a.id,
			),
		).toEqual([]);
	});

	test("claims stay visible under every registered identity", () => {
		const t0 = Date.parse("2026-10-26T12:00:00Z");
		for (const transcriptText of claimOnlyTranscripts(t0))
			for (const adapter of EXECUTOR_ADAPTERS) {
				const events = transcriptEventsFromText(transcriptText, adapter.id);
				expect(events.claims, `read as ${adapter.id}`).toHaveLength(1);
				expect(events.runs).toEqual([]);
			}
	});
});
