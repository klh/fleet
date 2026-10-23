#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const sid = process.env.SUSPENDERS_SID ?? "";
const nativeSession = process.env.SUSPENDERS_FIXTURE_NATIVE_UUID ?? "pause-native-session";
const coord = new URL("../../hooks/bin/coord.ts", import.meta.url).pathname;
const call = (args: string[]) =>
	execFileSync(process.execPath, [coord, ...args, "--as", sid], {
		encoding: "utf8",
	});
const emit = (value: unknown) =>
	process.stdout.write(`${JSON.stringify(value)}\n`);
let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;
createInterface({ input: process.stdin }).on("line", (line) => {
	const frame = JSON.parse(line);
	if (frame.type === "control_request") {
		clearTimeout(timer);
		emit({
			type: "control_response",
			response: { subtype: "success", request_id: frame.request_id },
		});
		emit({ type: "result", subtype: "error_during_execution", is_error: true });
		return;
	}
	if (frame.type !== "user") return;
	const text = frame.message.content as string;
	if (!started) {
		started = true;
		emit({
			type: "system",
			subtype: "init",
			session_id: nativeSession,
			pid: process.pid,
		});
		timer = setTimeout(
			() => emit({ type: "result", result: "ORIGINAL_COMPLETE" }),
			5000,
		);
	} else if (text.includes("FLEET_MANAGED_PAUSE:")) {
		const sha = execFileSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		call([
			"capsule",
			"set",
			`--checkpoint=${sha}`,
			"--done=fixture checkpoint",
			"--next=fixture continuation",
		]);
		call(["paused", "--sha", sha]);
		if (process.env.SUSPENDERS_FIXTURE_ACK_PAUSE === "1") {
			const event = text.match(/^Fleet direct event #(\d+)/)?.[1];
			if (!event) throw Error("pause fixture requires a real directed event");
			call(["ack", event]);
		}
		execFileSync(
			process.execPath,
			[new URL("../../hooks/gate.ts", import.meta.url).pathname, "stop"],
			{
				encoding: "utf8",
				input: JSON.stringify({
					cwd: process.cwd(),
					session_id: "native-uuid-not-fleet-sid",
					stop_hook_active: true,
				}),
			},
		);
		emit({ type: "fleet.fixture.stop", state: "allowed-after-pause" });
		emit({
			type: "result",
			subtype: "success",
			result: "CHECKPOINTED",
			session_id: nativeSession,
			pid: process.pid,
		});
	} else if (text.includes("FLEET_MANAGED_RESUME:")) {
		call(["resumed"]);
		const finish = () =>
			emit({
				type: "result",
				subtype: "success",
				result: "RESUMED",
				pid: process.pid,
				session_id: nativeSession,
			});
		if (process.env.SUSPENDERS_FIXTURE_RESUME_ACTIVE === "1") {
			emit({ type: "fleet.fixture.resume", state: "active", pid: process.pid });
			timer = setTimeout(finish, 2000);
		} else finish();
	} else if (process.env.SUSPENDERS_FIXTURE_RESUME_ACTIVE === "1") {
		emit({
			type: "result",
			subtype: "success",
			result: "DIRECT_DELIVERED",
			pid: process.pid,
		});
	} else {
		emit({ type: "result", result: "UNEXPECTED_NORMAL_WORK" });
	}
});
