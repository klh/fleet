// W371 — hub-remote primitives + heal mechanics: composeUpArgv shapes
// (ssh-wrapped vs local), hubHeal runs the argv bounded (echo/false as the
// configured docker binary — no real docker in tests).
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeUpArgv, sshOpts } from "../../suspenders/deploy/hub-remote.ts";
import { hubHeal } from "../bin/hubs.ts";
import type { HubProfile } from "../../suspenders/hooks/lib/stack-config.ts";

const dir = mkdtempSync(join(tmpdir(), "w371-"));
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NAS: HubProfile = {
	host: "nas.example.lan",
	deploy: {
		ssh: "kk@nas.example.lan",
		dir: "/volume1/hub",
		docker: "/usr/local/bin/docker",
		connect_timeout: 5,
	},
};

const LOCAL: HubProfile = {
	host: "127.0.0.1",
	deploy: { dir: "/tmp/hub" },
};

test.describe("composeUpArgv", () => {
	test("remote hub → ssh-wrapped, script as one argv element @unit", () => {
		expect(composeUpArgv(NAS)).toEqual([
			"ssh",
			"-o",
			"ConnectTimeout=5",
			"-o",
			"BatchMode=yes",
			"kk@nas.example.lan",
			`/usr/local/bin/docker compose -f "/volume1/hub/hub-compose.yaml" --project-directory "/volume1/hub" up -d`,
		]);
	});

	test("local hub → /bin/sh -c, direct argv @unit", () => {
		expect(composeUpArgv(LOCAL)).toEqual([
			"/bin/sh",
			"-c",
			`docker compose -f "/tmp/hub/hub-compose.yaml" --project-directory "/tmp/hub" up -d`,
		]);
	});

	test("no deploy.dir → throws (nothing to compose up) @unit", () => {
		expect(() => composeUpArgv({ host: "x" })).toThrow(/deploy\.dir/);
	});

	test("connect_timeout unset → 10s @unit", () => {
		expect(sshOpts(LOCAL)).toEqual([
			"-o",
			"ConnectTimeout=10",
			"-o",
			"BatchMode=yes",
		]);
	});
});

test.describe("hubHeal", () => {
	test("clean run (echo as docker) → null @unit", async () => {
		const heal = hubHeal({
			...LOCAL,
			deploy: { dir: "/tmp/hub", docker: "echo" },
		});
		expect(await heal()).toBeNull();
	});

	test("failing compose (false binary) → bounded failure note @unit", async () => {
		const heal = hubHeal({
			...LOCAL,
			deploy: { dir: "/tmp/hub", docker: "false" },
		} satisfies HubProfile);
		const note = await heal();
		expect(note).toContain("compose up exit 1");
	});
});
