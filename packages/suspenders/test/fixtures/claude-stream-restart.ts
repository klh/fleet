#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const session = process.argv[process.argv.indexOf("--resume") + 1];
const sid = process.env.SUSPENDERS_SID ?? "";
const emit = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`);
let first = true;
let timer: ReturnType<typeof setTimeout>;
createInterface({ input: process.stdin }).on("line", (line) => {
	const frame = JSON.parse(line);
	if (frame.type === "control_request") {
		clearTimeout(timer);
		emit({ type:"control_response", response:{subtype:"success",request_id:frame.request_id} });
		emit({ type:"result", subtype:"error_during_execution",is_error:true });
	} else if (frame.type === "user" && first) {
		first=false;
		emit({type:"system",subtype:"init",session_id:session,pid:process.pid});
		if (!String(frame.message.content).includes("FLEET_MANAGED_RESUME:")) throw new Error("Restart generated input before canonical resume");
		execFileSync(process.execPath,[new URL("../../hooks/bin/coord.ts",import.meta.url).pathname,"resumed","--as",sid]);
		emit({type:"fleet.fixture.restart",state:"resuming-active",session_id:session,pid:process.pid});
		timer=setTimeout(()=>emit({type:"result",result:"UNINTERRUPTED"}),5000);
	} else if (frame.type === "user") {
		emit({type:"result",subtype:"success",result:"RESTART_INTERRUPT_ACK",session_id:session,pid:process.pid});
	}
});
