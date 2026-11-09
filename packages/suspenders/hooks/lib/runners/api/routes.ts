import { runnerAction } from "./actions.ts";
import {
	EmptySchema,
	RunIdSchema,
	RunnerAdmissionSchema,
	RunnerProfileSchema,
	SinceSchema,
} from "./contracts.ts";
import type { RunnerIdentity } from "./identity.ts";
import { listRunnerJobs, listRunnerWorkers } from "./listing.ts";
import {
	requireRunnerOwner,
	requireRunnerScope,
	runnerActor,
} from "./rights.ts";
import type { RunnerApiDependencies } from "./types.ts";
import { readWireJson } from "./wire.ts";

export async function runnerRoute(
	deps: RunnerApiDependencies,
	request: Request,
	identity: RunnerIdentity,
) {
	const url = new URL(request.url);
	if (url.pathname === "/v1/workers" && request.method === "GET")
		return { status: 200, body: listRunnerWorkers(deps.store, identity) };
	if (url.pathname === "/v1/runner/runs" && request.method === "GET")
		return {
			status: 200,
			body: listRunnerJobs(
				deps.store,
				identity,
				url.searchParams.get("after") ?? undefined,
			),
		};
	if (url.pathname === "/v1/runner/runs" && request.method === "POST") {
		requireRunnerScope(identity, true);
		const value = RunnerAdmissionSchema.parse(await readWireJson(request));
		if (!Object.hasOwn(deps.profiles, value.profile))
			throw new Error("runner.invalid_profile");
		const profile = RunnerProfileSchema.parse(deps.profiles[value.profile]);
		const spec = { ...profile, runId: value.runId, owner: identity.keyId };
		const existing = deps.store.get(
			"SELECT run_id FROM runner_jobs WHERE run_id = ?",
			value.runId,
		);
		if (existing) requireRunnerOwner(deps.store, identity, value.runId, true);
		await deps.controller.admit({
			spec,
			actor: runnerActor(identity),
			autoPark: value.autoPark,
		});
		return { status: 201, body: { runId: value.runId } };
	}
	const match = /^\/v1\/runner\/runs\/([^/]+)(?:\/([a-z]+))?$/.exec(
		url.pathname,
	);
	if (!match) throw new Error("runner.not_found");
	const runId = RunIdSchema.parse(match[1]);
	const action = match[2] ?? "read";
	if (action === "fence" && request.method === "POST") {
		EmptySchema.parse(await readWireJson(request));
		const leaseToken = deps.bindings.resolve(identity.keyId, runId);
		await deps.controller.fence({
			runId,
			actor: { sid: identity.keyId, scopes: [], leaseToken },
		});
		return { status: 200, body: { ok: true } };
	}
	const read = ["read", "attach", "replay", "detach"].includes(action);
	requireRunnerOwner(deps.store, identity, runId, !read);
	if (action === "read" && request.method === "GET")
		return {
			status: 200,
			body: await deps.controller.read({
				runId,
				actor: runnerActor(identity),
				since: url.searchParams.has("since")
					? SinceSchema.parse(url.searchParams.get("since"))
					: undefined,
			}),
		};
	if (request.method !== "POST") throw new Error("runner.method_not_allowed");
	return {
		status: 200,
		body: await runnerAction(deps, { request, identity, runId, action }),
	};
}
