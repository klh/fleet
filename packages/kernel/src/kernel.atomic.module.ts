// kernel.atomic.module.ts — the ONE atomic-0600 write pair. Canonicalized
// from the proven instances (board-config.ts atomicWrite, export-go-gate.ts
// modeIs0600); the ~35 hand-rolled atomic-0600 write pairs across the stack
// migrate onto this per the W1254 scope. Kernel imports nothing in fleet.
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** True when a mode's permission bits are exactly owner-rw (0600). */
export const modeIs0600 = (mode: number): boolean => (mode & 0o777) === 0o600;

// Atomic 0600 write: temp file in the SAME directory (rename is same-fs
// atomic) then rename over the target. The 0600 mode is enforced twice —
// umask can weaken the writeFileSync mode bit, so chmod re-asserts it before
// the rename (the belt/buckle secrets never land world-readable).
export function atomicWrite0600(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}
