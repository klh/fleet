// test/fixtures/kev-stub-start.ts — spawn kev-stub.ts and resolve its URL.
// D7 made a missing Kev verdict defer instead of store, so suites asserting
// a harvested answer need a Kev that answers (see kev-stub.ts).
import { join } from "node:path";

export async function startKevStub(
	choice = "store",
): Promise<{ url: string; stop: () => void }> {
	const proc = Bun.spawn(["bun", join(import.meta.dir, "kev-stub.ts")], {
		env: { ...process.env, KEV_STUB_CHOICE: choice },
		stdout: "pipe",
		stderr: "ignore",
	});
	const reader = proc.stdout.getReader();
	const { value } = await reader.read();
	reader.releaseLock();
	const port = Number(new TextDecoder().decode(value).trim());
	if (!port) {
		proc.kill();
		throw new Error("kev stub did not report a port");
	}
	return { url: `http://127.0.0.1:${port}`, stop: () => proc.kill() };
}
