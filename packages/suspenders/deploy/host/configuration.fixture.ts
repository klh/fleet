/** Test-only private volume provisioning; no config or fixture enters payload. */
export function configurationScript(options: {
	root: string;
	identityUrl: string;
	controlUrl: string;
	guest: string;
	profile: { seedDigest: string; policyDigest: string };
}) {
	const { root, identityUrl, controlUrl, guest, profile } = options;
	const files = [
		[`${root}/seed/marker`, "HOST_FIXTURE_SEED_MARKER"],
		[`${root}/private/owner.key`, "fixture-owner"],
		[`${root}/private/mint.key`, "fixture-mint"],
		[`${root}/private/reader.key`, "fixture-reader"],
		[
			`${root}/private/profiles.json`,
			JSON.stringify({
				standard: {
					version: 1,
					generation: 1,
					kind: "coding",
					...profile,
					provider: "belt",
					model: "fixture",
				},
			}),
		],
		[
			`${root}/private/settings.json`,
			JSON.stringify({
				runner: {
					control_url: controlUrl,
					identity_url: identityUrl,
					credential_file: `${root}/private/owner.key`,
					profiles_file: `${root}/private/profiles.json`,
					state_dir: `${root}/state`,
					desktop: {
						image: guest,
						seed_root: `${root}/seed`,
						mint_credential_file: `${root}/private/mint.key`,
					},
				},
			}),
		],
	];
	return `const fs=require("node:fs");const dirs=${JSON.stringify([root, `${root}/private`, `${root}/seed`, `${root}/state`])};
for(const path of dirs){fs.mkdirSync(path,{recursive:true,mode:0o700});fs.chownSync(path,1000,1000);fs.chmodSync(path,0o700)}
for(const [path,bytes] of ${JSON.stringify(files)}){fs.writeFileSync(path,bytes,{mode:0o600,flag:"wx"});fs.chownSync(path,1000,1000)}
console.log(JSON.stringify({socketGid:fs.statSync("/var/run/docker.sock").gid}));`;
}
