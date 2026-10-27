// test/hub-ref-preflight.test.ts — W1302.3: the ref-existence preflight.
// ONE shape gate shared with renderEnv; every pin resolves against the
// origin the hub actually pulls from; refusal fails closed and never echoes
// inline git credentials (A11: a well-formed pin to a nonexistent tag
// activated fine and died at fleet-repo exit 128).
import { expect, test } from "@playwright/test";
import {
	assertDeployRefsExist,
	type RefProbe,
	resolveHubOrigin,
	FLEET_ORIGIN,
} from "../deploy/hub-ref-preflight.ts";
import type { HubProfile } from "../hooks/lib/stack-config.ts";

const served: RefProbe = () => ({
	status: 0,
	stdout: "89806009791d743bbfdf27c35d372ac1d7e0a3a7\trefs/tags/any\n",
	stderr: "",
});

test("shape gate: unpinned or branch versions refuse before any probe", () => {
	let probes = 0;
	const probe: RefProbe = () => {
		probes++;
		return served();
	};
	for (const version of [undefined, "main", "master"])
		expect(() =>
			assertDeployRefsExist({} as HubProfile, "zai", version, probe),
		).toThrow(/requires a pinned stack version/);
	expect(probes).toBe(0);
});

test("shape gate: overlay needs repos.ref; public repos.ref equals the version", () => {
	expect(() =>
		resolveHubOrigin(
			{
				repos: { buckle: "https://git.example/klh/overlay.git" },
			} as HubProfile,
			"v1",
		),
	).toThrow(/overlay origin needs repos\.ref/);
	expect(() =>
		resolveHubOrigin({ repos: { ref: "other" } } as HubProfile, "v1"),
	).toThrow(/must match the shared stack version/);
});

test("resolveHubOrigin hands back the deployable ref per posture", () => {
	expect(resolveHubOrigin({} as HubProfile, "v1")).toEqual({
		origin: FLEET_ORIGIN,
		overlay: false,
		ref: "v1",
	});
	expect(
		resolveHubOrigin(
			{
				repos: { ref: "ov", buckle: "https://git.example/klh/o.git" },
			} as HubProfile,
			"v1",
		),
	).toEqual({
		origin: "https://git.example/klh/o.git",
		overlay: true,
		ref: "ov",
	});
});

test("a public-origin hub resolves only the stack version", () => {
	const calls: string[][] = [];
	assertDeployRefsExist(
		{ repos: { ref: "v1" } } as HubProfile,
		"h",
		"v1",
		(argv) => {
			calls.push(argv);
			return served();
		},
	);
	expect(calls).toEqual([
		["git", "ls-remote", "--exit-code", FLEET_ORIGIN, "v1"],
	]);
});

test("an overlay hub resolves the version in public AND repos.ref in the overlay", () => {
	const calls: string[][] = [];
	assertDeployRefsExist(
		{
			repos: { ref: "ov-tag", buckle: "https://ops@git.example/klh/o.git" },
		} as HubProfile,
		"h",
		"ov-tag",
		(argv) => {
			calls.push(argv);
			return served();
		},
	);
	// the same tag is probed on BOTH origins: public-alive + mirror-dead is
	// exactly the A11 shape
	expect(calls).toEqual([
		["git", "ls-remote", "--exit-code", FLEET_ORIGIN, "ov-tag"],
		[
			"git",
			"ls-remote",
			"--exit-code",
			"https://ops@git.example/klh/o.git",
			"ov-tag",
		],
	]);
});

test("a pin the origin does not serve fails closed with the repin remedy", () => {
	expect(() =>
		assertDeployRefsExist(
			{} as HubProfile,
			"zai",
			"fleet-2026-10-25-64cf184c",
			() => ({ status: 2, stdout: "", stderr: "" }),
		),
	).toThrow(/stack version "fleet-2026-10-25-64cf184c" does not exist in/);
});

test("an unreachable origin refuses with redacted git evidence", () => {
	const probe: RefProbe = (argv) =>
		argv.some((a) => a.includes("git.example"))
			? {
					status: 128,
					stdout: "",
					stderr:
						"fatal: unable to access 'https://ops:sekrit@git.example/klh/o.git/': HTTP 403",
				}
			: served();
	expect(() =>
		assertDeployRefsExist(
			{
				repos: { ref: "x", buckle: "https://ops:sekrit@git.example/klh/o.git" },
			} as HubProfile,
			"zai",
			"x",
			probe,
		),
	).toThrow(
		/overlay repos\.ref "x" could not be resolved against https:\/\/\*\*\*@git\.example/,
	);
	let message = "";
	try {
		assertDeployRefsExist(
			{
				repos: { ref: "x", buckle: "https://ops:sekrit@git.example/klh/o.git" },
			} as HubProfile,
			"zai",
			"x",
			probe,
		);
	} catch (e) {
		message = (e as Error).message;
	}
	expect(message).not.toContain("sekrit");
});

test("a 40-hex pin resolves via full-list membership", () => {
	const sha = "a69f2c4c4747e290d319dc6a36b4659406f96baf";
	const calls: string[][] = [];
	const listing: RefProbe = () => ({
		status: 0,
		stdout: `${sha}\trefs/tags/fleet-1\n`,
		stderr: "",
	});
	assertDeployRefsExist({} as HubProfile, "h", sha, (argv) => {
		calls.push(argv);
		return listing();
	});
	// the sha cannot ride a ref-name pattern — the whole list is asked for
	expect(calls).toEqual([["git", "ls-remote", FLEET_ORIGIN]]);
	expect(() =>
		assertDeployRefsExist(
			{} as HubProfile,
			"h",
			sha.replace("a69f", "b70a"),
			listing,
		),
	).toThrow(/does not exist in/);
});
