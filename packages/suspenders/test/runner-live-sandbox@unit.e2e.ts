import { test } from "@playwright/test";
import { DESKTOP_RUNNER_IMAGE } from "../hooks/lib/runners/desktop/prereqs.ts";
import { checkDesktopImage } from "../hooks/lib/runners/service/desktop-preflight.ts";
import { runSandboxCanary } from "./runner-live-sandbox.fixture.ts";

test("runner HTTP admission executes a seeded sandbox tool using only its minted key", async () => {
	test.setTimeout(55_000);
	const imageId = await checkDesktopImage(DESKTOP_RUNNER_IMAGE).catch(
		() => null,
	);
	test.skip(!imageId, "Pinned native runner image must already be present");
	await runSandboxCanary();
});
