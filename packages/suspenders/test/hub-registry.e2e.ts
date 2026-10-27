// test/hub-registry.test.ts — W1256.2: hubs.json is a GENERATED projection
// of the stack config (retires the hand-maintained second registry). Covers
// the projection, the roster-shape migration, the writer (no-stack
// no-touch, 0600), and the cross-package parse contract: the generated file
// must parse as rows for hub-locate.readRegistry AND belt readHubs.
import { expect, test } from "@playwright/test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	hubRegistryFromStack,
	rosterUrlEntries,
	writeHubRegistry,
} from "../hooks/lib/hub/hub-registry.ts";
import { readRegistry } from "../hooks/lib/hub/hub-locate.ts";

const HOME = mkdtempSync(join(tmpdir(), "hub-registry-home-"));
const prevHome = process.env.HOME;
process.env.HOME = HOME;
mkdirSync(join(HOME, ".claude", "local-llm"), { recursive: true });
const file = join(HOME, ".claude", "local-llm", "hubs.json");

test.afterAll(() => {
	process.env.HOME = prevHome;
	rmSync(HOME, { recursive: true, force: true });
});

test.describe("hubRegistryFromStack", () => {
	test("projects url profiles, trims trailing slashes, skips url-less hubs", () => {
		const reg = hubRegistryFromStack({
			hubs: {
				nas: { host: "nas.threads.dk", url: "https://nas.local:4101/" },
				desktop: { host: "desktop", url: "http://127.0.0.1:4111" },
				ghost: { host: "no-url-hub" },
			},
		});
		expect(reg.nas?.candidates).toEqual(["https://nas.local:4101"]);
		expect(reg.desktop?.candidates).toEqual(["http://127.0.0.1:4111"]);
		expect(reg.ghost).toBeUndefined();
		expect(Object.keys(reg)).toEqual(["nas", "desktop"]);
	});

	test("inline stack token wins over token_file content", () => {
		const tf = join(HOME, "token.txt");
		writeFileSync(tf, " file-token \n");
		const reg = hubRegistryFromStack({
			hubs: {
				a: { host: "a", url: "http://a.local:4101", token: "inline" },
				b: { host: "b", url: "http://b.local:4101", token_file: tf },
				c: {
					host: "c",
					url: "http://c.local:4101",
					token_file: join(HOME, "missing"),
				},
			},
		});
		expect(reg.a?.token).toBe("inline");
		expect(reg.b?.token).toBe("file-token");
		expect(reg.c?.token).toBeUndefined();
	});
});

test.describe("rosterUrlEntries", () => {
	test("migrates the W230 roster array url-only", () => {
		const reg = rosterUrlEntries(
			JSON.stringify({
				hubs: [
					{
						name: "nas",
						url: "https://nas.local:4101/",
						token_env: "KLH_HUB_SPOKE_TOKEN",
						dns_entries: ["nas.local"],
					},
					{ url: "http://nameless:1" },
				],
			}),
		);
		expect(reg.nas?.candidates).toEqual(["https://nas.local:4101"]);
		expect(reg.nas?.token).toBeUndefined();
		expect(Object.keys(reg)).toEqual(["nas"]);
	});

	test("map shape and garbage yield no migration entries", () => {
		expect(
			rosterUrlEntries(JSON.stringify({ nas: { candidates: ["x"] } })),
		).toEqual({});
		expect(rosterUrlEntries("not json")).toEqual({});
	});
});

test.describe("writeHubRegistry", () => {
	test("no stack config: file untouched", () => {
		writeFileSync(file, "operator hand config");
		const res = writeHubRegistry(file, null);
		expect(res.status).toBe("absent");
		expect(readFileSync(file, "utf8")).toBe("operator hand config");
	});

	test("stack config: generated map, 0600, roster merged", () => {
		writeFileSync(
			file,
			JSON.stringify({
				hubs: [{ name: "spoke-hub", url: "https://spoke.local:4101" }],
			}),
		);
		const res = writeHubRegistry(file, {
			hubs: { nas: { host: "n", url: "https://nas.local:4101", token: "t" } },
		});
		expect(res.status).toBe("ok");
		expect(res.labels?.sort()).toEqual(["nas", "spoke-hub"]);
		expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
		const parsed = JSON.parse(readFileSync(file, "utf8")) as {
			nas?: { candidates?: string[]; token?: string };
		};
		expect(parsed.nas?.candidates).toEqual(["https://nas.local:4101"]);
		expect(parsed.nas?.token).toBe("t");
	});

	test("cross-package parse contract: readRegistry and belt readHubs both parse", () => {
		chmodSync(file, 0o644); // a 0644 file is re-locked to 0600 on regen
		const res = writeHubRegistry(file, {
			hubs: { nas: { host: "n", url: "https://nas.local:4101" } },
		});
		expect(res.status).toBe("ok");
		expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
		// old keys retire: the previous regen's spoke-hub is gone (stack wins)
		expect(res.labels).toEqual(["nas"]);
		const reg = readRegistry();
		expect(reg.nas?.candidates).toEqual(["https://nas.local:4101"]);
	});

	test("belt readHubs parses the generated file (cross-package contract)", async () => {
		const { readHubs } = await import("../../belt/bin/hubs.ts");
		// regenerate over a fresh roster so two labels coexist
		writeFileSync(
			file,
			JSON.stringify({
				hubs: [{ name: "spoke-hub", url: "https://spoke.local:4101" }],
			}),
		);
		writeHubRegistry(file, {
			hubs: { nas: { host: "n", url: "https://nas.local:4101" } },
		});
		const rows = readHubs(file);
		expect(rows.map((r) => r.label).sort()).toEqual(["nas", "spoke-hub"]);
		expect(rows.every((r) => r.tls)).toBe(true);
	});

	test("unwritable parent reports failed, never throws", () => {
		const blocker = join(HOME, "blocker");
		writeFileSync(blocker, "a file, not a directory");
		const res = writeHubRegistry(join(blocker, "hubs.json"), {
			hubs: {},
		});
		expect(res.status).toBe("failed");
	});
});
