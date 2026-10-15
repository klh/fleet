// .w282-round.ts — W282 round launcher: one arena variant per invocation.
// Keys are read from the machine env files and passed via process env —
// never printed, never logged (config-over-code).
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.HOME ?? homedir();
const LOG = "/tmp/w282-matrix.log";
const mark = (s: string) =>
	appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`);

const litellmKey = (
	await Bun.file(`${HOME}/.claude/local-llm/litellm.key`).text()
).trim();
const remotes = await Bun.file(`${HOME}/.claude/local-llm/remotes.json`).json();
let zai: string | undefined;
for (const mv of Object.values(remotes.machines ?? {})) {
	for (const e of mv.endpoints ?? []) {
		if (e.api_key_env === "Z_AI_API_KEY" && e.api_key) zai = e.api_key;
	}
	if (zai) break;
}
if (!litellmKey || !zai) {
	mark(`FATAL keys missing LITELLM_KEY=${!!litellmKey} ZAI=${!!zai}`);
	process.exit(2);
}

const [, , label, ...args] = process.argv;
if (!label || args.length === 0) {
	console.error("usage: bun .w282-round.ts <label> [run.ts args...]");
	process.exit(1);
}
mark(`START ${label}`);
const p = Bun.spawnSync(["bun", join(import.meta.dir, "run.ts"), ...args], {
	cwd: import.meta.dir,
	env: { ...process.env, LITELLM_KEY: litellmKey, ZAI_API_KEY: zai },
	stdio: ["ignore", "inherit", "inherit"],
});
mark(`EXIT ${p.exitCode} ${label}`);
process.exit(p.exitCode ?? 1);
