// test/starter-distribution.test.ts — W458.2: registry authorization,
// revocation, hub replication. Covered: fail-closed grants, promote/revoke
// authority checks, revocation beats the local copy (exact + all-versions),
// write-once replication both directions, revocation merge dedupe, hub-side
// refusal of revoked bytes, corrupt-source refusal, dir-level inventory.
import { expect, test } from "@playwright/test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendRevocation,
	pullFromDir,
	promoteStarter,
	readGrants,
	readRollbacks,
	readStarterAuthorized,
	readRevocations,
	replicateToDir,
	rollbackStarter,
	starterAuthzFile,
	writeGrants,
} from "../hooks/lib/starter/starter-distribution.ts";
import {
	listStartersIn,
	starterRegistryDir,
} from "../hooks/lib/starter/starter-artifacts.ts";

const scratch = (): string => mkdtempSync(join(tmpdir(), "w4582t-"));

const statModeOf = (path: string): number => statSync(path).mode;

const base = () => ({
	id: "fleet-orientation",
	version: 1,
	createdAt: "2026-10-11T00:00:00.000Z",
	instructions: "Repo law + fleet protocol. Acknowledge with READY.",
	skillVersions: {},
	findings: ["finding.w454"],
	sourceRevision: "7a411950011223344556648899aabbccddeeff0",
	compatibility: { harnesses: ["claude"], models: ["glm-5.3-flash"] },
	provenance: {
		authorSid: "autow458-1",
		promotedBy: "autow458-5",
		evalRef: "blam://starter-eval/v1",
	},
	evals: [{ name: "smoke", passed: true, at: "2026-10-11T00:00:00.000Z" }],
});

