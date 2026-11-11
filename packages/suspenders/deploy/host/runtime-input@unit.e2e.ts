import { expect, test } from "@playwright/test";
import { runtimeInputKind } from "./contract.ts";

const sdk =
	"node_modules/.bun/openai@7.19.0+c3b1d5d045878bb4/node_modules/openai/resources/evals/evals.mjs";
test("only pinned public SDK evaluation API clients are admitted @unit", () => {
	for (const suffix of [
		"evals.mjs",
		"index.mjs",
		"runs.mjs",
		"runs/index.mjs",
		"runs/output-items.mjs",
		"runs/runs.mjs",
	])
		expect(runtimeInputKind(sdk.slice(0, -"evals.mjs".length) + suffix)).toBe(
			"sdk-evaluation-client",
		);
	expect(
		runtimeInputKind("packages/suspenders/hooks/bin/runner-control.ts"),
	).toBe("runtime");
	for (const path of [
		"packages/suspenders/evals/private-judge.ts",
		"packages/blam/runtime.ts",
		"benchmarks/held-out/tasks.json",
		"private/judges/check.ts",
		"packages/foo/test/fixture.ts",
		sdk.replace("openai@7.19.0", "spoof@7.19.0"),
		sdk.replace("openai@7.19.0", "openai@7.19.1"),
		sdk.replace("c3b1d5d045878bb4", "0000000000000000"),
		sdk.replace("evals.mjs", "private.mjs"),
		sdk.replace("/node_modules/openai/", "/node_modules/spoof/"),
		sdk.replace("resources/evals/", "private/evals/"),
		`packages/${sdk}`,
		sdk.replace("evals.mjs", "../../judges/private.mjs"),
	])
		expect(() => runtimeInputKind(path), path).toThrow(
			"Forbidden runtime input",
		);
});
