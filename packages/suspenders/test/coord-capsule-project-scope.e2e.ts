// test/coord-capsule-project-scope.test.ts — W687: item capsule facts keys
// are PROJECT-SCOPED (work.capsule.<sha256(project)>.<item>). Item ids are
// per-project sequences, so the old global work.<id>.capsule made two
// projects' same-numbered items serve each other's hand-off (the W318
// family). Two real git repos, one governor.db, the SAME minted id: every
// reader resolves the identity from its own cwd and lands on its own row.
// Temp-HOME spawn recipe per lane-completion.test.ts; never touches a real
// governor.db.
import { afterAll, expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test.describe({ tag: "@unit" }, () => {

const root = mkdtempSync(join(tmpdir(), "fleet-capsule-scope-"));
const home = join(root, "home");
mkdirSync(home);
const env = { ...process.env, HOME: home, GOVERNOR_STORE_URL: "" };
const hooks = join(import.meta.dir, "../hooks");
afterAll(() => rmSync(root, { recursive: true, force: true }));

function repo(name: string) {
	const dir = join(root, name);
	mkdirSync(dir);
	const git = (...args: string[]) => {
		const p = Bun.spawnSync(["git", ...args], {
			cwd: dir,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		return p.exitCode === 0 ? p.stdout.toString().trim() : p.stderr.toString();
	};
	git("init", "-q");
	git("config", "user.email", "test@example.invalid");
	git("config", "user.name", "test");
	writeFileSync(join(dir, "README.md"), `${name}\n`);
	git("add", "README.md");
	git("commit", "-qm", "base");
	const cli = (bin: string, ...args: string[]) => {
		const p = Bun.spawnSync(
			[process.execPath, join(hooks, "bin", bin), ...args],
			{ cwd: dir, env, stdout: "pipe", stderr: "pipe" },
		);
		return {
			code: p.exitCode,
			out: p.stdout.toString(),
			err: p.stderr.toString(),
		};
	};
	const addItem = (title: string) =>
		cli("work.ts", "add", title).out.match(/W\d+/)?.[0] ?? "";
	return { dir, cli, addItem };
}

const alpha = repo("alpha");
const beta = repo("beta");

test("the same minted item id in two projects serves two distinct capsules", () => {
	const a = alpha.addItem("collision probe");
	const b = beta.addItem("collision probe");
	// the hazard itself: per-project sequences mint the SAME id
	expect(a).toBeTruthy();
	expect(a).toBe(b);
	expect(
		alpha.cli(
			"coord.ts",
			"capsule",
			"set",
			"--as",
			"lane-a",
			"--item",
			a,
			"--checkpoint=none",
			"--done=alpha capsule",
			"--next=alpha next",
		).code,
	).toBe(0);
	expect(
		beta.cli(
			"coord.ts",
			"capsule",
			"set",
			"--as",
			"lane-b",
			"--item",
			b,
			"--checkpoint=none",
			"--done=beta capsule",
			"--next=beta next",
		).code,
	).toBe(0);
	// get --item reads the caller's own project capsule
	const ga = JSON.parse(
		alpha.cli("coord.ts", "capsule", "get", "--item", a).out.trim(),
	);
	const gb = JSON.parse(
		beta.cli("coord.ts", "capsule", "get", "--item", b).out.trim(),
	);
	expect(ga.done).toBe("alpha capsule");
	expect(gb.done).toBe("beta capsule");
	expect(ga.item).toBe(a);
	expect(gb.item).toBe(b);
});

test("work show --json serves the caller's project capsule, never the collision", () => {
	const a = alpha.addItem("show probe");
	const b = beta.addItem("show probe");
	expect(a).toBe(b);
	// alpha banks; beta banks nothing on its same-numbered item
	expect(
		alpha.cli(
			"coord.ts",
			"capsule",
			"set",
			"--as",
			"lane-a",
			"--item",
			a,
			"--checkpoint=none",
			"--done=alpha show capsule",
		).code,
	).toBe(0);
	const ra = JSON.parse(alpha.cli("work.ts", "show", a, "--json").out) as {
		capsule?: { done?: string } | null;
	};
	const rb = JSON.parse(beta.cli("work.ts", "show", b, "--json").out) as {
		capsule?: { done?: string } | null;
	};
	expect(ra.capsule?.done).toBe("alpha show capsule");
	// pre-fix this read alpha's capsule across the project boundary
	expect(rb.capsule).toBeNull();
});

});
