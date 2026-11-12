import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";

test("host admission separates candidate, private oracle and output roots including aliases @unit", async () => {
	const { admitLayout } = await import("../bench/optimize/layout.ts");
	const world = scratchWorld({ prefix: "blam-layout-" });
	const roots = {
		candidateRoot: join(realpathSync(world.home), "candidate"),
		oracleRoot: join(realpathSync(world.home), "oracle"),
		outputRoot: join(realpathSync(world.home), "output"),
	};
	try {
		for (const root of Object.values(roots)) mkdirSync(root, { mode: 0o700 });
		expect(await admitLayout(roots)).toEqual(roots);
		const nested = join(roots.candidateRoot, "results");
		mkdirSync(nested, { mode: 0o700 });
		await expect(admitLayout({ ...roots, outputRoot: nested })).rejects.toThrow(
			"disjoint",
		);
		const alias = join(world.home, "oracle-alias");
		symlinkSync(roots.oracleRoot, alias);
		await expect(admitLayout({ ...roots, outputRoot: alias })).rejects.toThrow(
			"disjoint",
		);
		const hiddenAlias = join(roots.candidateRoot, "oracle-link");
		symlinkSync(roots.oracleRoot, hiddenAlias);
		await expect(
			admitLayout({ ...roots, oracleRoot: hiddenAlias }),
		).rejects.toThrow("disjoint");
	} finally {
		world.clean();
	}
});
