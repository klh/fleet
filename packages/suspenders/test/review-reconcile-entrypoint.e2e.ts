import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { ENTRYPOINTS } from "../scripts/sync-harness.ts";

test("installed review-reconcile maintenance entrypoint resolves", async () => {
	const build = await Bun.build({
		entrypoints: [join(import.meta.dir, "../hooks/bin/review-reconcile.ts")],
		target: "bun",
		write: false,
		throw: false,
	});
	expect(build.success).toBe(true);
	expect(ENTRYPOINTS).toContain("hooks/bin/review-reconcile.ts");
});
