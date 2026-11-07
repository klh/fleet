// test/scratch-world.test.ts — the kit's own suite for scratchWorld():
// dirs real + env pins + hermeticity + clean() teardown.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { scratchWorld } from "../src/scratch-world.ts";

test("scratchWorld: scratch HOME + git-init'ed repo with a baseline commit", () => {
	const w = scratchWorld({ prefix: "kit-probe-" });
	try {
		expect(existsSync(w.home)).toBe(true);
		expect(existsSync(w.repo)).toBe(true);
		expect(basename(w.home).startsWith("kit-probe-home-")).toBe(true);
		expect(basename(w.repo).startsWith("kit-probe-repo-")).toBe(true);
		const head = Bun.spawnSync(
			["git", "-C", w.repo, "rev-parse", "--verify", "HEAD"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(head.exitCode).toBe(0);
	} finally {
		w.clean();
	}
});

test("scratchWorld: env pins (HOME, GIT_CONFIG_GLOBAL/SYSTEM, local store)", () => {
	const w = scratchWorld();
	try {
		expect(w.env.HOME).toBe(w.home);
		expect(w.env.HOME === process.env.HOME).toBe(false);
		expect(w.env.GIT_CONFIG_GLOBAL).toBe(join(w.home, ".gitconfig"));
		expect(w.env.GIT_CONFIG_SYSTEM).toBe(join(w.home, ".gitconfig-system"));
		expect(w.env.GOVERNOR_STORE_URL).toBe("local");
	} finally {
		w.clean();
	}
});

test("scratchWorld: clean() tears both dirs down", () => {
	const w = scratchWorld();
	w.clean();
	expect(existsSync(w.home)).toBe(false);
	expect(existsSync(w.repo)).toBe(false);
	// idempotent — a second clean() must not throw
	w.clean();
});

// W2573: advisory isolation. The ambient env may carry a poisoned kev pin
// (or the machine's live :8912 default applies once HOME moves); the world
// must pin it OFFLINE regardless — the pin rides AFTER the process.env
// spread. Caller overrides are a plain spread over w.env (by construction)
// and are proven against a real stub in the suspenders e2e
// (fixture-kev-isolation.e2e.ts), not re-asserted here.
test("scratchWorld: kev advisory pinned offline, immune to ambient poisoning", () => {
	const saved = process.env.SUSPENDERS_KEV_URL;
	process.env.SUSPENDERS_KEV_URL = "http://192.0.2.1:8912"; // TEST-NET-1 poison
	try {
		const w = scratchWorld();
		try {
			expect(w.env.SUSPENDERS_KEV_URL).toBe("http://127.0.0.1:9");
		} finally {
			w.clean();
		}
	} finally {
		if (saved === undefined) delete process.env.SUSPENDERS_KEV_URL;
		else process.env.SUSPENDERS_KEV_URL = saved;
	}
});
