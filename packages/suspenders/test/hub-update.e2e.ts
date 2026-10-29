import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	StackConfigSchema,
	type StackConfig,
} from "../hooks/lib/stack-config.ts";
import {
	applyRelease,
	automaticUpdatePolicy,
	checkDue,
	compareReleaseTags,
	hubDeployRef,
	latestReleaseTag,
	notifyAvailable,
	pinnedOverlayRef,
	publishedRelease,
	releaseAvailable,
	releaseOriginOf,
	stackAtRelease,
	updateRows,
	withUpdateLock,
} from "../deploy/hub-update.ts";

const stack = (): StackConfig => ({
	version: "v2.0.4",
	updates: { mode: "manual" },
	hubs: {
		nas: {
			host: "nas.invalid",
			deploy: { dir: "/srv/nas" },
			repos: { ref: "v2.0.4" },
		},
		desktop: {
			host: "desktop.invalid",
			deploy: { dir: "/srv/desktop" },
			repos: { ref: "v2.0.4" },
		},
		canary: {
			host: "canary.invalid",
			version_override: "v2.0.3",
			deploy: { dir: "/srv/canary" },
			repos: { ref: "v2.0.3" },
		},
	},
});

test("stable release discovery ignores branches, pre-releases and peeled refs @unit", () => {
	const refs = [
		"a refs/tags/v2.0.4",
		"b refs/tags/v2.0.10",
		"c refs/tags/v2.1.0-rc.1",
		"d refs/tags/v2.0.11^{}",
		"e refs/heads/v9.0.0",
		"f refs/tags/v2.1.0",
	].join("\n");
	expect(latestReleaseTag(refs)).toBe("v2.1.0");
	expect(compareReleaseTags("v2.1.0", "v2.0.10")).toBeGreaterThan(0);
	expect(releaseAvailable("v3.0.0", "v2.1.0")).toBe(false);
});

test("auto-update is an explicit, validated machine setting @unit", () => {
	expect(
		StackConfigSchema.safeParse({ hubs: {}, updates: { mode: "latest" } })
			.success,
	).toBe(true);
	expect(
		StackConfigSchema.safeParse({ hubs: {}, updates: { mode: "manual" } })
			.success,
	).toBe(true);
	expect(
		StackConfigSchema.safeParse({ hubs: {}, updates: { mode: "unstable" } })
			.success,
	).toBe(false);
	expect(
		StackConfigSchema.safeParse({
			hubs: {},
			updates: { mode: "latest", check_interval_s: 5 },
		}).success,
	).toBe(false);
	expect(
		StackConfigSchema.safeParse({
			hubs: { alpha: { host: "alpha.invalid", auto_update: true } },
		}).success,
	).toBe(true);
	expect(
		StackConfigSchema.safeParse({
			hubs: { alpha: { host: "alpha.invalid", auto_update: "yes" } },
		}).success,
	).toBe(false);
});

test("per-hub opt-in requires unanimous managed-hub consent @unit", () => {
	const configured = stack();
	expect(automaticUpdatePolicy(configured)).toEqual({
		ready: false,
		blocked: ["nas", "desktop"],
	});
	const nas = configured.hubs.nas;
	const desktop = configured.hubs.desktop;
	if (!nas || !desktop) throw new Error("fixture hubs missing");
	nas.auto_update = true;
	expect(automaticUpdatePolicy(configured)).toEqual({
		ready: false,
		blocked: ["desktop"],
	});
	desktop.auto_update = true;
	expect(automaticUpdatePolicy(configured)).toEqual({
		ready: true,
		blocked: [],
	});
	configured.updates = { mode: "latest" };
	desktop.auto_update = false;
	expect(automaticUpdatePolicy(configured)).toEqual({
		ready: false,
		blocked: ["desktop"],
	});
});

test("release source follows operator config and check cadence @unit", () => {
	const configured = stack();
	configured.updates = {
		mode: "manual",
		origin: "ssh://git.example.invalid/owner/fleet.git",
		check_interval_s: 300,
	};
	expect(releaseOriginOf(configured)).toBe(configured.updates.origin);
	const calls: string[][] = [];
	expect(
		publishedRelease(configured.updates.origin ?? "", (argv) => {
			calls.push(argv);
			return { status: 0, stdout: "a refs/tags/v2.0.5\n", stderr: "" };
		}),
	).toBe("v2.0.5");
	expect(calls[0]).toContain(configured.updates.origin);
	expect(checkDue(1_000_000, 700_001, 300)).toBe(false);
	expect(checkDue(1_000_000, 700_000, 300)).toBe(true);
	expect(checkDue(1_000_000, 1_100_000, 300)).toBe(true);
	const inferred = stack();
	const nas = inferred.hubs.nas;
	const desktop = inferred.hubs.desktop;
	if (!nas || !desktop) throw new Error("fixture hubs missing");
	nas.repos = {
		...nas.repos,
		buckle: "ssh://git.example.invalid/owner/fleet.git",
	};
	desktop.repos = {
		...desktop.repos,
		buckle: "ssh://git.example.invalid/owner/fleet.git",
	};
	expect(releaseOriginOf(inferred)).toBe(
		"ssh://git.example.invalid/owner/fleet.git",
	);
	desktop.repos = {
		...desktop.repos,
		buckle: "ssh://other.example.invalid/owner/fleet.git",
	};
	expect(() => releaseOriginOf(inferred)).toThrow("multiple hub origins");
});

