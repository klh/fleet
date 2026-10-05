// hooks/lib/secrets-home.ts — the sanctioned secrets home resolver (W165:
// lifted out of lib/auth.ts so the client-side credential presenter
// (auth-client.ts) can live on spoke installs that ship no auth/issuance
// modules — the spoke still stores its enrollment token HERE, mode 600).
// Env read is LIVE every call — bun caches os.homedir() at process start, so
// runtime HOME mutation does NOT move this; the env override does.
import { homedir } from "node:os";
import { join } from "node:path";

export function secretsHome(): string {
	return (
		process.env.BUCKLE_SECRETS_HOME ?? join(homedir(), ".claude", "local-llm")
	);
}
