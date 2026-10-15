// W230: buckle's stack-config window — loadExecutors parsing/degradation +
// agentRecipes per-row overrides (claude/codex/copilot). KLH_STACK points
// at a temp fixture per test; default agentRecipes calls stay machine-free
// (exec defaults to {}).
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExecutors, type StackExecutor } from "../src/stack-config.ts";
import { agentRecipes } from "../src/agents.ts";

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "w230-buckle-"));
	path = join(dir, "stack.yaml");
	process.env.KLH_STACK = path;
});

afterEach(() => {
	delete process.env.KLH_STACK;
	rmSync(dir, { recursive: true, force: true });
});

describe("loadExecutors (W230)", () => {
	test("parses the executors section", () => {
		writeFileSync(
			path,
			"executors:\n" +
				"  copilot: { openai_base: 'http://row:1/v1', model: row-model }\n",
		);
		const ex = loadExecutors();
		expect(ex.copilot?.openai_base).toBe("http://row:1/v1");
		expect(ex.copilot?.model).toBe("row-model");
	});

	test("missing file degrades to {}", () => {
		expect(loadExecutors()).toEqual({});
	});

	test("malformed YAML degrades to {} (config never blocks)", () => {
		writeFileSync(path, "executors: [unclosed\n  - bad\n");
		expect(loadExecutors()).toEqual({});
	});
});

describe("agentRecipes exec overrides (W230)", () => {
	const BASE = "http://127.0.0.1:4100/v1";

	const rowById = (
		exec: Record<string, StackExecutor> | undefined,
		id: string,
	) => agentRecipes(BASE, exec).find((r) => r.id === id);

	test("copilot row drives base + model + probe", () => {
		const cop = rowById(
			{ copilot: { openai_base: "http://row:9/v1", model: "row-model" } },
			"copilot",
		);
		expect(cop?.reroute.env?.COPILOT_PROVIDER_BASE_URL).toBe(
			"http://row:9/v1",
		);
		expect(cop?.reroute.env?.COPILOT_MODEL).toBe("row-model");
		expect(cop?.probe.url).toBe("http://row:9/v1/models");
	});

	test("claude anthropic_base wins over the derived root", () => {
		const cl = rowById({ claude: { anthropic_base: "http://cl:3" } }, "claude");
		expect(cl?.reroute.env?.ANTHROPIC_BASE_URL).toBe("http://cl:3");
		expect(cl?.probe.url).toBe("http://cl:3/v1/messages");
	});

	test("no rows = pre-W230 parity (constants)", () => {
		const cl = rowById(undefined, "claude");
		expect(cl?.reroute.env?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4100");
		expect(cl?.reroute.env?.ANTHROPIC_MODEL).toBe("claude-sonnet-5");
	});

	test("codex ephemeral render rides the row base", () => {
		const cx = rowById({ codex: { openai_base: "http://cx:5/v1" } }, "codex");
		const text = cx?.ephemeral?.render("ignored", "mm");
		expect(text).toContain('base_url = "http://cx:5/v1"');
	});
});
