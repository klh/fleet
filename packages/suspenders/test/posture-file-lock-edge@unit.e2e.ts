// test/posture-file-lock-edge@unit.e2e.ts — W2197: the post-merge dangling
// path posture/posture.store.ts -> ../file-lock.ts (repaired to
// ../lanes/file-lock.ts). This spec imports the store live so a re-broken
// import path fails loudly here instead of re-banking a dangling-path edge.

import { expect, test } from "@playwright/test";

test("posture.store module loads — its file-lock import resolves", async () => {
	const store = await import("../hooks/lib/posture/posture.store.ts");
	expect(typeof store.readPostureConfig).toBe("function");
});

test("the file-lock edge points at hooks/lib/lanes/file-lock.ts", async () => {
	const lock = await import("../hooks/lib/lanes/file-lock.ts");
	expect(typeof lock.withFileLock).toBe("function");
});
