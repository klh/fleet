import { Database } from "bun:sqlite";
import { scratchWorld } from "@klh/test-kit";
import { createRunnerApi } from "../hooks/lib/runners/api/api.ts";
import { createExecutorBindings } from "../hooks/lib/runners/api/bindings.ts";
import { openRunnerController } from "../hooks/lib/runners/control/controller.ts";
import { sqliteStore } from "../hooks/lib/runners/control/store.ts";

export function apiWorld(
	options: Partial<
		Pick<Parameters<typeof createRunnerApi>[0], "identity" | "allowedHosts">
	> = {},
) {
	const world = scratchWorld({ prefix: "runner-api-" });
	const db = new Database(":memory:");
	const store = sqliteStore(db);
	const calls: string[] = [];
	const controller = openRunnerController({
		store,
		durable: {
			async start() {
				calls.push("start");
			},
			async stop() {
				calls.push("stop");
			},
			async resume() {
				calls.push("resume");
			},
			async submit() {
				calls.push("submit");
			},
		},
	});
	const bindings = createExecutorBindings({ store });
	const api = createRunnerApi({
		controller,
		store,
		bindings,
		profiles: {
			standard: {
				version: 1,
				generation: 1,
				kind: "coding",
				seedDigest: "a".repeat(64),
				policyDigest: "b".repeat(64),
				provider: "belt",
				model: "glm-5.3",
			},
		},
		identity: async (request) => {
			const key = request.headers.get("authorization")?.replace("Bearer ", "");
			if (!key) throw new Error("runner.unauthorized");
			return { keyId: key, kind: "api_key", scopes: ["buckle:runner:WRITE_"] };
		},
		...options,
	});
	const request = (key: string, path: string, body?: unknown) =>
		api.fetch(
			new Request(`http://localhost:7810/v1/runner${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: { authorization: `Bearer ${key}` },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
	return {
		request,
		fetch: api.fetch,
		calls,
		bindings,
		controller,
		store,
		close() {
			db.close();
			world.clean();
		},
	};
}
