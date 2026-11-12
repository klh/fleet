import { join } from "node:path";
import { chmod, mkdir, symlink } from "node:fs/promises";
import { scratchWorld, runCliAsync } from "@klh/test-kit";
import { expect, test } from "@playwright/test";

for (const label of ["absent", "foreign", "owned"] as const)
	test(`failed Docker create cleanup protects ${label} ownership @unit`, async () => {
		const world = scratchWorld(),
			bin = join(world.home, "bin"),
			created = join(world.home, "volume"),
			removed = join(world.home, "removed");
		const id = "fleet-host-runtime-00000000-0000-4000-8000-000000000000",
			cid = "a".repeat(64);
		try {
			await mkdir(bin);
			await symlink(process.execPath, join(bin, "bun"));
			await Bun.write(
				join(bin, "docker"),
				`#!${process.execPath}
import {existsSync,writeFileSync,unlinkSync} from 'node:fs';
const a=process.argv.slice(2),v=a[2],op=a[3],created=${JSON.stringify(created)},removed=${JSON.stringify(removed)},id=${JSON.stringify(id)},cid=${JSON.stringify(cid)};
if(v==='volume'){
 if(op==='create'){writeFileSync(created,'yes');console.log(id)}
 else if(op==='rm'){unlinkSync(created);console.log(id)}
 else if(!existsSync(created)){console.error('no such volume');process.exit(1)}
 else if(a.includes('{{.Mountpoint}}'))console.log('/var/lib/docker/volumes/'+id+'/_data');
 else console.log(JSON.stringify({Name:id,Labels:{'io.klh.fleet.host-fixture':id}}));
}else if(v==='run'){console.error('Conflict: name already in use');process.exit(125)}
else if(v==='rm'){writeFileSync(removed,a.at(-1));console.log(a.at(-1))}
else if(v==='inspect'){if(existsSync(removed)){console.error('No such object');process.exit(1)}
 console.log(JSON.stringify({Id:cid,Name:'/'+id+'-authority',Config:{Image:'fixture-image',Labels:${JSON.stringify(label === "absent" ? null : { "io.klh.fleet.host-fixture": label === "owned" ? id : "someone-else" })}},Mounts:[]}))}
else process.exit(99);`,
			);
			await chmod(join(bin, "docker"), 0o700);
			const driver = join(world.home, "driver.ts"),
				fixture = new URL("./runtime.fixture.ts", import.meta.url).pathname;
			await Bun.write(
				driver,
				`import{openHostFixture}from ${JSON.stringify(fixture)};let refusal='';try{await openHostFixture('fixture-image','fixture-guest',{seedDigest:'fixture',policyDigest:'fixture'},'unused',async()=>{},${JSON.stringify(id)})}catch(e){refusal=e instanceof Error?e.message:String(e)}console.log(JSON.stringify({refusal,removed:await Bun.file(${JSON.stringify(removed)}).exists(),volumeRetained:await Bun.file(${JSON.stringify(created)}).exists()}))`,
			);
			const result = await runCliAsync(driver, [], { env: { PATH: bin } });
			expect(result.code).toBe(0);
			const outcome = JSON.parse(result.out);
			expect(outcome.refusal).toContain(
				label === "owned"
					? "Docker fixture command failed (125)"
					: "cleanup failed",
			);
			expect(outcome.removed).toBe(label === "owned");
			expect(outcome.volumeRetained).toBe(label !== "owned");
		} finally {
			world.clean();
		}
	});
