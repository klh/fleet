import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const dir = mkdtempSync(join(tmpdir(), "fleet-hub-layout-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const template = readFileSync(
	join(import.meta.dir, "../deploy/hub-compose.yaml"),
	"utf8",
);
const compose = parse(template);

function render(version?: string, repos?: Record<string, string>) {
	const stack = join(dir, "stack.json");
	writeFileSync(
		stack,
		JSON.stringify({ version, hubs: { test: { host: "localhost", repos } } }),
	);
	const result = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "../deploy/hubctl.ts"),
			"render",
			"test",
		],
		{
			env: { ...process.env, KLH_STACK: stack },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return {
		code: result.exitCode,
		text: result.stdout.toString() + result.stderr.toString(),
	};
}

test("all hub services share one pinned monorepo with prepared dependencies", () => {
	expect(
		Object.keys(compose.services).filter((name) => name.endsWith("-repo")),
	).toEqual(["fleet-repo"]);
	expect(compose.services["fleet-repo"].environment.HUB_FLEET_REF).toContain(
		"HUB_FLEET_REF:?",
	);
	expect(
		compose.services["fleet-repo"].environment.HUB_FLEET_REPO_URL,
	).toContain("klh/fleet.git");
	expect(compose.services["fleet-deps"].command).toContain("--frozen-lockfile");
	// Changing the pinned source must recreate both preparation and runtime
	// containers; dependency ordering alone does not restart an existing app.
	for (const [name, service] of Object.entries(compose.services)) {
		if (name !== "fleet-repo")
			expect(
				(service as { environment: Record<string, string> }).environment
					.FLEET_VERSION,
			).toContain("HUB_FLEET_REF:?");
	}
	for (const name of [
		"buckle-hub",
		"board-hub",
		"store-hub",
		"belt-hub",
		"peer-pull",
	]) {
		expect(compose.services[name].depends_on["fleet-deps"].condition).toBe(
			"service_completed_successfully",
		);
		expect(compose.services[name].volumes).toContain(
			"fleet-repo:/src/fleet:ro",
		);
	}
	// the packages root is config: every runtime path rides HUB_FLEET_SRC
	// (W493) — compose interpolation inlines the default, commands that are
	// argv lists join to one string for the assertion
	const cmd = (name: string): string => {
		const command = compose.services[name].command;
		return Array.isArray(command) ? command.join(" ") : command;
	};
	for (const name of [
		"buckle-health",
		"buckle-ready",
		"board-health",
		"store-health",
		"belt-health",
	])
		expect(cmd(name)).toContain(
			"${HUB_FLEET_SRC:-/src/fleet/packages}/suspenders/deploy/healthcheck/probe.ts",
		);
	expect(compose.services["buckle-hub"].working_dir).toBe(
		"${HUB_FLEET_SRC:-/src/fleet/packages}/buckle",
	);
	expect(compose.services["buckle-hub"].environment.BUCKLE_POLICY).toBe(
		"${HUB_FLEET_SRC:-/src/fleet/packages}/buckle/routing-policy.yaml",
	);
	expect(cmd("board-hub")).toContain(
		"${HUB_FLEET_SRC:-/src/fleet/packages}/suspenders/hooks/bin/fleet-board.ts",
	);
	expect(cmd("belt-hub")).toContain(
		"${HUB_FLEET_SRC:-/src/fleet/packages}/belt/bin/dashboard.ts",
	);
	for (const name of ["buckle-state", "hub-state", "hub-secrets", "belt-state"])
		expect(name in compose.volumes).toBe(true);
});

test("renderer resolves one origin and one version and rejects legacy split sources", () => {
	const rendered = render("reviewed-sha");
	expect(rendered.code).toBe(0);
	expect(rendered.text).toContain("HUB_FLEET_REF=reviewed-sha");
	expect(rendered.text).toContain(
		"HUB_FLEET_REPO_URL=https://github.com/klh/fleet.git",
	);
	expect(rendered.text).not.toContain("HUB_BUCKLE_REF");
	// W493: repos.src renders HUB_FLEET_SRC — the overlay packages root;
	// unset = not emitted, the compose default keeps the public layout
	expect(rendered.text).not.toContain("HUB_FLEET_SRC");
	expect(
		render("reviewed-sha", {
			src: "/src/fleet/node_modules/fleet/packages",
		}).text,
	).toContain("HUB_FLEET_SRC=/src/fleet/node_modules/fleet/packages");
	expect(render("reviewed-sha", { ref: "other-sha" }).code).toBe(1);
	expect(
		render("reviewed-sha", {
			buckle: "https://example.invalid/a",
			belt: "https://example.invalid/b",
		}).code,
	).toBe(1);
	expect(
		render("reviewed-sha", {
			suspenders: "https://github.com/klh/suspenders.git",
		}).code,
	).toBe(1);
	expect(render().code).toBe(1);
	expect(render(undefined, { ref: "hub-only-ref" }).code).toBe(1);
});

test("repo initializer fetches an immutable SHA into a fresh volume and updates it", () => {
	const source = join(dir, "source");
	const target = join(dir, "volume");
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(["git", ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		return result.stdout.toString().trim();
	};
	git("init", source);
	git("-C", source, "config", "user.name", "Fixture");
	git("-C", source, "config", "user.email", "fixture@example.invalid");
	writeFileSync(join(source, "README.md"), "first revision");
	git("-C", source, "add", "README.md");
	git("-C", source, "commit", "-m", "first");
	const first = git("-C", source, "rev-parse", "HEAD");
	writeFileSync(join(source, "README.md"), "reviewed revision");
	git("-C", source, "commit", "-am", "reviewed");
	const second = git("-C", source, "rev-parse", "HEAD");
	const command = compose.services["fleet-repo"].command[0]
		.replaceAll("$$", "$")
		.replaceAll("/srv/repo", target);
	for (const ref of [first, second]) {
		const result = Bun.spawnSync(["sh", "-c", command], {
			env: { ...process.env, HUB_FLEET_REPO_URL: source, HUB_FLEET_REF: ref },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		expect(git("-C", target, "rev-parse", "HEAD")).toBe(ref);
	}
	expect(readFileSync(join(target, "README.md"), "utf8")).toBe(
		"reviewed revision",
	);
});
