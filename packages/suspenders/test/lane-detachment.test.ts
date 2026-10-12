import { expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const quote = (value: string) => JSON.stringify(value);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

for (const teardown of [false, true]) {
	test(
		teardown
			? "spawnClaude survives dispatcher process-group teardown"
			: "spawnClaude makes progress after dispatcher exit",
		async () => {
			const directory = mkdtempSync(join(tmpdir(), "fleet-lane-detachment-"));
			try {
				const ready = join(directory, "ready");
				const marker = join(directory, "progress.json");
				const child = join(directory, "child.ts");
				writeFileSync(
					child,
					`await Bun.write(${quote(ready)}, "ready"); await Bun.sleep(400); await Bun.write(${quote(marker)}, JSON.stringify({pid:process.pid, parent:process.ppid})); await Bun.sleep(100);`,
				);
				const executor = join(directory, "executor");
				writeFileSync(
					executor,
					`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(child)}\n`,
				);
				chmodSync(executor, 0o700);
				const launcher = join(directory, "dispatcher.ts");
				const module = join(import.meta.dir, "../scripts/lib/lane.ts");
				writeFileSync(
					launcher,
					`import {spawnClaude} from ${quote(module)}; const proc=spawnClaude({bin:${quote(executor)},prompt:"test only",cwd:${quote(directory)},logFile:${quote(join(directory, "lane.log"))},env:{...process.env},cliArgs:[]}); proc.unref(); const deadline=Date.now()+3000; while (!(await Bun.file(${quote(ready)}).exists())) {if(Date.now()>deadline)throw new Error("child never started"); await Bun.sleep(10);} console.log(JSON.stringify({pid:proc.pid,dispatcher:process.pid})); ${teardown ? 'process.kill(-process.pid, "SIGTERM");' : ""}`,
				);
				const result = Bun.spawnSync([process.execPath, launcher], {
					detached: true,
					stdout: "pipe",
					stderr: "pipe",
				});
				if (!teardown)
					expect(result.exitCode, result.stderr.toString()).toBe(0);
				const launched = JSON.parse(result.stdout.toString());
				const deadline = Date.now() + 3000;
				while (!existsSync(marker) && Date.now() < deadline)
					await Bun.sleep(20);
				expect(
					existsSync(marker),
					existsSync(join(directory, "lane.log"))
						? readFileSync(join(directory, "lane.log"), "utf8")
						: "no log",
				).toBe(true);
				const progress = JSON.parse(readFileSync(marker, "utf8"));
				expect(progress.pid).toBe(launched.pid);
				expect(progress.parent).not.toBe(launched.dispatcher);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
}
