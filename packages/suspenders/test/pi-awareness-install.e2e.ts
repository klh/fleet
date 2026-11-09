import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";

test("Pi awareness install bundles for Node, stays private/idempotent and preserves edits @unit", async () => {
	const { installPiAwareness } = await import(
		"../scripts/install/install-pi-awareness.ts"
	);
	const world = scratchWorld({ prefix: "pi-install-" });
	const piHome = join(world.home, ".pi/agent"),
		entry = join(piHome, "extensions/fleet-awareness/index.js");
	try {
		expect((await installPiAwareness({ home: world.home })).status).toBe(
			"skipped",
		);
		mkdirSync(piHome, { recursive: true });
		expect(
			(await installPiAwareness({ home: world.home, dryRun: true })).status,
		).toBe("planned");
		expect(existsSync(entry)).toBe(false);
		expect((await installPiAwareness({ home: world.home })).action).toBe(
			"synced",
		);
		expect(statSync(entry).mode & 0o777).toBe(0o600);
		expect(readFileSync(entry, "utf8")).not.toContain("bun:sqlite");
		const before = statSync(entry).mtimeMs;
		expect((await installPiAwareness({ home: world.home })).action).toBe(
			"current",
		);
		expect(statSync(entry).mtimeMs).toBe(before);
		appendFileSync(entry, "\n// user edit\n");
		expect((await installPiAwareness({ home: world.home })).status).toBe(
			"conflict",
		);
		expect(readFileSync(entry, "utf8")).toContain("// user edit");
	} finally {
		world.clean();
	}
});

test("Pi install preserves incompatible SDKs and unmanaged extension files @unit", async () => {
	const { installPiAwareness } = await import(
		"../scripts/install/install-pi-awareness.ts"
	);
	const world = scratchWorld({ prefix: "pi-install-conflict-" });
	const piHome = join(world.home, ".pi/agent"),
		dir = join(piHome, "extensions/fleet-awareness");
	try {
		mkdirSync(join(piHome, "install"), { recursive: true });
		await Bun.write(join(piHome, "install/current-version"), "9.9.9");
		expect((await installPiAwareness({ home: world.home })).status).toBe(
			"conflict",
		);
		expect(existsSync(join(dir, "index.js"))).toBe(false);
		await Bun.write(join(piHome, "install/current-version"), "1.5.0");
		mkdirSync(dir, { recursive: true });
		await Bun.write(join(dir, "index.ts"), "// existing extension");
		expect((await installPiAwareness({ home: world.home })).status).toBe(
			"conflict",
		);
		expect(readFileSync(join(dir, "index.ts"), "utf8")).toBe(
			"// existing extension",
		);
	} finally {
		world.clean();
	}
});

test("Pi install preserves dangling user symlinks and predicts conflicts in dry-run @unit", async () => {
	const { symlinkSync, lstatSync } = await import("node:fs");
	const { installPiAwareness } = await import(
		"../scripts/install/install-pi-awareness.ts"
	);
	const world = scratchWorld({ prefix: "pi-dangling-" });
	const dir = join(world.home, ".pi/agent/extensions/fleet-awareness"),
		entry = join(dir, "index.js");
	try {
		mkdirSync(dir, { recursive: true });
		symlinkSync(join(world.home, "missing-user-target"), entry);
		expect(
			(await installPiAwareness({ home: world.home, dryRun: true })).status,
		).toBe("conflict");
		expect((await installPiAwareness({ home: world.home })).status).toBe(
			"conflict",
		);
		expect(lstatSync(entry).isSymbolicLink()).toBe(true);
	} finally {
		world.clean();
	}
});
