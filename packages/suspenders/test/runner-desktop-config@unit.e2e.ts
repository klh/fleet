import { expect, test } from "@playwright/test";
import { RunnerSettingsSchema } from "@klh/settings";
import { scratchWorld } from "@klh/test-kit";
import { chmod, link, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadDesktopRuntimeConfig } from "../hooks/lib/runners/service/desktop-config.ts";

test("desktop runner requires explicit private seed and separate mint credential @unit", async () => {
	const world = scratchWorld();
	try {
		const seedRoot = join(world.home, "seeds");
		const mintFile = join(world.home, "mint.key");
		const controlFile = join(world.home, "control.key");
		const config = RunnerSettingsSchema.parse({
			credential_file: controlFile,
			desktop: {
				image: `oven/bun@sha256:${"a".repeat(64)}`,
				seed_root: seedRoot,
				mint_credential_file: mintFile,
			},
		});
		await expect(
			loadDesktopRuntimeConfig({ ...config, desktop: undefined }),
		).rejects.toThrow("desktop_opt_in_required");
		await mkdir(seedRoot, { mode: 0o700 });
		await writeFile(mintFile, "fixture-mint-key", { mode: 0o600 });
		expect(await loadDesktopRuntimeConfig(config)).toMatchObject({
			seedRoot,
			adminKey: "fixture-mint-key",
		});
		await chmod(seedRoot, 0o755);
		await expect(loadDesktopRuntimeConfig(config)).rejects.toThrow(
			"private_seed_root_required",
		);
		await chmod(seedRoot, 0o700);
		await expect(
			loadDesktopRuntimeConfig({ ...config, credential_file: mintFile }),
		).rejects.toThrow("separate_mint_credential_required");
		await link(mintFile, controlFile);
		await expect(loadDesktopRuntimeConfig(config)).rejects.toThrow(
			"separate_mint_credential_required",
		);
	} finally {
		world.clean();
	}
});
