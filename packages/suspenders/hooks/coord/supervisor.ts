// hooks/coord/supervisor.ts — W266.1: `coord supervisor ensure|status`.
// ensure = converge the repo's fleet services onto launchd (rendered via the
// ONE renderer scripts/install-services.ts into a temp dir → LaunchAgents →
// bootstrap → governor.db row). status = the live truth: rows × one
// `launchctl list` probe, matched by realpath repo (projectIdentity
// derivation), foreign-repo rows rendered dim.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { amber, cyan, db, die, dim, green, red } from "./shared.ts";
import {
	canonicalRepo,
	ensureSupervisor,
	listServices,
	liveStates,
	launchctlTable,
	supervisorRows,
} from "../lib/supervisor.ts";

const LAUNCH_AGENTS = `${process.env.HOME ?? ""}/Library/LaunchAgents`;

const usage = (): never =>
	die("usage: coord supervisor ensure [service...] | status [--json]");

// W783: install-services.ts is the ONLY renderer — the hand-written
// hooks/launchd/ templates are gone. The renderer + manifest ride the REPO
// (canonicalRepo of cwd), exactly how install-launchd.ts invokes them; a
// prefix-only install (no checkout) refuses honestly.
const renderUnitsTmp = (repo: string): string => {
	const renderer = join(repo, "scripts", "install-services.ts");
	if (!existsSync(renderer))
		die(
			`supervisor ensure: no renderer at ${renderer} — run from a fleet checkout (renders via install-services.ts, W783)`,
		);
	const dir = mkdtempSync(join(tmpdir(), "coord-supervisor-"));
	spawnRender(repo, dir);
	return dir;
};

function spawnRender(repo: string, dir: string): void {
	const res = Bun.spawnSync(
		[
			process.execPath,
			join(repo, "scripts", "install-services.ts"),
			"--target",
			"darwin",
			"--out",
			dir,
			"--json",
			"--bun",
			Bun.which("bun") ?? process.execPath,
			"--home",
			process.env.HOME ?? "",
			// this module lives at <PREFIX>/coord/ — .. is the install PREFIX
			"--prefix",
			resolve(import.meta.dir, ".."),
			"--repo",
			repo,
		],
		{ cwd: repo, stdout: "pipe", stderr: "pipe" },
	);
	if (res.exitCode !== 0) {
		rmSync(dir, { recursive: true, force: true });
		die(
			`supervisor ensure: render failed: ${res.stderr.toString().slice(-800) || `exit ${res.exitCode}`}`,
		);
	}
}

export async function cmdSupervisor(rest: string[]): Promise<void> {
	const sub = rest[0] ?? "";
	const repo = canonicalRepo(process.cwd());
	if (sub === "ensure") {
		const want = rest.slice(1).filter((s) => !s.startsWith("--"));
		const renderedDir = renderUnitsTmp(repo);
		const services = want.length ? want : listServices(renderedDir);
		if (!services.length) usage();
		if (process.platform !== "darwin")
			die(
				"supervisor ensure: launchd is macOS-only — nothing to converge here",
			);
		let okN = 0;
		const lines: string[] = [];
		for (const s of services) {
			const r = ensureSupervisor({
				db,
				service: s,
				repo,
				launchdDir: renderedDir,
				launchAgentsDir: LAUNCH_AGENTS,
				vars: {},
			});
			if (r.ok) okN++;
			lines.push(r.line);
		}
		rmSync(renderedDir, { recursive: true, force: true });
		console.log(lines.join("\n"));
		console.log(
			dim(
				`${okN}/${services.length} ensured — repo ${repo} · live truth: coord supervisor status`,
			),
		);
		return;
	}
	if (sub === "status") {
		const wantJson = rest.includes("--json");
		const probe = launchctlTable();
		const rows = supervisorRows(db);
		const live = liveStates(rows, probe.table, repo, probe.ok);
		if (wantJson) {
			console.log(
				JSON.stringify({ repo, probeOk: probe.ok, supervisors: live }),
			);
			return;
		}
		console.log(
			`SUPERVISORS  repo=${repo}${probe.ok ? "" : "  (launchd unreachable — states UNKNOWN)"}`,
		);
		if (!rows.length) {
			console.log(
				dim("(no supervision rows — converge with: coord supervisor ensure)"),
			);
			return;
		}
		for (const l of live) {
			const g =
				l.state === "UP"
					? green("▶")
					: l.state === "UNKNOWN"
						? dim("·")
						: red("✗");
			const pid = l.pid ? ` pid ${l.pid}` : "";
			const foreign = l.repoMatch ? "" : amber(" (other repo)");
			console.log(
				`  ${g} ${cyan(l.service.padEnd(16))} ${l.state.padEnd(11)}${pid}${foreign}`,
			);
		}
		return;
	}
	usage();
}