test.describe("starter-distribution: grants", () => {
	const repo = scratch();
	test.afterEach(() => {
		rmSync(join(repo, ".fleet"), { recursive: true, force: true });
	});

	test("fail-closed: no authz file = nobody holds authority", () => {
		expect(readGrants(repo)).toEqual({
			promoters: [],
			revokers: [],
			readers: [],
		});
	});

	test("write + read roundtrip, 0600", () => {
		writeGrants(repo, { promoters: ["lane-a"], revokers: ["lane-b"] });
		expect(readGrants(repo).promoters).toEqual(["lane-a"]);
		const mode = statModeOf(starterAuthzFile(repo));
		expect(mode & 0o777).toBe(0o600);
	});

	test("corrupt authz file reads as empty (fail-closed)", () => {
		writeGrants(repo, { promoters: ["lane-a"], revokers: [] });
		writeFileSync(starterAuthzFile(repo), "{corrupt");
		expect(readGrants(repo)).toEqual({
			promoters: [],
			revokers: [],
			readers: [],
		});
	});
});
test.describe("starter-distribution: promotion authority", () => {
	const repo = scratch();
	test.afterEach(() => {
		rmSync(join(repo, ".fleet"), { recursive: true, force: true });
	});

	test("unauthorized promote refused, authorized lands the artifact", () => {
		expect(() => promoteStarter(repo, "lane-x", base())).toThrow(
			/no promote grant/,
		);
		writeGrants(repo, { promoters: ["lane-x"], revokers: [] });
		const put = promoteStarter(repo, "lane-x", base());
		expect(put.duplicate).toBe(false);
		expect(put.digest).toHaveLength(64);
	});

	test("empty-promoters grants stay fail-closed at promote time", () => {
		const other = scratch();
		writeGrants(other, { promoters: [], revokers: ["someone"] });
		expect(() => promoteStarter(other, "someone", base())).toThrow(
			/no promote grant/,
		);
		rmSync(other, { recursive: true, force: true });
	});
});
test.describe("starter-distribution: revocation", () => {
	const repo = scratch();
	test.afterEach(() => {
		rmSync(join(repo, ".fleet"), { recursive: true, force: true });
	});

	test("append needs a revoker grant", () => {
		expect(() =>
			appendRevocation(repo, "nobody", {
				id: "fleet-orientation",
				version: 1,
				reason: "r",
			}),
		).toThrow(/no revoke grant/);
	});

	test("rows mint at/by registry-side; exact version, sibling survives", () => {
		writeGrants(repo, { promoters: ["p"], revokers: ["rev-lane"] });
		const v1 = base();
		v1.version = 1;
		const v2 = base();
		v2.version = 2;
		promoteStarter(repo, "p", v1);
		promoteStarter(repo, "p", v2);
		const row = appendRevocation(repo, "rev-lane", {
			id: "fleet-orientation",
			version: 1,
			reason: "eval regression",
		});
		expect(row.at).toBeTruthy();
		expect(row.by).toBe("rev-lane");
		expect(readRevocations(repo)).toHaveLength(1);
		const r1 = readStarterAuthorized(repo, "fleet-orientation", 1);
		expect(r1.ok).toBe(false);
		expect(r1.revoked).toBeTruthy();
		const r2 = readStarterAuthorized(repo, "fleet-orientation", 2);
		expect(r2.ok).toBe(true);
		const all = appendRevocation(repo, "rev-lane", {
			id: "fleet-orientation",
			reason: "whole starter pulled",
		});
		expect(all.version).toBeNull();
		const r3 = readStarterAuthorized(repo, "fleet-orientation", 2);
		expect(r3.ok).toBe(false);
		expect(r3.revoked).toBeTruthy();
	});
});
test.describe("starter-distribution: replication bytes", () => {
	const repo = scratch();
	const hub = scratch();
	test.afterEach(() => {
		rmSync(join(repo, ".fleet"), { recursive: true, force: true });
		rmSync(join(hub, ".fleet"), { recursive: true, force: true });
	});

	test("ship + pull keep bytes identical; re-ship is idempotent", () => {
		writeGrants(repo, { promoters: ["p"], revokers: ["rev-lane"] });
		promoteStarter(repo, "p", base());
		const mirror = join(repo, "hub-mirror");
		const ship1 = replicateToDir(repo, mirror);
		expect(ship1.rows[0].status).toBe("wrote");
		const ship2 = replicateToDir(repo, mirror);
		expect(ship2.rows[0].status).toBe("duplicate");
		const pulled = pullFromDir(hub, mirror);
		expect(pulled.rows[0].status).toBe("wrote");
		const localBytes = readFileSync(
			join(repo, ".fleet", "starter-registry", "fleet-orientation", "v1.json"),
		);
		const hubBytes = readFileSync(
			join(hub, ".fleet", "starter-registry", "fleet-orientation", "v1.json"),
		);
		expect(hubBytes.equals(localBytes)).toBe(true);
	});

	test("conflicting bytes at the target are refused", () => {
		writeGrants(repo, { promoters: ["p"], revokers: [] });
		promoteStarter(repo, "p", base());
		const mirror = join(repo, "hub-mirror");
		replicateToDir(repo, mirror);
		const targetFile = join(mirror, "fleet-orientation", "v1.json");
		writeFileSync(
			targetFile,
			'{"id":"fleet-orientation","version":1,"tampered":true}',
		);
		expect(() => replicateToDir(repo, mirror)).toThrow(/different bytes/);
	});
});
test.describe("starter-distribution: revocation distribution", () => {
	const repo = scratch();
	const hub = scratch();
	test.afterEach(() => {
		rmSync(join(repo, ".fleet"), { recursive: true, force: true });
		rmSync(join(hub, ".fleet"), { recursive: true, force: true });
	});

	test("revocations merge with dedupe; hub refuses revoked bytes", () => {
		writeGrants(repo, { promoters: ["p"], revokers: ["rev-lane"] });
		promoteStarter(repo, "p", base());
		const mirror = join(repo, "hub-mirror-2");
		replicateToDir(repo, mirror);
		appendRevocation(repo, "rev-lane", {
			id: "fleet-orientation",
			reason: "pulled",
		});
		const ship = replicateToDir(repo, mirror);
		expect(ship.revocations).toBe(1);
		const ship2 = replicateToDir(repo, mirror);
		expect(ship2.revocations).toBe(0);
		pullFromDir(hub, mirror);
		const hubRead = readStarterAuthorized(hub, "fleet-orientation");
		expect(hubRead.ok).toBe(false);
		expect(hubRead.revoked).toBeTruthy();
	});

	test("corrupt source rows are never replicated", () => {
		writeGrants(repo, { promoters: ["p"], revokers: [] });
		promoteStarter(repo, "p", base());
		const mirror = join(repo, "hub-mirror-3");
		replicateToDir(repo, mirror);
		const art = join(mirror, "fleet-orientation", "v1.json");
		writeFileSync(art, "{scrambled");
		const pulled = pullFromDir(hub, mirror);
		expect(pulled.rows[0].status).toBe("refused-corrupt-source");
	});
});
test.describe("starter-distribution: inventory", () => {
	test("dir-level listing skips non-id files", () => {
		const repo = scratch();
		writeGrants(repo, { promoters: ["p"], revokers: [] });
		promoteStarter(repo, "p", base());
		const rows = listStartersIn(starterRegistryDir(repo));
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe("fleet-orientation");
		expect(rows[0].corrupt).toBeUndefined();
	});
});
test.describe("starter-distribution: rollback execution", () => {
	const repo = scratch();
	test.afterEach(() => {
		rmSync(join(repo, ".fleet"), { recursive: true, force: true });
	});

	test("rollback revokes the bad version and records the pointer", () => {
		writeGrants(repo, { promoters: ["p"], revokers: ["rev-lane"] });
		const v1 = base();
		promoteStarter(repo, "p", v1);
		const v2 = base();
		v2.version = 2;
		v2.instructions = "v2 wording — the bad promotion";
		promoteStarter(repo, "p", v2);
		const rec = rollbackStarter(
			repo,
			"rev-lane",
			{
				starter: "fleet-orientation",
				from: 2,
				fromDigest: "dig-2",
				to: 1,
				toDigest: v1.digest,
			},
			"eval regression",
		);
		expect(rec.to).toBe(1);
		expect(rec.by).toBe("rev-lane");
		expect(readRollbacks(repo)).toHaveLength(1);
		const bad = readStarterAuthorized(repo, "fleet-orientation", 2);
		expect(bad.ok).toBe(false);
		if (!bad.ok && "revoked" in bad) expect(bad.revoked).toMatch(/rollback/);
		const good = readStarterAuthorized(repo, "fleet-orientation", 1);
		expect(good.ok).toBe(true);
	});

	test("rollback needs the revoke grant", () => {
		writeGrants(repo, { promoters: ["p"], revokers: [] });
		expect(() =>
			rollbackStarter(
				repo,
				"p",
				{ starter: "s", from: 2, fromDigest: "d2", to: 1, toDigest: "d1" },
				"r",
			),
		).toThrow(/no revoke grant/);
	});
});
