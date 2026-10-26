// hooks/lib/lanes/file-lock.ts — W1124.13: the one cross-process registry lock,
// extracted from lane-registry.ts so the Stop decision path serializes on
// the same primitive (no second lock implementation). mkdir-atomic,
// owner.json discloses the pid; fn's return value passes through and the
// lock is always released.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class FileLockUnavailable extends Error {}

export function withFileLock<T>(file: string, fn: (file: string) => T): T {
	const lock = `${file}.lock`;
	mkdirSync(dirname(file), { recursive: true });
	const deadline = Date.now() + 5000;
	for (;;) {
		try {
			mkdirSync(lock);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline)
				throw new FileLockUnavailable(
					`Lane registry lock unavailable: ${lock}; inspect its owner before recovery`,
				);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
		}
	}
	try {
		writeFileSync(
			join(lock, "owner.json"),
			JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
			{ mode: 0o600 },
		);
		return fn(file);
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}
