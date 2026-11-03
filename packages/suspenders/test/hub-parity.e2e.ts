// test/hub-parity.e2e.ts — W2595 cross-hub same-body parity matrix.
// The pure verdict layer (classification + divergence + render) is tested
// here against synthetic rows; the hub-side exec leg (mint 120s lane key,
// POST /v1/messages) is exercised against a fake curl via /bin/sh,
// proving the script reads the root key on-device, extracts the minted
// key, and answers only the HTTP status.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	classifyParityAnswer,
	PARITY_PROBES,
	parityDiverges,
	renderParityMatrix,
} from "../deploy/hub-parity.ts";
import { probeHubMessages } from "../deploy/hub-parity-probe.ts";
import type { ServiceKeyRunner } from "../deploy/service-key.ts";
import type { HubProfile } from "../hooks/lib/stack-config.ts";

test.describe("parity verdict layer @unit", () => {
	test("classify: 2xx pass, 400/422 strip, everything else error", () => {
		expect(classifyParityAnswer(200)).toBe("pass");
		expect(classifyParityAnswer(204)).toBe("pass");
		expect(classifyParityAnswer(400)).toBe("strip");
		expect(classifyParityAnswer(422)).toBe("strip");
		expect(classifyParityAnswer(401)).toBe("error");
		expect(classifyParityAnswer(403)).toBe("error");
		expect(classifyParityAnswer(429)).toBe("error");
		expect(classifyParityAnswer(500)).toBe("error");
	});

	test("divergence: same body must get the same verdict on every hub", () => {
		expect(
			parityDiverges([
				{ hub: "a", probe: "p1", verdict: "pass" },
				{ hub: "b", probe: "p1", verdict: "pass" },
			]),
		).toBe(false);
		expect(
			parityDiverges([
				{ hub: "a", probe: "p1", verdict: "pass" },
				{ hub: "b", probe: "p1", verdict: "strip" },
			]),
		).toBe(true);
		// error/unreachable rows carry no parity signal — never diverge alone
		expect(
			parityDiverges([
				{ hub: "a", probe: "p1", verdict: "pass" },
				{ hub: "b", probe: "p1", verdict: "error" },
			]),
		).toBe(false);
	});

	test("probes: the deny-list body and its clean twin are both present", () => {
		expect(PARITY_PROBES).toHaveLength(2);
		const deny = PARITY_PROBES.find((p) => p.id.includes("denylist"));
		const clean = PARITY_PROBES.find((p) => p.id.includes("clean"));
		expect(deny?.body.thinking).toBeDefined();
		expect(deny?.body.reasoning_effort).toBe("low");
		expect(clean?.body.thinking).toBeUndefined();
		expect(deny?.body.model).toBe(clean?.body.model);
	});

	test("render names the divergence with the offending rows", () => {
		const text = renderParityMatrix([
			{ hub: "a", probe: "p1", verdict: "pass", detail: "HTTP 200" },
			{ hub: "b", probe: "p1", verdict: "strip", detail: "HTTP 400" },
		]);
		expect(text).toContain("✓ a p1 → pass (HTTP 200)");
		expect(text).toContain("− b p1 → strip (HTTP 400)");
		expect(text).toContain("PARITY DIVERGENCE");
	});
});

test.describe("hub-side probe leg @unit", () => {
	const dir = mkdtempSync(join(tmpdir(), "hub-parity-"));
	test.afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const NL = String.fromCharCode(10);

	// fake curl: the admin/keys mint answers bksk_ JSON; every other call
	// (the /v1/messages probe) answers the bare status line
	const curl = join(dir, "curl");
	writeFileSync(
		curl,
		[
			"#!/bin/sh",
			'for a in "$@"; do',
			'  case "$a" in',
			'    *admin/keys*) echo "{\\"key_id\\":\\"k1\\",\\"key\\":\\"bksk_fake_key\\"}"; exit 0;;',
			"  esac",
			"done",
			"echo 200",
		].join(NL),
		{ mode: 0o755 },
	);
	const rootPath = join(dir, "root.env");
	writeFileSync(rootPath, `BUCKLE_ROOT_KEY=rootsecret${NL}`, { mode: 0o600 });

	const hub = {
		buckle_port: 14399,
		secrets: { buckle_root_key: rootPath },
	} as unknown as HubProfile;

	const runner: ServiceKeyRunner = (
		_hub: HubProfile,
		script: string,
		opts?: { input?: string },
	) => {
		const r = spawnSync("/bin/sh", ["-c", script], {
			encoding: "utf8",
			env: { PATH: `${dir}:/usr/bin:/bin` },
			input: opts?.input ?? "",
		});
		if (r.status !== 0)
			throw new Error(r.stderr || `probe script exit ${r.status}`);
		return r.stdout;
	};

	test("mints on-hub, POSTs the body, answers the bare HTTP status", () => {
		expect(
			probeHubMessages(runner, hub, "test", {
				model: "claude-sonnet-5",
				messages: [{ role: "user", content: "ok" }],
			}),
		).toBe(200);
	});

	test("refuses a hub without buckle_port/root credential (fail loud)", () => {
		const bare = { secrets: {} } as unknown as HubProfile;
		expect(() => probeHubMessages(runner, bare, "test", {})).toThrow(
			"buckle_port + secrets.buckle_root_key",
		);
	});

	test("the minted key value never rides the script argv", () => {
		let seen = "";
		const argvRunner: ServiceKeyRunner = (_h, script) => {
			seen = script;
			return `200${NL}`;
		};
		probeHubMessages(argvRunner, hub, "test", {});
		expect(seen).not.toContain("bksk_");
		expect(seen).toContain(rootPath);
	});
});
