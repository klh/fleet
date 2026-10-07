// src/align.ts — W142 cache-align (W137 §3b, cloud half): opt-in prompt-cache
// alignment on EXPLICITLY declared requests only. Pass-through doctrine:
// without the x-belt-aids declaration the body is never touched. W237 layout
// law: system → packet → volatile — the packet block relocates to the head
// of the message sequence (first block of the first message, directly after
// the system prefix), so the cache_control breakpoint after it covers a
// byte-stable shared prefix and no rotating card ever sits inside it. A
// breakpoint inside volatile content would make every request a 1.25x cache
// WRITE instead of a 0.1x read.
import type { Dialect } from "./upstreams.ts";

/** The packet header belt splices after the stable prefix. */
export const PACKET_MARKER = "[fleet preseed";

type AnyRec = Record<string, unknown>;

export interface AlignResult {
	/** The aligned body, or null when nothing changed (idempotent no-op). */
	body: Record<string, unknown> | null;
	placed: "system" | "packet" | "none";
}

/** Where a packet block sits: message index, block index, the block. */
export interface PacketBlockRef {
	msg: number;
	idx: number;
	block: AnyRec;
}

/** First message-content block carrying the packet marker — the prefix
 *  position once aligned. Front-first: the shared prefix starts here. */
export function packetBlockOf(body: AnyRec): PacketBlockRef | null {
	const messages = body.messages;
	if (!Array.isArray(messages)) {
		return null;
	}
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i] as AnyRec;
		const content = m.content;
		if (!Array.isArray(content)) continue;
		for (let j = 0; j < content.length; j++) {
			const b = content[j] as AnyRec;
			if (typeof b.text === "string" && b.text.includes(PACKET_MARKER))
				return { msg: i, idx: j, block: b };
		}
	}
	return null;
}

/** Normalize system to a block array with exactly ONE cache_control
 *  breakpoint on the last block; strips misplaced pre-existing ones.
 *  Returns null when nothing changed (already aligned / no system). */
function systemBlocks(body: AnyRec): boolean {
	const sys = body.system;
	if (typeof sys === "string") {
		body.system = [
			{ type: "text", text: sys, cache_control: { type: "ephemeral" } },
		];
		return true;
	}
	if (Array.isArray(sys) && sys.length > 0) {
		const last = sys[sys.length - 1] as AnyRec | undefined;
		if (!last) return false;
		if (last.cache_control) return false; // already aligned
		for (const b of sys as AnyRec[]) delete b.cache_control;
		last.cache_control = { type: "ephemeral" };
		return true;
	}
	return false;
}

/** W237 layout: move the packet block to the head of the message sequence —
 *  first block of the first message, before any volatile byte. A message
 *  left with empty content is dropped (anthropic 400s on content: []).
 *  Returns whether the block moved. */
function relocateToPrefix(body: AnyRec, ref: PacketBlockRef): boolean {
	if (ref.msg === 0 && ref.idx === 0) return false;
	const messages = body.messages as AnyRec[];
	const src = messages[ref.msg] as AnyRec | undefined;
	if (!src || !Array.isArray(src.content)) return false;
	const content = src.content as AnyRec[];
	const [block] = content.splice(ref.idx, 1);
	if (!block) return false;
	if (ref.msg === 0) {
		content.unshift(block); // same message: head of its own blocks
		return true;
	}
	if (content.length === 0) messages.splice(ref.msg, 1);
	const head = messages[0] as AnyRec | undefined;
	if (!head) return false;
	if (typeof head.content === "string") {
		head.content = [block, { type: "text", text: head.content }];
	} else if (Array.isArray(head.content)) {
		head.content.unshift(block);
	} else {
		head.content = [block];
	}
	return true;
}

/** A client may compose the packet inside a larger text block ("preamble\n +
 *  packet"): the preamble bytes would sit inside the cached prefix and rot
 *  it per lane. Split them — pre-bytes become their own block BEFORE the
 *  packet block (which then carries pure packet bytes). Returns the packet
 *  block's ref in the mutated body. */
function splitPacketPrefix(body: AnyRec, ref: PacketBlockRef): PacketBlockRef {
	const text = ref.block.text;
	if (typeof text !== "string") return ref;
	const at = text.indexOf(PACKET_MARKER);
	if (at <= 0) return ref; // pure packet already, or marker absent
	const src = (body.messages as AnyRec[])[ref.msg] as AnyRec | undefined;
	const content = (src?.content as AnyRec[] | undefined) ?? [];
	const pre: AnyRec = { type: "text", text: text.slice(0, at).trimEnd() };
	const packet: AnyRec = {
		type: "text",
		text: text.slice(at),
		cache_control: ref.block.cache_control,
	};
	content.splice(ref.idx, 1, pre, packet);
	return { ...ref, idx: ref.idx + 1, block: packet };
}

/** Align one request body (anthropic dialect): relocate the packet block to
 *  the prefix position and put the cache_control breakpoint after it; with
 *  no packet, align system only. Returns null when the body was already
 *  aligned (idempotent) or nothing could be aligned. */
export function alignBody(body: AnyRec, dialect: Dialect): AlignResult | null {
	if (dialect !== "anthropic") return null;
	const ref0 = packetBlockOf(body);
	if (ref0) {
		const ref = splitPacketPrefix(body, ref0);
		const moved = relocateToPrefix(body, ref);
		const unmarked = !ref.block.cache_control;
		if (!moved && !unmarked) return null; // already at prefix, already marked
		if (unmarked) ref.block.cache_control = { type: "ephemeral" };
		return { body, placed: "packet" };
	}
	if (!systemBlocks(body)) return null;
	return { body, placed: "system" };
}
