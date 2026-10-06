import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const scratch: string[] = [];
afterEach(() => {
	for (const path of scratch.splice(0))
		rmSync(path, { recursive: true, force: true });
});
test("store binding reads private token files while environment credentials retain precedence", () => {
	const home = mkdtempSync(join(tmpdir(), "consult-token-"));
	scratch.push(home);
	const directory = join(home, ".cache/claude-governor");
	mkdirSync(directory, { recursive: true });
	const tokenFile = join(directory, "store.token");
	writeFileSync(tokenFile, "fixture-file-token", { mode: 0o600 });
	const run = (token = "") =>
		Bun.spawnSync(
			[
				process.execPath,
				"-e",
				`const {resolveStoreHttpBase}=await import(${JSON.stringify(join(import.meta.dir, "../hooks/lib/govdb.ts"))});try{const b=resolveStoreHttpBase();console.log(b?.token===(process.env.GOVERNOR_STORE_TOKEN||"fixture-file-token")?"matched":"mismatch")}catch(e){console.error(e.message);process.exit(1)}`,
			],
			{
				env: {
					...process.env,
					HOME: home,
					GOVERNOR_STORE_URL: "https://store.example.invalid",
					GOVERNOR_STORE_TOKEN: token,
					GOVERNOR_STORE_TOKEN_FILE: "",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
	// Empty explicit path is not configured; remove it so the default can resolve.
	const defaults = () => {
		const env = {
			...process.env,
			HOME: home,
			GOVERNOR_STORE_URL: "https://store.example.invalid",
			GOVERNOR_STORE_TOKEN: "",
		};
		delete env.GOVERNOR_STORE_TOKEN_FILE;
		return env;
	};
	const source = `const {resolveStoreHttpBase}=await import(${JSON.stringify(join(import.meta.dir, "../hooks/lib/govdb.ts"))});try{console.log(resolveStoreHttpBase()?.token==="fixture-file-token")}catch(e){console.error(e.message);process.exit(1)}`;
	let result = Bun.spawnSync([process.execPath, "-e", source], {
		env: defaults(),
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(result.exitCode).toBe(0);
	expect(result.stdout.toString().trim()).toBe("true");
	chmodSync(tokenFile, 0o644);
	result = Bun.spawnSync([process.execPath, "-e", source], {
		env: defaults(),
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(result.exitCode).toBe(1);
	expect(result.stderr.toString()).toContain("private mode 600");
	expect(result.stderr.toString()).not.toContain("fixture-file-token");
	expect(run("fixture-env-token").exitCode).toBe(0);
});
