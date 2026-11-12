import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { loadInputs } from "./cli.ts";
import { fixture, request } from "./test-fixture.ts";

test("CLI binds actual artifact bytes and rejects symlink/missing/changed evidence before registry access @unit", async () => {
	const world = scratchWorld();
	try {
		const f = fixture();
		f.acceptance[0].completedAt = new Date(Date.now() - 1000).toISOString();
		const files = {
			request: join(world.home, "request.json"),
			acceptance: join(world.home, "acceptance.json"),
			artifacts: join(world.home, "artifacts.json"),
		};
		await Bun.write(files.request, JSON.stringify(request));
		await Bun.write(files.acceptance, JSON.stringify(f.acceptance));
		await Bun.write(join(world.home, "closure.json"), f.closure);
		await Bun.write(join(world.home, "report.json"), f.report);
		await Bun.write(
			files.artifacts,
			JSON.stringify([
				{
					platform: "linux/arm64",
					closure: "closure.json",
					report: "report.json",
				},
			]),
		);
		expect(
			(await loadInputs(files.request, files.acceptance, files.artifacts))
				.artifacts,
		).toHaveLength(1);
		await Bun.write(join(world.home, "report.json"), "{}");
		await expect(
			loadInputs(files.request, files.acceptance, files.artifacts),
		).rejects.toThrow("artifact bytes mismatch");
		const linked = join(world.home, "linked.json");
		await symlink(files.request, linked);
		await expect(
			loadInputs(linked, files.acceptance, files.artifacts),
		).rejects.toThrow();
		await expect(
			loadInputs(join(world.home, "absent"), files.acceptance, files.artifacts),
		).rejects.toThrow();
	} finally {
		world.clean();
	}
});
