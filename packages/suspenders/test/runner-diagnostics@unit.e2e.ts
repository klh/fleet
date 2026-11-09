import { expect, test } from "@playwright/test";
import { createRunnerApi } from "../hooks/lib/runners/api/api.ts";
import { apiWorld } from "./runner-api.fixture.ts";

test("unexpected failures get correlated diagnostics without raw secret messages @unit", async () => {
	const world = apiWorld();
	try {
		const diagnostics: unknown[] = [];
		const api = createRunnerApi({
			controller: world.controller,
			store: world.store,
			bindings: world.bindings,
			profiles: {},
			async identity() {
				throw new TypeError("Bearer fixture-secret-provider-body");
			},
			onDiagnostic: (event) => {
				diagnostics.push(event);
			},
		});
		const response = await api.fetch(
			new Request("http://localhost:7810/v1/runner/runs"),
		);
		expect(response.status).toBe(503);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			errorClass: "TypeError",
			operation: "list",
			traceId: response.headers.get("x-runner-trace-id"),
		});
		expect(JSON.stringify(diagnostics)).not.toContain(
			"fixture-secret-provider-body",
		);
		expect(await response.text()).not.toContain("fixture-secret-provider-body");
	} finally {
		world.close();
	}
});