test("credential-bearing origin never enters failure, status JSON, or decision note @unit", () => {
	const secret = "do-not-log-this-token";
	const origin = `https://${secret}@git.example.invalid/owner/fleet.git`;
	const configured = stack();
	configured.updates = { mode: "manual", origin };
	expect(() =>
		publishedRelease(origin, () => ({
			status: 128,
			stdout: "",
			stderr: `fatal: failed ${origin}`,
		})),
	).toThrow("release origin unavailable (git exit 128)");
	try {
		publishedRelease(origin, () => ({
			status: 128,
			stdout: "",
			stderr: `fatal: failed ${origin}`,
		}));
	} catch (error) {
		expect(String(error)).not.toContain(secret);
	}
	expect(
		JSON.stringify(updateRows(configured, "v2.0.5", () => "v2.0.4")),
	).not.toContain(secret);
	const world = scratchWorld({ prefix: "hub-update-redaction-" });
	try {
		const events: string[][] = [];
		notifyAvailable(
			"v2.0.5",
			(argv) => {
				events.push(argv);
				return { status: 0, stdout: "", stderr: "" };
			},
			join(world.home, "notice"),
		);
		expect(JSON.stringify(events)).not.toContain(secret);
	} finally {
		world.clean();
	}
});

test("failed live git query logs no credential-bearing origin @unit", () => {
	const world = scratchWorld({ prefix: "hub-update-git-failure-" });
	try {
		const secret = "never-print-this-secret";
		const path = join(world.home, "stack.json");
		const configured = stack();
		configured.updates = {
			mode: "manual",
			origin: `https://${secret}@127.0.0.1:1/owner/fleet.git`,
		};
		writeFileSync(path, JSON.stringify(configured), { mode: 0o600 });
		const result = spawnSync(
			process.execPath,
			[join(import.meta.dir, "../deploy/hub-update.ts"), "check", "--json"],
			{
				env: { ...process.env, KLH_STACK: path, GIT_TERMINAL_PROMPT: "0" },
				encoding: "utf8",
				timeout: 10_000,
			},
		);
		expect(result.status).toBe(1);
		expect(`${result.stdout}${result.stderr}`).toContain(
			"release origin unavailable",
		);
		expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
	} finally {
		world.clean();
	}
});

test("controller lock refuses an overlapping update and releases after completion @unit", () => {
	const world = scratchWorld({ prefix: "hub-update-lock-" });
	try {
		const path = join(world.home, "update.lock");
		withUpdateLock(() => {
			expect(() => withUpdateLock(() => {}, path)).toThrow("already running");
		}, path);
		expect(withUpdateLock(() => "released", path)).toBe("released");
	} finally {
		world.clean();
	}
});

test("one version updates managed refs and preserves explicit canary @unit", () => {
	const next = stackAtRelease(stack(), "v2.0.5");
	expect(next.version).toBe("v2.0.5");
	expect(next.hubs.nas?.repos?.ref).toBe("v2.0.5");
	expect(next.hubs.desktop?.repos?.ref).toBe("v2.0.5");
	expect(next.hubs.canary?.version_override).toBe("v2.0.3");
	expect(next.hubs.canary?.repos?.ref).toBe("v2.0.3");
	expect(
		updateRows(stack(), "v2.0.5", () => "v2.0.4").map(
			(row) => row.updateAvailable,
		),
	).toEqual([true, true, false]);
	expect(
		updateRows(stack(), "v2.0.5", () => "v2.0.4").map(
			(row) => row.deploymentDrift,
		),
	).toEqual([false, false, true]);
});

