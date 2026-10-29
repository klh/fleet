// test/fixtures/kev-stub-start.ts — spawn kev-stub.ts and resolve its URL.
// D7 made a missing Kev verdict defer instead of store, so suites asserting
// a harvested answer need a Kev that answers (see kev-stub.ts).
// The stub reports its port on stdout AND (when KEV_STUB_PORT_FILE is set)
// to an env-named file — the file is the reliable channel: playwright
// workers swallow child stdout through every fd form tried.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function startKevStub(
	choice = "store",
): Promise<{ url: string; stop: () => void }> {
	const dir = mkdtempSync(join(tmpdir(), "kev-stub-"));
	const portFile = join(dir, "port");
	const proc = spawn(process.execPath, [join(import.meta.dir, "kev-stub.ts")], {
		env: {
			...process.env,
			KEV_STUB_CHOICE: choice,
			KEV_STUB_PORT_FILE: portFile,
		},
		stdio: ["ignore", "ignore", "ignore"],
	});
	let port = 0;
	for (let i = 0; i < 50 && !port; i++) {
		await new Promise((r) => setTimeout(r, 100));
		try {
			port = Number(readFileSync(portFile, "utf8").trim()) || 0;
		} catch {
			// not written yet
		}
	}
	rmSync(dir, { recursive: true, force: true });
	if (!port) {
		proc.kill();
		throw new Error("kev stub did not report a port");
	}
	return { url: `http://127.0.0.1:${port}`, stop: () => proc.kill() };
}
