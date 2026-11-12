import { expect, test } from "@playwright/test";
import {
	readPackageMetadata,
	uploadPreflight,
	type GitHubApi,
	type GitHubResponse,
} from "./preflight.ts";
import { registryPreflight } from "./plan.ts";

const pkg = {
	name: "fleet/supervisor-seed",
	package_type: "container",
	visibility: "private",
	repository: { full_name: "klh/fleet", private: false },
};
const repo = {
	full_name: "klh/fleet",
	html_url: "https://github.com/klh/fleet",
	private: false,
	owner: { login: "klh", type: "User" },
};
const response = (
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): GitHubResponse => ({
	status,
	body,
	headers,
	bytes: JSON.stringify(body).length + 30,
});
function apiFixture() {
	const calls: string[] = [];
	const overrides = new Map<string, GitHubResponse>();
	const api: GitHubApi = async (path) => {
		calls.push(path);
		const override = overrides.get(path);
		if (override) return override;
		if (path === "/user/packages/container/fleet%2Fsupervisor-seed")
			return response(404, { message: "Package not found.", status: "404" });
		if (path === "/user") return response(200, { login: "klh", type: "User" });
		if (path === "/repos/klh/fleet") return response(200, repo);
		if (path.startsWith("/user/packages?")) return response(200, []);
		throw Error("Unexpected fixture API");
	};
	return { api, calls, overrides };
}
test("private package linked to PUBLIC official source is valid @unit", async () => {
	expect(registryPreflight(pkg).repository.private).toBe(false);
	const f = apiFixture();
	f.overrides.set(
		"/user/packages/container/fleet%2Fsupervisor-seed",
		response(200, pkg),
	);
	expect(uploadPreflight(await readPackageMetadata(f.api)).state).toBe(
		"present",
	);
	expect(f.calls).toHaveLength(1);
});
test("first upload requires exact owner, structured404 and completed owner inventory; visibility is documented default only @unit", async () => {
	const f = apiFixture();
	const state = await readPackageMetadata(f.api);
	const proof = uploadPreflight(state);
	expect(proof.state).toBe("bootstrap");
	expect(JSON.stringify(proof)).toContain("documented-private-default");
	expect(JSON.stringify(proof)).not.toContain('"visibility":"private"');
	expect(f.calls).toContain("/repos/klh/fleet");
	expect(f.calls).toContain(
		"/user/packages?package_type=container&per_page=100&page=1",
	);
	expect(() => registryPreflight(state)).toThrow();
});
test("masked404, wrong owner/repository and inventory disagreement refuse bootstrap @unit", async () => {
	for (const [path, value] of [
		[
			"/user/packages/container/fleet%2Fsupervisor-seed",
			response(404, { message: "Not Found", status: "404" }),
		],
		["/user", response(200, { login: "other", type: "User" })],
		["/repos/klh/fleet", response(200, { ...repo, full_name: "other/repo" })],
		[
			"/user/packages?package_type=container&per_page=100&page=1",
			response(403, { message: "Forbidden" }),
		],
		[
			"/user/packages?package_type=container&per_page=100&page=1",
			response(200, [
				{
					name: "fleet/supervisor-seed",
					package_type: "container",
					owner: { login: "klh" },
				},
			]),
		],
	] as const) {
		const f = apiFixture();
		f.overrides.set(path, value);
		await expect(readPackageMetadata(f.api)).rejects.toThrow();
	}
	for (const status of [401, 403, 429, 500, 503]) {
		const f = apiFixture();
		f.overrides.set(
			"/user/packages/container/fleet%2Fsupervisor-seed",
			response(status, { message: "not an absence" }),
		);
		await expect(readPackageMetadata(f.api)).rejects.toThrow();
		expect(f.calls).toHaveLength(1);
	}
});
test("inventory pagination, total bytes and total deadline are bounded and ambiguity refuses @unit", async () => {
	const f = apiFixture();
	const page = Array.from({ length: 100 }, (_, i) => ({
		name: `fixture-${i}`,
		package_type: "container",
		owner: { login: "klh" },
	}));
	f.overrides.set(
		"/user/packages?package_type=container&per_page=100&page=1",
		response(200, page),
	);
	await expect(readPackageMetadata(f.api, { maxPages: 1 })).rejects.toThrow();
	const incomplete = apiFixture();
	incomplete.overrides.set(
		"/user/packages?package_type=container&per_page=100&page=1",
		response(200, [], {
			link: '<https://api.github.com/user/packages?package_type=container&per_page=100&page=2>; rel="next"',
		}),
	);
	await expect(readPackageMetadata(incomplete.api)).rejects.toThrow();
	await expect(
		readPackageMetadata(apiFixture().api, { maxBytes: 50 }),
	).rejects.toThrow();
	await expect(
		readPackageMetadata(async () => new Promise(() => {}), { timeoutMs: 20 }),
	).rejects.toThrow("deadline");
});
