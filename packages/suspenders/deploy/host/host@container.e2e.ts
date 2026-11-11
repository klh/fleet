import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { command } from "./build.ts";
import { HOST_BUILD_PINS } from "./contract.ts";

test("stable HOST identity survives fresh host-network containers with private state @container", async () => {
	const id = `fleet-host-${randomUUID()}`;
	const names: string[] = [];
	const clean = async () => {
		const results = await Promise.allSettled(
			names.map((name) => command(["docker", "rm", "-f", name])),
		);
		const volume = await Promise.allSettled([
			command(["docker", "volume", "rm", id]),
		]);
		if ([...results, ...volume].some((result) => result.status === "rejected"))
			throw new Error("Owned HOST fixture cleanup failed");
	};
	await command(["docker", "volume", "create", id]);
	const run = async (args: string[]) => {
		const name = `${id}-${names.length}`;
		names.push(name);
		return command(["docker", "run", "--name", name, ...args]);
	};
	try {
		await run([
			"--network",
			"none",
			"--user",
			"0:0",
			"--mount",
			`type=volume,source=${id},target=/state`,
			"--entrypoint",
			"bun",
			HOST_BUILD_PINS.bun,
			"-e",
			'const fs=require("node:fs");fs.chownSync("/state",1000,1000);fs.chmodSync("/state",0o700)',
		]);
		const script =
			'const fs=require("node:fs"),os=require("node:os");const p="/state/identity.json",host=os.hostname();if(fs.existsSync(p)){if(JSON.parse(fs.readFileSync(p,"utf8")).host!==host)throw Error("fixture.identity_changed")}else fs.writeFileSync(p,JSON.stringify({host}),{mode:0o600,flag:"wx"});console.log(JSON.stringify({host,uid:process.getuid(),private:(fs.statSync(p).mode&0o777)===0o600}))';
		const args = [
			"--network",
			"host",
			"--hostname",
			id,
			"--user",
			"1000:1000",
			"--read-only",
			"--cap-drop=ALL",
			"--security-opt=no-new-privileges",
			"--mount",
			`type=volume,source=${id},target=/state`,
			"--entrypoint",
			"bun",
			HOST_BUILD_PINS.bun,
			"-e",
			script,
		];
		for (let i = 0; i < 2; i++)
			expect(JSON.parse(await run(args))).toEqual({
				host: id,
				uid: 1000,
				private: true,
			});
		const changed = [...args];
		changed[3] = `${id}-changed`;
		await expect(run(changed)).rejects.toThrow("fixture.identity_changed");
	} finally {
		await clean();
	}
});
