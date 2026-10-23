import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

// W697 (toto-gpt gap 8): container hardening profiles for hub-compose.yaml.
type Svc = Record<string, unknown> & {
	volumes?: unknown[];
	depends_on?: Record<string, { condition: string }>;
	environment?: Record<string, string>;
};
const compose = parse(
	readFileSync(join(import.meta.dir, "../deploy/hub-compose.yaml"), "utf8"),
	{ merge: true },
) as { services: Record<string, Svc> };
const svcs = compose.services;

const RUNTIME = [
	"buckle-hub",
	"buckle-health",
	"buckle-ready",
	"board-hub",
	"board-health",
	"store-hub",
	"store-health",
	"belt-hub",
	"belt-health",
	"model-store-hub",
	"model-store-health",
	"knowledge-sink",
	"knowledge-health",
	"mdns-announce",
	"mdns-health",
	"peer-pull",
];
const BUILD = ["fleet-repo", "fleet-deps"];
const STATEFUL = [
	"buckle-hub",
	"board-hub",
	"store-hub",
	"belt-hub",
	"model-store-hub",
	"knowledge-sink",
	"peer-pull",
];

test("Buckle liveness and route catalog use no inference tokens", () => {
	const liveness = String(svcs["buckle-health"]?.command);
	const readiness = svcs["buckle-ready"]?.command as string[];
	expect(liveness).toContain("/status");
	expect(liveness).not.toContain("/v1/chat/completions");
	expect(readiness.join(" ")).toContain("/v1/models");
	// biome-ignore lint/suspicious/noTemplateCurlyInString: asserts the literal compose placeholder
	expect(readiness).toContain("${HUB_READY_EVERY_MS:-600000}");
	expect(readiness).toContain("--catalog-model");
	expect(readiness).not.toContain("--synthetic-json");
});

test("every service drops all caps and forbids privilege gain", () => {
	for (const [name, s] of Object.entries(svcs)) {
		expect(s.cap_drop, name).toEqual(["ALL"]);
		expect(s.security_opt, name).toContain("no-new-privileges:true");
		expect(s.pids_limit, name).toBeGreaterThan(0);
	}
});

test("runtime services: non-root, read-only rootfs, tmpfs scratch, init, grace", () => {
	for (const name of RUNTIME) {
		const s = svcs[name] as Svc;
		// biome-ignore lint/suspicious/noTemplateCurlyInString: asserts the literal compose placeholder
		expect(s.user, name).toBe("${HUB_RUN_UID:-1000}:${HUB_RUN_GID:-1000}");
		expect(s.read_only, name).toBe(true);
		expect(s.tmpfs, name).toEqual(["/tmp:size=64m,mode=1777"]);
		expect(s.init, name).toBe(true);
		expect(s.stop_grace_period, name).toMatch(/^\d+s$/);
		expect(s.cap_add, name).toBeUndefined();
	}
});

test("build one-shots keep root + writable rootfs but are capless", () => {
	for (const name of BUILD) {
		const s = svcs[name] as Svc;
		expect(s.user, name).toBeUndefined();
		expect(s.read_only, name).toBeUndefined();
		expect(s.stop_grace_period, name).toBeDefined();
	}
});

test("only hub-init holds capabilities, and only chown-class ones", () => {
	const holders = Object.entries(svcs).filter(([, s]) => s.cap_add);
	expect(holders.map(([n]) => n)).toEqual(["hub-init"]);
	expect(svcs["hub-init"]?.cap_add).toEqual([
		"CHOWN",
		"DAC_OVERRIDE",
		"FOWNER",
	]);
});

test("stateful runtime services wait on hub-init; sidecars never hold state", () => {
	for (const name of STATEFUL)
		expect(svcs[name]?.depends_on?.["hub-init"]?.condition, name).toBe(
			"service_completed_successfully",
		);
	for (const name of RUNTIME.filter(
		(n) => n.endsWith("-health") || n.endsWith("-ready"),
	))
		expect(
			(svcs[name]?.volumes ?? []).some((v) => String(v).includes("-state")),
			name,
		).toBe(false);
});

test("writable surface = explicit state mounts; code mounts stay :ro", () => {
	for (const name of RUNTIME) {
		for (const v of svcs[name]?.volumes ?? []) {
			const m = String(v);
			if (m.startsWith("fleet-repo:")) expect(m, name).toEndWith(":ro");
		}
	}
	// hub-init owns exactly the five state volumes it re-owns
	expect(svcs["hub-init"]?.volumes).toEqual([
		"buckle-state:/state/buckle",
		"hub-state:/state/hub-home",
		"hub-secrets:/state/secrets",
		"belt-state:/state/belt-home",
		"model-store:/state/model-store",
	]);
});

test("sidecars get a scratch HOME on tmpfs (rootfs is read-only)", () => {
	for (const name of RUNTIME.filter(
		(n) => n.endsWith("-health") || n.endsWith("-ready"),
	))
		expect(svcs[name]?.environment?.HOME, name).toBe("/tmp");
});

test("buckle-hub grace covers the ledger flush cadence (5s) with headroom", () => {
	const g = Number.parseInt(String(svcs["buckle-hub"]?.stop_grace_period), 10);
	expect(g).toBeGreaterThanOrEqual(20);
});

// W714 (W694 L2): `test -f A && exec bun A || exec bun B` runs B after A
// FAILS (exec replaces the shell, so || sees A's exit code). One boot path,
// chosen by if/else.
test("fleet-deps picks exactly one boot script (no &&/|| double-run)", () => {
	const cmd = String(svcs["fleet-deps"]?.command);
	expect(cmd).toContain("if test -f");
	expect(cmd).not.toMatch(/&& .* \|\|/);
});

test("W689 boot comment is stated once", () => {
	const raw = readFileSync(
		join(import.meta.dir, "../deploy/hub-compose.yaml"),
		"utf8",
	);
	expect(raw.split("boot script installs the pinned checkout").length - 1).toBe(
		1,
	);
});

// W688.3: overlay code-loader knobs ride the .env into the buckle-hub
// container env; empty default = unset = solo posture unchanged.
test("buckle-hub carries the KLH_OVERLAY_* env passthrough", () => {
	const env = svcs["buckle-hub"]?.environment ?? {};
	// biome-ignore lint/suspicious/noTemplateCurlyInString: asserts the literal compose placeholder
	expect(env.KLH_OVERLAY_DIR).toBe("${HUB_KLH_OVERLAY_DIR:-}");
	// biome-ignore lint/suspicious/noTemplateCurlyInString: asserts the literal compose placeholder
	expect(env.KLH_OVERLAY_SHA256).toBe("${HUB_KLH_OVERLAY_SHA256:-}");
	// biome-ignore lint/suspicious/noTemplateCurlyInString: asserts the literal compose placeholder
	expect(env.KLH_OVERLAY_ALLOW).toBe("${HUB_KLH_OVERLAY_ALLOW:-}");
});
