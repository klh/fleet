import { describe, expect, test } from "bun:test";
import { composeLogsArgv, composeUpArgv } from "../deploy/hub-remote.ts";
import type { HubProfile } from "../deploy/hub-remote.ts";

const hub = (extra: Partial<HubProfile> = {}): HubProfile =>
	({
		name: "desktop",
		deploy: { dir: "/tmp/hub-x", docker: "docker", ...extra.deploy },
	}) as HubProfile;

describe("composeLogsArgv", () => {
	test("local hub: sh -c docker compose logs --tail", () => {
		const argv = composeLogsArgv(hub(), "buckle-hub", 40);
		expect(argv).toEqual([
			"/bin/sh",
			"-c",
			'docker compose -f "/tmp/hub-x/hub-compose.yaml" --project-directory "/tmp/hub-x" logs --tail 40 "buckle-hub"',
		]);
	});

	test("ssh hub: ssh-wrapped, same script shape", () => {
		const argv = composeLogsArgv(
			hub({ deploy: { dir: "/tmp/hub-x", ssh: "kk@nas" } }),
			undefined,
			80,
		);
		expect(argv[0]).toBe("ssh");
		expect(argv.at(-1)).toContain('logs --tail 80');
		expect(argv.at(-1)).not.toContain('"undefined"');
	});

	test("no deploy.dir throws (declared-dir gate)", () => {
		expect(() => composeLogsArgv({} as HubProfile, "x", 10)).toThrow(
			/deploy\.dir/,
		);
	});

	test("composeUpArgv unchanged (belt hub-heal byte-identical law)", () => {
		const argv = composeUpArgv(hub());
		expect(argv.at(-1)).toContain(" up -d");
	});
});
