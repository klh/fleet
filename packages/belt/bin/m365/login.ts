// bin/m365/login.ts — one-command owner login for the belt M365 agent (W261).
// Device-code flow: prints the code, waits for approval, banks the tokens in
// the 0600 cache. Run with the owner present (needs a browser).
//   bun packages/belt/bin/m365/login.ts            # interactive login
//   bun packages/belt/bin/m365/login.ts --status   # cache state only
//   bun packages/belt/bin/m365/login.ts --logout   # drop the cached tokens
import {
	awaitDeviceApproval,
	beginDeviceLogin,
	loadEntraConfig,
	logout,
	readTokenCache,
	tokenCachePath,
	writeTokenCache,
} from "./entra-auth.ts";

const env = process.env;
const flag = process.argv.slice(2)[0];

if (flag === "--status") {
	const cfg = loadEntraConfig(env);
	if (!cfg) {
		console.log("not configured: set M365_TENANT_ID + M365_CLIENT_ID");
		process.exit(0);
	}
	const cached = readTokenCache(tokenCachePath(env));
	if (!cached) {
		console.log("no cached tokens — run without flags to log in");
		process.exit(0);
	}
	const valid = cached.expiresAt > Date.now();
	console.log(
		`cached seat: ${cached.username ?? "unknown user"} · access ${valid ? "valid" : "expired"}${cached.refreshToken ? " · refresh token present" : ""}`,
	);
	process.exit(0);
}

if (flag === "--logout") {
	console.log(
		logout(tokenCachePath(env)) ? "token cache dropped" : "no token cache",
	);
	process.exit(0);
}

const cfg = loadEntraConfig(env);
if (!cfg) {
	console.error(
		"m365 login: set M365_TENANT_ID + M365_CLIENT_ID in the belt env (0600) first",
	);
	process.exit(1);
}

const begun = await beginDeviceLogin(cfg);
console.log(
	`\nOpen ${begun.verificationUri} and enter code: ${begun.userCode}\n`,
);
const tokens = await awaitDeviceApproval(cfg, begun, {
	onPrompt: () => console.log("waiting for approval..."),
});
writeTokenCache(tokenCachePath(env), tokens);
console.log(
	`logged in as ${tokens.username ?? "unknown"} — tokens cached 0600`,
);
