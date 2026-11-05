// test/azure-upstreams.e2e.ts — W2759 proof for the Azure OpenAI upstream
// template (upstreams.azure.json, the IKEA Azure hub): every row rides the
// tier-2 azure-openai adapter with a resource endpoint URL, a named
// Entra client-credentials config (secret = env NAME, never a value), and
// no placeholder leaking a real credential. The template is data — the
// proof pins its shape through the real loadUpstreams validation path.
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { AZURE_OPENAI } from "../src/adapters/azure-openai.ts";
import { loadUpstreams } from "../src/upstreams.ts";

test.describe("@unit", () => {
	const fixture = join(import.meta.dir, "../upstreams.azure.json");

	test.describe("Azure OpenAI upstream template", () => {
		test("every group routes through the azure-openai adapter with Entra auth by env name", () => {
			const pool = loadUpstreams(fixture);
			const groups = pool.groups();
			expect(groups.length).toBeGreaterThanOrEqual(2);
			for (const group of groups) {
				const [deployment] = pool.deployments(group);
				expect(deployment, group).toBeDefined();
				expect(deployment.adapter).toBe("azure-openai");
				expect(deployment.dialect).toBe("openai");
				expect(deployment.url).toMatch(
					/^https:\/\/[\w-]+\.openai\.azure\.com$/,
				);
				// adapter_config is the azure profile: deployment + api_version +
				// entra { tenant_id, client_id, client_secret_env } — the secret
				// is an env var NAME, never a value in the template.
				const cfg = deployment.adapter_config as {
					deployment: string;
					api_version: string;
					entra: {
						tenant_id: string;
						client_id: string;
						client_secret_env: string;
					};
				};
				expect(cfg.deployment?.length, group).toBeGreaterThan(0);
				expect(cfg.api_version?.length, group).toBeGreaterThan(0);
				expect(cfg.entra?.client_secret_env, group).toBe(
					"AZURE_ENTRA_CLIENT_SECRET",
				);
				// no raw secret material rides the template
				expect(JSON.stringify(cfg)).not.toMatch(
					/(sk-[A-Za-z0-9]|Bearer [A-Za-z0-9._-]{20,})/,
				);
				expect(deployment.model?.length, group).toBeGreaterThan(0);
				// the template ships placeholders only — real values are machine
				// stack.json config, never committed
				expect(deployment.url).toContain("REPLACE_ME");
			}
		});

		test("placeholder template rows stay inert: no api_key_env, entra names the secret channel", () => {
			const pool = loadUpstreams(fixture);
			for (const group of pool.groups()) {
				const [deployment] = pool.deployments(group);
				// the placeholder rows carry no key-based auth: Entra is the
				// posture; an operator swapping to key auth adds api_key_env in
				// machine config
				expect(deployment.api_key_env, group).toBeUndefined();
			}
		});

		test("the adapter family resolves (registry law: azure-openai is tier-2 registered)", () => {
			expect(AZURE_OPENAI.family).toBe("azure-openai");
			expect(AZURE_OPENAI.dialect).toBe("openai");
		});
	});
});
