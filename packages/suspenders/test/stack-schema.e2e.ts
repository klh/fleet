// test/stack-schema.test.ts — W1303.4 schema-first: StackConfigSchema
// (hooks/lib/stack-config.ts) is THE definition of the machine stack conf
// (~/.config/klh/stack.json). JSON.parse stays the ONE parser (W1253
// Amendment A); the schema validates the parsed value. The committed
// example must validate; drift between schema and real conf shapes fails
// loud here.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	StackConfigSchema,
	stackConfIssues,
} from "../hooks/lib/stack-config.ts";

test.describe("W1303.4 StackConfigSchema", () => {
	test("the committed deploy example validates (and parses as JSON)", () => {
		const text = readFileSync(
			join(import.meta.dir, "..", "deploy", "stack.example.json"),
			"utf8",
		);
		const conf = JSON.parse(text);
		expect(StackConfigSchema.safeParse(conf).success).toBeTrue();
		expect(stackConfIssues(conf)).toEqual([]);
	});

	test("empty file: raw reports missing hubs; the loader contract holds", () => {
		// strict view of the raw parsed value — hubs is the one required key
		expect(stackConfIssues(JSON.parse("{}"))).toEqual([
			"hubs: Invalid input: expected record, received undefined",
		]);
		// loadStack normalizes (hubs always present) — an empty config is valid
		expect(stackConfIssues({ hubs: {} })).toEqual([]);
	});

	test("bad shapes report exact paths", () => {
		const issues = stackConfIssues({
			hubs: { nas: { buckle_port: "x" } },
		});
		expect(issues.join("\n")).toContain("hubs.nas.host");
		expect(issues.join("\n")).toContain("hubs.nas.buckle_port");
	});

	test("deploy without dir reports; loose sections ride", () => {
		const issues = stackConfIssues({
			hubs: { nas: { host: "nas.example", deploy: { ssh: "kk@nas" } } },
		});
		expect(issues.join("\n")).toContain("hubs.nas.deploy.dir");
		// unknown sections ride untouched (forward compat, .loose())
		expect(
			stackConfIssues({
				hubs: { nas: { host: "h", future_knob: { deep: true } } },
			}),
		).toEqual([]);
	});
});
