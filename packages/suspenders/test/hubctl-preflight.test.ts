import { describe, expect, test } from "bun:test";
import { assertHubActivationPreflight } from "../deploy/hubctl.ts";

const good = () => ({
	status: 0,
	stdout: JSON.stringify({
		ok: true,
		mode: "static",
		findings: [],
		drills: [{ ok: true }],
	}),
	stderr: "",
});

describe("hubctl activation route gate", () => {
	test("deploy and up accept a passing static graph and drill", () => {
		for (const verb of ["deploy", "up"])
			expect(() => assertHubActivationPreflight(verb, good)).not.toThrow();
	});

	test("non-activation verbs never run the gate", () => {
		assertHubActivationPreflight("render", () => {
			throw new Error("unexpected gate invocation");
		});
	});

	test("graph failure and malformed CLI receipt refuse before compose", () => {
		expect(() =>
			assertHubActivationPreflight("deploy", () => ({
				...good(),
				status: 1,
				stdout: JSON.stringify({
					ok: false,
					mode: "static",
					findings: [{ code: "cycle" }],
					drills: [],
				}),
			})),
		).toThrow("route preflight failed");
		expect(() =>
			assertHubActivationPreflight("up", () => ({
				status: 1,
				stdout: "not JSON",
				stderr: "missing config",
			})),
		).toThrow("missing config");
	});

	test("a live-mode receipt cannot satisfy the first-deploy static gate", () => {
		expect(() =>
			assertHubActivationPreflight("deploy", () => ({
				...good(),
				stdout: JSON.stringify({
					ok: true,
					mode: "live",
					findings: [],
					drills: [{ ok: true }],
				}),
			})),
		).toThrow("route preflight failed");
	});

	test("a zero-exit receipt with a failed drill still refuses activation", () => {
		expect(() =>
			assertHubActivationPreflight("deploy", () => ({
				...good(),
				stdout: JSON.stringify({
					ok: true,
					mode: "static",
					findings: [],
					drills: [{ ok: false }],
				}),
			})),
		).toThrow("route preflight failed");
	});
});
