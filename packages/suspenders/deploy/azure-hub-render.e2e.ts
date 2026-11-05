// deploy/azure-hub-render.e2e.ts — W2759 proof: the Azure hub example
// (deploy/stack.example.json `azure` profile) is a FIRST-CLASS hub — the
// real schema parses it, and the real renderEnv materializes the Entra
// OIDC block, the litellm compose profile, and the H100 peer edges from
// it. Azure is config-over-code: zero fork of the one compose template.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderEnv } from "./hub-env-render.ts";
import { StackConfigSchema } from "../hooks/lib/stack-config.ts";

const example = JSON.parse(
	readFileSync(join(import.meta.dir, "stack.example.json"), "utf8"),
) as ReturnType<typeof StackConfigSchema.parse>;

const envLine = (env: string, key: string): string | undefined =>
	env
		.split("\n")
		.find((line) => line.startsWith(`${key}=`))
		?.slice(key.length + 1);

test.describe("Azure hub profile render (W2759)", { tag: "@unit" }, () => {
	test("the example validates and the azure profile exists", () => {
		const parsed = StackConfigSchema.safeParse(example);
		expect(parsed.success).toBe(true);
		expect(parsed.success && parsed.data.hubs.azure).toBeDefined();
	});

	test("renderEnv materializes the Entra OIDC gate from auth.oidc", () => {
		const env = renderEnv(
			example.hubs.azure,
			"azure",
			example.auth,
			"v0.0.0-test",
		);
		expect(envLine(env, "HUB_BUCKLE_OIDC_ENFORCED")).toBe("on");
		expect(envLine(env, "HUB_BUCKLE_OIDC_ISSUER")).toBe(
			"https://login.microsoftonline.com/REPLACE_ME_TENANT/v2.0",
		);
		expect(envLine(env, "HUB_BUCKLE_OIDC_AUDIENCE")).toBe(
			"api://REPLACE_ME_APP_ID",
		);
		// auth ON rides the same render (the gate enforces tokens + OIDC)
		expect(envLine(env, "HUB_BUCKLE_AUTH")).toBe("on");
	});

	test("the litellm compose profile + H100 peer edges ride the profile", () => {
		const env = renderEnv(
			example.hubs.azure,
			"azure",
			example.auth,
			"v0.0.0-test",
		);
		expect(envLine(env, "HUB_LITELLM_PORT")).toBe("4100");
		expect(envLine(env, "HUB_LITELLM_HEALTH_PORT")).toBe("4105");
		expect(envLine(env, "COMPOSE_PROFILES")).toBe("litellm");
		expect(envLine(env, "HUB_PEERS")).toBe("h100-1,h100-2,h100-3,h100-4");
		// non-loopback binds are declared hub config (the ACA/VM front)
		expect(envLine(env, "HUB_BUCKLE_BIND")).toBe("0.0.0.0");
		expect(envLine(env, "HUB_READY_MODEL")).toBe("azure-gpt");
	});

	test("the example's azure upstream row is the azure-openai adapter shape", () => {
		const rows = example.hubs.azure.upstreams?.groups?.["azure-gpt"] ?? [];
		expect(rows).toHaveLength(1);
		const row = rows[0] as Record<string, unknown>;
		expect(row.adapter).toBe("azure-openai");
		expect(row.dialect).toBe("openai");
		const cfg = row.adapter_config as {
			deployment: string;
			api_version: string;
			entra: { client_secret_env: string };
		};
		// secrets law: the entra block names an env var; the secret PATH
		// lives in secrets.upstream_keys (hub-side, 0600)
		expect(cfg.entra.client_secret_env).toBe("AZURE_ENTRA_CLIENT_SECRET");
		expect(example.hubs.azure.secrets?.upstream_keys).toMatchObject({
			AZURE_ENTRA_CLIENT_SECRET: "/srv/klh/hub/entra-client.secret",
		});
	});
});
