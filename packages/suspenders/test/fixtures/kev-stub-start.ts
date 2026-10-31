// test/fixtures/kev-stub-start.ts — spawn kev-stub.ts and resolve its URL.
// D7 made a missing Kev verdict defer instead of store, so suites asserting
// a harvested answer need a Kev that answers (see kev-stub.ts).
// W2224: playwright workers break child stdout PIPES — the first read
// resolves empty here while the identical spawn reads fine from a plain
// bun process — so the stub stdout/stderr ride a temp-file fd and the
// port line is polled from that file. The child env also carries
// NO_COLOR: workers set FORCE_COLOR, which colors the port line and
// turns the Number() parse into NaN.
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function startKevStub(
	choice = "store",
): Promise<{ url: string; stop: () => void }> {
	const dir = mkdtempSync(join(tmpdir(), "kev-stub-start-"));
	const outFile = join(dir, "port.txt");
	const fd = openSync(outFile, "w+");
	const proc = Bun.spawn(["bun", join(import.meta.dir, "kev-stub.ts")], {
		env: { ...process.env, KEV_STUB_CHOICE: choice, NO_COLOR: "1" },
		stdout: fd,
		stderr: fd,
	});
	const deadline = Date.now() + 5000;
	for (;;) {
		const text = readFileSync(outFile, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
		const port = Number(text.trim().split("\n")[0]);
		if (port) {
			return {
				url: `http://127.0.0.1:${port}`,
				stop: () => {
					proc.kill();
					rmSync(dir, { recursive: true, force: true });
				},
			};
		}
		if (Date.now() > deadline) break;
		await Bun.sleep(25);
	}
	proc.kill();
	rmSync(dir, { recursive: true, force: true });
	throw new Error("kev stub did not report a port");
}
