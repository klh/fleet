// scripts/lib/brief-verify.ts — W223.2 dual-harness brief verification.
// The fleet dispatches lanes to multiple executor harnesses (claude code +
// copilot CLI, W223). A brief that claude renders fine may be mangled by
// copilot's prompt handling, and a mangled brief is a lost lane: the
// executor burns its whole run improvising a mission it never actually
// received. So every composed brief gets a verification pass BEFORE spawn:
//
//   structure     the four load-bearing sections (MISSION / PROTOCOL /
//                 CAPSULE / LANDING) are present as line-start anchors in
//                 the exact text the executor will receive.
//   size          the brief stays under a byte cap (32 KiB default — real
//                 briefs run ~3 KiB, so 10x headroom; a runaway mission or
//                 a giant RESUME CONTEXT still trips it).
//   control-chars no C0 control characters except \n and \t — this covers
//                 ESC (\x1b), so ANSI SGR remnants (`\x1b[31m`-style) and
//                 any terminal-sequence leakage are rejected by the same
//                 rule, plus \r and DEL. Control bytes are the classic
//                 harness-breaking payload: copilot's prompt layer and
//                 several terminal log surfaces mangle or truncate on them.
//
// Enforcement is per-harness (the W223.2 brief): a copilot brief that fails
// REFUSES the dispatch loudly — the item is reclaimed to READY and nothing
// is spawned, because shipping a mangled brief is worse than shipping none.
// Claude briefs run the SAME checks today in warn-only mode (claude has no
// observed mangling history; hard-gating it is a separate behavior change).
// Pure functions, no I/O — the caller owns reading and deciding.
export const BRIEF_MAX_BYTES = 32 * 1024;

export type BriefHarness = "claude" | "copilot";

export type BriefCheck = "structure" | "size" | "control-chars";

export type BriefFailure = { check: BriefCheck; detail: string };

export type BriefVerdict = {
	ok: boolean;
	harness: BriefHarness;
	failures: BriefFailure[];
};

// line-start anchors — the exact section headers composeBrief emits. A
// mid-line mention ("see the LANDING CHAIN above") must NOT satisfy the
// check: the section itself may be gone, and that is the failure mode.
const SECTION_ANCHORS: Array<[string, RegExp]> = [
	["MISSION", /^MISSION\b/m],
	["PROTOCOL", /^PROTOCOL:/m],
	["CAPSULE", /^CAPSULE/m],
	["LANDING", /^LANDING/m],
];

// C0 controls minus \n (0x0a) and \t (0x09), plus DEL. ESC (0x1b) sits in
// the 0x0e-0x1f range, so ANSI remnants die here without a second pattern.
// Built from String.fromCharCode (biome bans literal control chars in regex
// literals) — the source text lists the same code points the comment names.
const CONTROL_RANGES: Array<[number, number]> = [
	[0, 8], // NUL..BS
	[11, 13], // VT, FF, CR
	[14, 31], // SO..US (includes ESC 0x1b — the ANSI remnant carrier)
	[127, 127], // DEL
];
const rangePart = ([a, b]: [number, number]): string => {
	const esc = (n: number): string => `\\u${n.toString(16).padStart(4, "0")}`;
	return a === b ? esc(a) : `${esc(a)}-${esc(b)}`;
};
const CONTROL_CHARS = new RegExp(`[${CONTROL_RANGES.map(rangePart).join("")}]`);

export const verifyBrief = (
	text: string,
	opts: {
		harness?: BriefHarness;
		maxBytes?: number;
	} = {},
): BriefVerdict => {
	const harness = opts.harness ?? "claude";
	const maxBytes = opts.maxBytes ?? BRIEF_MAX_BYTES;
	const failures: BriefFailure[] = [];
	const missing = SECTION_ANCHORS.filter(([, re]) => !re.test(text)).map(
		([name]) => name,
	);
	if (missing.length > 0)
		failures.push({
			check: "structure",
			detail: `missing section anchor(s): ${missing.join(", ")}`,
		});
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > maxBytes)
		failures.push({
			check: "size",
			detail: `${bytes} bytes > cap ${maxBytes}`,
		});
	const at = text.search(CONTROL_CHARS);
	if (at >= 0) {
		const code = text.codePointAt(at)?.toString(16).padStart(2, "0");
		failures.push({
			check: "control-chars",
			detail: `control char U+${code} at offset ${at}${code === "1b" ? " (ANSI/ESC remnant)" : ""}`,
		});
	}
	return { ok: failures.length === 0, harness, failures };
};

/** one-line human summary for logs/dispatch output (own "ok" shape so the
 *  caller never string-builds a verdict). */
export const briefVerdictLine = (v: BriefVerdict, bytes: number): string =>
	v.ok
		? `VERIFY ok — ${v.harness} brief ${bytes}B (cap ${BRIEF_MAX_BYTES}B), 4/4 sections`
		: `VERIFY FAILED — ${v.harness}: ${v.failures.map((f) => `${f.check} (${f.detail})`).join("; ")}`;
