#!/usr/bin/env bun
// W2545 fake native: a controlled executable proving ACTUAL protocol
// behavior, never a guessed protocol. Terminal result frames are driven by
// SUSPENDERS_FIXTURE_TRANSIENT_EPISODE (comma list of HTTP statuses) and
// advanced only by FLEET_TRANSPORT_RETRY continuation prompts. The fixture
// never exits by itself — the managed runtime owns closing (stdin close).
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const sid = process.env.SUSPENDERS_SID ?? "";
const nativeSession = "transient-native-session";
const episodes = (process.env.SUSPENDERS_FIXTURE_TRANSIENT_EPISODE ?? "")
	.split(",")
	.filter(Boolean);
const retryAfter = Number(process.env.SUSPENDERS_FIXTURE_TRANSIENT_RETRY_AFTER) || 0;
let cursor = 0;
let started = false;
const coord = new URL("../../hooks/bin/coord.ts", import.meta.url).pathname;
const call = (args: string[]) =>
	execFileSync(process.execPath, [coord, ...args, "--as", sid], {
		encoding: "utf8",
	});
const emit = (value: unknown) =>
	process.stdout.write(`${JSON.stringify(value)}\n`);
/** The evidence shape from W2267.3: subtype "success" while is_error=true and
 * api_error_status carries the transport failure — a JSON subtype success
 * does NOT mean work completed. */
const episodeResult = (status: number) =>
	emit({
		type: "result",
		subtype: "success",
		is_error: true,
		api_error_status: status,
		...(retryAfter > 0 ? { retry_after: retryAfter } : {}),
		result: `API Error (status ${status}): upstream admission refused`,
		session_id: nativeSession,
		pid: process.pid,
	});
createInterface({ input: process.stdin }).on("line", (line) => {
	const frame = JSON.parse(line);
	if (frame.type === "control_request") {
		emit({
			type: "control_response",
			response: { subtype: "success", request_id: frame.request_id },
		});
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
		if (episodes.length > 0) {
			episodeResult(Number(episodes[cursor]));
			if (process.env.SUSPENDERS_FIXTURE_TRANSIENT_CHILD_EXIT === "1")
				process.exit(42);
		} else
			emit({
				type: "result",
				subtype: "success",
				result: "ORIGINAL_COMPLETE",
				session_id: nativeSession,
				pid: process.pid,
			});
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
		emit({
			type: "result",
			subtype: "success",
			result: "CHECKPOINTED",
			session_id: nativeSession,
			pid: process.pid,
		});
	} else if (text.includes("FLEET_MANAGED_RESUME:")) {
		call(["resumed"]);
		emit({
			type: "result",
			subtype: "success",
			result: "RESUMED",
			session_id: nativeSession,
			pid: process.pid,
		});
	} else if (text.includes("FLEET_TRANSPORT_RETRY")) {
		cursor += 1;
		const status = episodes[cursor];
		if (status !== undefined) episodeResult(Number(status));
		else
			emit({
				type: "result",
				subtype: "success",
				result: "RECOVERED_COMPLETE",
				session_id: nativeSession,
				pid: process.pid,
			});
	} else {
		// an ordinary injected note (wake delivery) completes normally
		emit({
			type: "result",
			subtype: "success",
			result: "DIRECT_DELIVERED",
			session_id: nativeSession,
			pid: process.pid,
		});
	}
});
