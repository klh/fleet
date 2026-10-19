// W552.6: policy-bridge smoke test — ensure a bridge on 8878 serves the pinned
// manifest, then leave no owned process behind (the owner starts the real one).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const kit = "/Volumes/Sensitive/github/klh/fleet/.fleet/demos/ikea-recording";
const take = join(kit, "take-7-single");
const manifest = readFileSync(join(take, "nas-policy-manifest.json"), "utf8");
const pinned = JSON.parse(manifest).sha256;

const probe = async (): Promise<string | null> => {
	try {
		const res = await fetch("http://127.0.0.1:8878/repo-policy/manifest", {
			signal: AbortSignal.timeout(3000),
		});
		return res.status === 200 ? await res.text() : `HTTP ${res.status}`;
	} catch {
		return null;
	}
};

let body = await probe();
let spawned: Bun.Subprocess | null = null;
if (body === null) {
	spawned = Bun.spawn(["bun", join(kit, "live-kit.ts"), "policy-bridge"], {
		env: { ...process.env, FLEET_DEMO_TAKE: "take-7-single" },
		stdout: "pipe",
		stderr: "pipe",
	});
	for (let i = 0; i < 20 && body === null; i++) {
		await new Promise((r) => setTimeout(r, 250));
		body = await probe();
	}
}
if (body === null) {
	console.log("bridge: UNREACHABLE after spawn");
	process.exit(1);
}

const servedSha = createHash("sha256")
	.update(JSON.stringify(JSON.parse(body).rows))
	.digest("hex");
console.log(
	JSON.stringify({
		bridge: "reachable",
		servedSha,
		pinned,
		match: servedSha === pinned,
	}),
);

if (spawned) {
	spawned.kill();
	await spawned.exited;
	console.log("smoke bridge stopped (owner starts the real one)");
}
