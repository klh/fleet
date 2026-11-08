import { expect, test } from "@playwright/test";
import { SettingsSchema } from "../src/index.ts";

test("runner control has strict central settings with no embedded credentials", () => {
	const defaults = SettingsSchema.parse({});
	expect(defaults.runner.control_url).toBe("http://127.0.0.1:7810");
	expect(defaults.runner.identity_url).toBe("http://127.0.0.1:4111");
	expect(defaults.runner.credential_file).toBe("~/.config/klh/runner.key");
	expect(defaults.runner.state_dir).toBe("~/.local/state/klh/runners");
	expect(
		SettingsSchema.safeParse({ runner: { api_key: "secret" } }).success,
	).toBe(false);
	expect(
		SettingsSchema.safeParse({ runner: { control_url: "file:///tmp/socket" } })
			.success,
	).toBe(false);
});