test("release-tracking overlay advances its own ref and rolls back on failed health @unit", () => {
	const world = scratchWorld({ prefix: "hub-update-overlay-" });
	try {
		const configured = stack();
		const overlay = configured.hubs.desktop;
		if (!overlay) throw new Error("fixture overlay missing");
		overlay.repos = {
			buckle: "https://git.example.invalid/private/fleet.git",
			ref: "v2.0.4",
		};
		const path = join(world.home, "stack.json");
		const original = `${JSON.stringify(configured, null, 2)}\n`;
		writeFileSync(path, original, { mode: 0o600 });
		expect(hubDeployRef(overlay, configured.version)).toBe("v2.0.4");
		expect(pinnedOverlayRef(overlay, configured.version)).toBe(false);
		expect(stackAtRelease(configured, "v2.0.5").hubs.desktop?.repos?.ref).toBe(
			"v2.0.5",
		);
		const row = updateRows(configured, "v2.0.5", () => "v2.0.4").find(
			(item) => item.hub === "desktop",
		);
		expect(row).toMatchObject({
			pinned: "v2.0.4",
			deploymentDrift: false,
			updateAvailable: true,
			pinnedOverlay: false,
		});
		const calls: string[] = [];
		const results = [true, false, true, true];
		expect(() =>
			applyRelease(configured, "v2.0.5", {
				path,
				installed: () => "v2.0.4",
				quietHours: () => false,
				preflight: (hub, name, version) => {
					calls.push(`preflight:${name}:${hub.repos?.ref ?? ""}:${version}`);
				},
				deployHub: (name, expected) => {
					calls.push(`deploy:${name}:${expected}`);
					return results.shift() ?? false;
				},
			}),
		).toThrow("old pin and hub health restored");
		expect(calls).toContain("preflight:desktop:v2.0.5:v2.0.5");
		expect(calls.filter((call) => call.startsWith("deploy:"))).toEqual([
			"deploy:nas:v2.0.5",
			"deploy:desktop:v2.0.5",
			"deploy:nas:v2.0.4",
			"deploy:desktop:v2.0.4",
		]);
		expect(readFileSync(path, "utf8")).toBe(original);
	} finally {
		world.clean();
	}
});

test("unpublished overlay release tag blocks the shared pin before deployment @unit", () => {
	const world = scratchWorld({ prefix: "hub-update-overlay-preflight-" });
	try {
		const configured = stack();
		const overlay = configured.hubs.desktop;
		if (!overlay) throw new Error("fixture overlay missing");
		overlay.repos = {
			buckle: "https://git.example.invalid/private/fleet.git",
			ref: "v2.0.4",
		};
		const path = join(world.home, "stack.json");
		const original = `${JSON.stringify(configured, null, 2)}\n`;
		writeFileSync(path, original, { mode: 0o600 });
		let deployed = false;
		expect(() =>
			applyRelease(configured, "v2.0.5", {
				path,
				installed: () => "v2.0.4",
				quietHours: () => false,
				preflight: (hub, name) => {
					if (name === "desktop" && hub.repos?.ref === "v2.0.5")
						throw new Error("overlay origin does not serve v2.0.5");
				},
				deployHub: () => {
					deployed = true;
					return true;
				},
			}),
		).toThrow("overlay origin does not serve v2.0.5");
		expect(deployed).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(original);
	} finally {
		world.clean();
	}
});

test("independent overlay SHA remains pinned while release-tracking hubs advance @unit", () => {
	const world = scratchWorld({ prefix: "hub-update-overlay-sha-" });
	try {
		const configured = stack();
		const overlay = configured.hubs.desktop;
		if (!overlay) throw new Error("fixture overlay missing");
		const sha = "a".repeat(40);
		overlay.repos = {
			buckle: "https://git.example.invalid/private/fleet.git",
			ref: sha,
		};
		const path = join(world.home, "stack.json");
		writeFileSync(path, `${JSON.stringify(configured, null, 2)}\n`, {
			mode: 0o600,
		});
		expect(pinnedOverlayRef(overlay, configured.version)).toBe(true);
		expect(stackAtRelease(configured, "v2.0.5").hubs.desktop?.repos?.ref).toBe(
			sha,
		);
		const row = updateRows(configured, "v2.0.5", (hub) =>
			hub === overlay ? sha : (hub.version_override ?? "v2.0.4"),
		).find((item) => item.hub === "desktop");
		expect(row).toMatchObject({
			pinned: sha,
			deploymentDrift: false,
			updateAvailable: false,
			pinnedOverlay: true,
		});
		const deployed: string[] = [];
		applyRelease(configured, "v2.0.5", {
			path,
			installed: (hub) => (hub === overlay ? sha : "v2.0.4"),
			quietHours: () => false,
			preflight: () => {},
			deployHub: (name, expected) => {
				deployed.push(`${name}:${expected}`);
				return true;
			},
		});
		expect(deployed).toEqual(["nas:v2.0.5"]);
		const saved = JSON.parse(readFileSync(path, "utf8")) as StackConfig;
		expect(saved.version).toBe("v2.0.5");
		expect(saved.hubs.desktop?.repos?.ref).toBe(sha);
	} finally {
		world.clean();
	}
});

