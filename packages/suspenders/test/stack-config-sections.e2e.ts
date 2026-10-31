// W230: providers/executors/policies sections of the ONE stack config —
// loader contract + resolvers. KLH_STACK points at a temp fixture (mode
// 600) per test; env mutations are synchronous, no cross-test leakage.
import { expect, test } from "./pw";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	executorConfig,
	policyForRepo,
	providerKey,
	tryLoadStack,
} from "../hooks/lib/stack-config.ts";

let dir: string;
let path: string;

test.beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "w230-stack-"));
	path = join(dir, "stack.json");
	process.env.KLH_STACK = path;
});

test.afterEach(() => {
	delete process.env.KLH_STACK;
	delete process.env.W230_TEST_KEY_VAR;
	rmSync(dir, { recursive: true, force: true });
});

const writeStack = (conf: unknown): void => {
	writeFileSync(path, `${JSON.stringify(conf, null, "\t")}\n`);
	chmodSync(path, 0o600);
};

test.describe("W230 stack sections", () => {
	test("empty config = valid empty config", () => {
		writeStack({});
		const s = tryLoadStack();
		expect(s).not.toBeNull();
		expect(s?.hubs).toEqual({});
	});

	test("executorConfig: id row, then default-row fallback", () => {
		writeStack({
			executors: {
				default: { openai_base: "http://d:1/v1", model: "m-def" },
				claude: { anthropic_base: "http://c:2", model: "m-claude" },
			},
		});
		expect(executorConfig("claude")?.model).toBe("m-claude");
		expect(executorConfig("claude")?.anthropic_base).toBe("http://c:2");
		expect(executorConfig("codex")?.model).toBe("m-def");
		expect(executorConfig(undefined)?.model).toBe("m-def");
		expect(executorConfig(undefined)?.openai_base).toBe("http://d:1/v1");
	});

	test("policyForRepo: basename beats wildcard; missing row undefined", () => {
		writeStack({
			policies: {
				fleet: { hub: "nas", residency: ["eu"] },
				"*": { prefer: "local" },
			},
		});
		expect(policyForRepo("/x/y/fleet")?.hub).toBe("nas");
		expect(policyForRepo("/x/y/FLEET")?.residency).toEqual(["eu"]);
		expect(policyForRepo("/x/y/other")?.prefer).toBe("local");
		expect(policyForRepo("/x/y/other")?.hub).toBeUndefined();
	});

	test("providerKey: inline → env → key_file (0600, key_name default, quoted)", () => {
		process.env.W230_TEST_KEY_VAR = "env-value";
		const secrets = join(dir, "secrets.env");
		writeFileSync(secrets, 'OTHER=1\nFROM_FILE_API_KEY="file-value"\n');
		chmodSync(secrets, 0o600);
		writeStack({
			providers: {
				inline: { key: "inline-value" },
				"via-env": { env: "W230_TEST_KEY_VAR" },
				"from-file": { key_file: secrets },
				named: { key_file: secrets, key_name: "OTHER" },
			},
		});
		expect(providerKey("inline")).toBe("inline-value");
		expect(providerKey("via-env")).toBe("env-value");
		expect(providerKey("from-file")).toBe("file-value");
		expect(providerKey("named")).toBe("1");
	});

	test("key_file not mode 600 → throws", () => {
		const secrets = join(dir, "loose.env");
		writeFileSync(secrets, "X_API_KEY=1\n");
		chmodSync(secrets, 0o644);
		writeStack({ providers: { x: { key_file: secrets } } });
		expect(() => providerKey("x")).toThrow(/mode 600/);
	});

	test("missing file: null stack + resolvers degrade", () => {
		expect(tryLoadStack()).toBeNull();
		expect(executorConfig("claude")).toBeUndefined();
		expect(policyForRepo("/x/y/fleet")).toBeUndefined();
		expect(providerKey("x")).toBeNull();
	});
});
