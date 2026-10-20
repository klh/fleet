// W371 — hubTargets heal wiring: a hubs.json label with a stack.yaml profile
// declaring deploy.dir carries heal + quietHours + the hub bind budget;
// profile-less or stack-less machines stay probe-only (W351 unchanged).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubConsoleLinks, hubGatewayRoutes, hubTargets } from "../bin/hubs.ts";

const dir = mkdtempSync(join(tmpdir(), "w371t-"));
const stackPath = join(dir, "stack.yaml");
const hubsPath = join(dir, "hubs.json");
afterAll(() => {
	delete process.env.KLH_STACK;
	delete process.env.SUSPENDERS_HUBS_FILE;
	rmSync(dir, { recursive: true, force: true });
});

const STACK = `version: 0000000000000000000000000000000000000001
hubs:
  nas:
    host: nas.example.lan
    display_name: Lab NAS
    console_url: https://nas.example.lan/board
    url: http://nas.example.lan:4101
    deploy:
      ssh: kk@nas.example.lan
      dir: /volume1/hub
      docker: /usr/local/bin/docker
    upstreams:
      groups:
        sample-model:
          - url: https://models.example.org
            model: sample-model
`;

writeFileSync(stackPath, STACK);
process.env.KLH_STACK = stackPath;

writeFileSync(
	hubsPath,
	JSON.stringify({
		nas: { candidates: ["http://nas.example.lan:4101"] },
		DECOY: { candidates: ["https://decoy.example.lan"] },
	}),
);
process.env.SUSPENDERS_HUBS_FILE = hubsPath;

describe("hubTargets heal wiring", () => {
	test("gateway models come from each registered hub profile", () => {
		expect(hubGatewayRoutes()).toEqual([
			{
				name: "nas",
				models: ["sample-model"],
				providerHosts: ["models.example.org"],
				providerHostsByModel: { "sample-model": ["models.example.org"] },
			},
			{
				name: "DECOY",
				models: [],
				providerHosts: [],
				providerHostsByModel: {},
			},
		]);
	});
	test("stack console URL joins the registered hub without using the probe URL", () => {
		expect(hubConsoleLinks()).toEqual([
			{ name: "nas", url: "https://nas.example.lan/board" },
		]);
	});
	test("profile join is case-insensitive; heal row carries heal + quietHours", () => {
		const row = hubTargets().find((r) => r.name === "nas");
		expect(row?.heal).toBeInstanceOf(Function);
		expect(row?.quietHours).toBeInstanceOf(Function);
		expect(row?.bindTimeoutMs).toBe(90_000);
		expect(row?.displayName).toBe("Lab NAS");
	});

	test("profile-less row stays probe-only", () => {
		const row = hubTargets().find((r) => r.name === "DECOY");
		expect(row?.heal).toBeUndefined();
		expect(row?.quietHours).toBeUndefined();
	});

	test("missing stack.yaml → all rows probe-only", () => {
		process.env.KLH_STACK = join(dir, "absent.yaml");
		const rows = hubTargets();
		expect(rows.every((r) => r.heal === undefined)).toBe(true);
		process.env.KLH_STACK = stackPath;
	});
});