test("failed hub health restores the old pin and deploys it to every managed hub @unit", () => {
	const world = scratchWorld({ prefix: "hub-update-" });
	try {
		const path = join(world.home, "stack.json");
		const original = `${JSON.stringify(stack(), null, 2)}\n`;
		writeFileSync(path, original, { mode: 0o600 });
		const calls: string[] = [];
		const results = [true, false, true, true];
		expect(() =>
			applyRelease(stack(), "v2.0.5", {
				path,
				installed: () => "v2.0.4",
				quietHours: () => false,
				preflight: (_hub, name, version) => {
					calls.push(`preflight:${name}:${version}`);
				},
				deployHub: (name, version) => {
					calls.push(`deploy:${name}:${version}`);
					return results.shift() ?? false;
				},
			}),
		).toThrow("old pin and hub health restored");
		expect(readFileSync(path, "utf8")).toBe(original);
		expect(calls).toContain("preflight:canary:v2.0.3");
		expect(calls.filter((call) => call.startsWith("deploy:"))).toEqual([
			"deploy:nas:v2.0.5",
			"deploy:desktop:v2.0.5",
			"deploy:nas:v2.0.4",
			"deploy:desktop:v2.0.4",
		]);
	} finally {
		world.clean();
	}
});

test("unserved candidate fails before any pin change or deploy @unit", () => {
	const world = scratchWorld({ prefix: "hub-update-preflight-" });
	try {
		const path = join(world.home, "stack.json");
		const original = `${JSON.stringify(stack(), null, 2)}\n`;
		writeFileSync(path, original, { mode: 0o600 });
		let deployed = false;
		expect(() =>
			applyRelease(stack(), "v2.0.5", {
				path,
				installed: () => "v2.0.4",
				quietHours: () => false,
				preflight: () => {
					throw new Error("origin does not serve the release");
				},
				deployHub: () => {
					deployed = true;
					return true;
				},
			}),
		).toThrow("origin does not serve the release");
		expect(deployed).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(original);
	} finally {
		world.clean();
	}
});

test("every configured hub origin is checked before changing the shared pin @unit", () => {
	const world = scratchWorld({ prefix: "hub-update-origins-" });
	try {
		const path = join(world.home, "stack.json");
		const original = `${JSON.stringify(stack(), null, 2)}\n`;
		writeFileSync(path, original, { mode: 0o600 });
		const checked: string[] = [];
		let deployed = false;
		expect(() =>
			applyRelease(stack(), "v2.0.5", {
				path,
				installed: () => "v2.0.4",
				quietHours: () => false,
				preflight: (_hub, name) => {
					checked.push(name);
					if (name === "desktop")
						throw new Error("candidate absent on desktop origin");
				},
				deployHub: () => {
					deployed = true;
					return true;
				},
			}),
		).toThrow("candidate absent on desktop origin");
		expect(checked).toEqual(["nas", "desktop"]);
		expect(deployed).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(original);
	} finally {
		world.clean();
	}
});

test("a hub behind its current pin blocks an upgrade before config changes @unit", () => {
	const world = scratchWorld({ prefix: "hub-update-drift-" });
	try {
		const path = join(world.home, "stack.json");
		const original = `${JSON.stringify(stack(), null, 2)}\n`;
		writeFileSync(path, original, { mode: 0o600 });
		expect(() =>
			applyRelease(stack(), "v2.0.5", {
				path,
				installed: () => "v2.0.3",
				quietHours: () => false,
				preflight: () => {},
				deployHub: () => true,
			}),
		).toThrow("repair deployment drift before upgrading");
		expect(readFileSync(path, "utf8")).toBe(original);
	} finally {
		world.clean();
	}
});

test("manual update notice is emitted once per release @unit", () => {
	const world = scratchWorld({ prefix: "hub-update-notice-" });
	try {
		const marker = join(world.home, "cache", "last-notified");
		const events: string[][] = [];
		const run = (argv: string[]) => {
			events.push(argv);
			return { status: 0, stdout: "", stderr: "" };
		};
		notifyAvailable("v2.0.5", run, marker);
		notifyAvailable("v2.0.5", run, marker);
		expect(events).toHaveLength(1);
		expect(events[0]).toContain("NEED_DECISION");
		expect(readFileSync(marker, "utf8").trim()).toBe("v2.0.5");
	} finally {
		world.clean();
	}
});
