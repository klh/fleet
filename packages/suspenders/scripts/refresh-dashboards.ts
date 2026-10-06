// Code-only upgrade: operator config, registry, keys and launchd files stay outside
// the file manifest. The installer is the sole entry point to this sync.
import {
	copyFile,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "../..");
const home = process.env.HOME ?? "";
const prefix =
	process.env.SUSPENDERS_PREFIX ?? `${home}/.claude/hooks/suspenders`;
const belt = `${home}/.claude/local-llm`;
const local = `${home}/.local/klh-local/bin`;
const groups = [
	{
		from: `${root}/belt/bin`,
		to: belt,
		files: [
			"dashboard.ts",
			"dashboard-state.ts",
			"health.ts",
			"remotes.ts",
			"inventory-probe.ts",
			"dashboard-observability.js",
			"klh-theme.ts",
			"vendor/lit.js",
		],
	},
	{
		from: `${root}/local/bin`,
		to: local,
		files: [
			"dashboard.ts",
			"dashboard-health.ts",
			"health.ts",
			"klh-local.ts",
			"dashboard-page.html",
			"klh-theme.ts",
			"vendor/lit-shared.js",
		],
	},
	{
		from: `${root}/suspenders/hooks`,
		to: prefix,
		files: [
			"bin/fleet-board.ts",
			"bin/fleet-board-html.ts",
			"bin/console-html.ts",
			"bin/usage-page-html.ts",
			"bin/usage-seed.ts",
			"lib/theme.ts",
			"lib/service-inventory.ts",
			"lib/recovery-map.ts",
			"lib/usage.ts",
			"lib/usage-provenance.ts",
			"board/routes-data.ts",
			"board/routes-usage.ts",
			"board/routes-observations.ts",
			"board/lane-observations.ts",
			"board/observation-relay.ts",
			"board/data.ts",
			"board/recovery.ts",
			"board/local-swarm.ts",
			"board/service-probe.ts",
			"board/supervisor-snapshot.ts",
			"board/console-view.ts",
			"board-html/body.ts",
			"board-html/core.ts",
			"board-html/activity.ts",
			"board-html/renders.ts",
			"board-html/tabs.ts",
			"board-html/fleet-lane-view.ts",
			"board-html/service-row-model.ts",
			"board-html/klh-service-row.ts",
			"board-html/klh-recovery.ts",
			"board-html/vendor/klh-components.js",
			"board-html/vendor/klh-service-row.js",
			"board-html/vendor/klh-recovery.js",
			"board-html/vendor/lit-shared.js",
		],
	},
];
const files = groups.flatMap((g) =>
	g.files.map((f) => ({ source: join(g.from, f), target: join(g.to, f) })),
);
// Ship one implementation beside each installed consumer; source wrappers
// resolve the workspace package while runtime copies need no monorepo paths.
for (const target of [
	join(belt, "observation.ts"),
	join(local, "observation.ts"),
	join(prefix, "lib/observation.ts"),
])
	files.push({ source: join(root, "local-llm/observation.ts"), target });
files.push({
	source: join(root, "belt/bin/inventory-probe.ts"),
	target: join(prefix, "lib/inventory-probe.ts"),
});
// Split bundles use content hashes once several independent modules are shared.
const vendor = join(root, "suspenders/hooks/board-html/vendor");
const chunks = (await readdir(vendor)).filter(
	(name) => /^lit-[a-z0-9]+\.js$/i.test(name) && name !== "lit-shared.js",
);
if (chunks.length > 20) throw new Error("Unexpected dashboard bundle count");
for (const name of chunks)
	files.push({
		source: join(vendor, name),
		target: join(prefix, "board-html/vendor", name),
	});
for (const entry of [
	`${belt}/dashboard.ts`,
	`${local}/dashboard.ts`,
	`${prefix}/bin/fleet-board.ts`,
]) {
	await stat(entry); // Existing installation required; never bootstrap config here.
}
for (const { source } of files) await stat(source);
if (process.argv.includes("--dry-run")) {
	console.log(
		`Would refresh ${files.length} dashboard code files; no config or processes changed.`,
	);
} else {
	const backups = new Map<string, { data: Buffer; mode: number } | null>();
	try {
		for (const { source, target } of files) {
			let old: { data: Buffer; mode: number } | null = null;
			try {
				old = {
					data: await readFile(target),
					mode: (await stat(target)).mode & 0o777,
				};
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
			}
			backups.set(target, old);
			await mkdir(dirname(target), { recursive: true });
			await copyFile(source, `${target}.refreshing`);
			await rename(`${target}.refreshing`, target);
		}
		for (const entry of [
			`${belt}/dashboard.ts`,
			`${local}/dashboard.ts`,
			`${prefix}/bin/fleet-board.ts`,
		]) {
			const result = await Bun.build({ entrypoints: [entry], target: "bun" });
			if (!result.success) throw new Error(result.logs.map(String).join("\n"));
		}
		console.log(
			`Refreshed ${files.length} dashboard code files. Restart com.belt.dashboard, com.klh-local.dashboard and com.suspenders.board to activate.`,
		);
	} catch (error) {
		for (const [target, old] of backups) {
			if (old) await Bun.write(target, old.data, { mode: old.mode });
			else await rm(target, { force: true });
			await rm(`${target}.refreshing`, { force: true });
		}
		throw error;
	}
}
