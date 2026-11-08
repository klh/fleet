// test/copilot-pat.e2e.ts — W695.6.2: the seat PAT resolver (src/copilot-pat.ts).
// The live proof (bin/copilot-seat-proof.ts) only runs standalone on a spoke
// machine if the resolver falls through to the machine spoke env file, so the
// order env → provider profile → env file is the contract under test. Hermetic:
// scratch files only, no network, no machine conf read.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import {
	patFromEnvText,
	resolveCopilotPat,
	spokeEnvPath,
} from "../src/copilot-pat.ts";

test.describe("@unit copilot PAT resolver", () => {
	const noStack = "/nonexistent/klh-copilot-pat/stack.json";

	test("env wins over the spoke env file", () => {
		const w = scratchWorld({ prefix: "copilot-pat-" });
		try {
			const envFilePath = join(w.home, "buckle-spoke.env");
			writeFileSync(envFilePath, "GITHUB_COPILOT_PAT=from-file\n", {
				mode: 0o600,
			});
			const pat = resolveCopilotPat({
				env: { GITHUB_COPILOT_PAT: " from-env " },
				stackPath: noStack,
				envFilePath,
			});
			expect(pat).toBe("from-env");
		} finally {
			w.clean();
		}
	});

	test("falls through to the spoke env file when the env is empty", () => {
		const w = scratchWorld({ prefix: "copilot-pat-" });
		try {
			const envFilePath = join(w.home, "buckle-spoke.env");
			writeFileSync(
				envFilePath,
				'BUCKLE_DB=/tmp/x.db\nGITHUB_COPILOT_PAT="from-file=with=eq"\nLITELLM_KEY=zz\n',
				{ mode: 0o600 },
			);
			const pat = resolveCopilotPat({
				env: {},
				stackPath: noStack,
				envFilePath,
			});
			expect(pat).toBe("from-file=with=eq");
		} finally {
			w.clean();
		}
	});

	test("no source carries a PAT — empty string, never a throw", () => {
		const pat = resolveCopilotPat({
			env: {},
			stackPath: noStack,
			envFilePath: "/nonexistent/klh-copilot-pat/buckle-spoke.env",
		});
		expect(pat).toBe("");
	});

	test("env-file parse: exact name match, value keeps inner '='", () => {
		const text = "XGITHUB_COPILOT_PAT=decoy\nGITHUB_COPILOT_PAT=a=b \n";
		expect(patFromEnvText(text)).toBe("a=b");
		expect(patFromEnvText("OTHER=1\n")).toBe("");
	});

	test("the default env-file path is the machine spoke env", () => {
		expect(spokeEnvPath("/home/x")).toBe(
			"/home/x/.claude/local-llm/buckle-spoke.env",
		);
	});
});
