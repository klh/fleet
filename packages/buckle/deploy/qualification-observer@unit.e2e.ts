import { expect, test } from "@playwright/test";
import { qualifyApi } from "./test/qualification-api.ts";

test("unexpected HTTP status is observed before refusal without response bodies or credentials", async () => {
	const observations: { method: string; path: string; status: number }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			return Response.json(
				{ secret: "MUST-NOT-BE-OBSERVED", detail: "private-body" },
				{ status: 403 },
			);
		},
	});
	try {
		await expect(
			qualifyApi(
				`http://127.0.0.1:${server.port}`,
				"PRIVATE-ROOT-CREDENTIAL",
				() => 0,
				(fact) => observations.push(fact),
			),
		).rejects.toThrow("Unexpected status for /v1/models");
		expect(observations).toEqual([
			{ method: "GET", path: "/v1/models", status: 403 },
		]);
		expect(JSON.stringify(observations)).not.toContain("MUST-NOT-BE-OBSERVED");
		expect(JSON.stringify(observations)).not.toContain(
			"PRIVATE-ROOT-CREDENTIAL",
		);
	} finally {
		await server.stop(true);
	}
});
