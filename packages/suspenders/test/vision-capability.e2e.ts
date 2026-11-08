// vision-capability.e2e.ts — W2854 co-situated proof: the dispatch plane
// knows which route models can carry images, so a text-only lane never
// repeats the W2267.5 poison (an image Read 400s the leg, wedges the
// transcript through the 502 retry loop, and contaminates provider health).
// Four depths: the catalog seed (belt), the capability grammar, the brief
// clause + Read-gate refusal, and the dead-lane wedge classifier.
import { expect, test } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticInputModalities } from "@klh/belt/bin/model-capabilities.ts";
import {
	IMAGE_BLOCK_RE,
	imagePoisonWedge,
	imageReadDenyReason,
	visionBriefLines,
	visionCapabilityOf,
} from "../hooks/lib/lanes/vision-capability.ts";
import { kevModelOptionLabel } from "../hooks/lib/fleet-loop/kev-model-pick.ts";
import { gateSpawn } from "./helpers/gate-spawn.ts";

// The gate resolves lane identity mechanically: the spawned gate's ancestor
// chain must hold a pid from a .fleet/lanes.json found by walking UP from the
// payload cwd. THIS process is that ancestor (gates.test.ts recipe), so its
// real pid in a fixture lanes.json makes the gate see a live text-only lane.
const laneWorld = join(tmpdir(), `w2854-lane-${String(process.pid)}`);
const laneFleet = join(laneWorld, ".fleet");
const shot = join(laneWorld, "screenshot.png");

const writeLane = (model: string | null): void => {
	mkdirSync(laneFleet, { recursive: true });
	writeFileSync(shot, "not-really-a-png");
	writeFileSync(
		join(laneFleet, "lanes.json"),
		JSON.stringify([
			{
				sid: "autow2854t",
				item: "W2854T",
				pid: process.pid,
				branch: "suspenders/W2854T",
				worktree: laneWorld,
				...(model ? { model } : {}),
			},
		]),
	);
};

test.afterAll(() => rmSync(laneWorld, { recursive: true, force: true }));

test.describe("W2854 route-vision capability @unit", () => {
	test("the catalog seed carries glm-5.3 as text-only, any wire spelling", () => {
		expect(staticInputModalities("glm-5.3")).toEqual(["text"]);
		expect(staticInputModalities("glm-5.3-flash")).toEqual(["text"]);
		expect(staticInputModalities("zai-glm-5.3")).toEqual(["text"]);
		expect(staticInputModalities("zai/glm-5.3-flash")).toEqual(["text"]);
		// an unseeded id stays unknown — the seed never guesses
		expect(staticInputModalities("claude-sonnet-5.5")).toBeNull();
		expect(staticInputModalities("qwen3-coder-30b")).toBeNull();
	});

	test("vision ids seed text+image; unknown never claims text-only", () => {
		expect(staticInputModalities("qwen2.5-vl-7b")).toEqual(["text", "image"]);
		expect(visionCapabilityOf("qwen2.5-vl-7b")).toBe("vision");
		expect(visionCapabilityOf("glm-5.3-flash")).toBe("text-only");
		expect(visionCapabilityOf("claude-sonnet-5.5")).toBe("unknown");
		expect(visionCapabilityOf(null)).toBe("unknown");
		expect(visionCapabilityOf(undefined)).toBe("unknown");
	});

	test("the brief clause fires for text-only routes only", () => {
		const clause = visionBriefLines("glm-5.3-flash");
		expect(clause).toHaveLength(1);
		expect(clause[0]).toContain("TEXT-ONLY");
		expect(clause[0]).toContain("NEVER Read PNG/image files");
		// vision + unknown + absent routes keep the legacy brief byte-identical
		expect(visionBriefLines("qwen2.5-vl-7b")).toEqual([]);
		expect(visionBriefLines("claude-sonnet-5.5")).toEqual([]);
		expect(visionBriefLines(null)).toEqual([]);
	});

	test("the Read refusal names the file, the route, and the text-only way out", () => {
		const why = imageReadDenyReason("/tmp/shot.png", "glm-5.3-flash") ?? "";
		expect(why).toContain("/tmp/shot.png");
		expect(why).toContain("glm-5.3-flash");
		expect(why).toContain("TEXT-ONLY");
		// unknown/vision routes never refuse; non-image paths never refuse
		expect(imageReadDenyReason("/tmp/shot.png", "qwen2.5-vl-7b")).toBeNull();
		expect(imageReadDenyReason("/tmp/shot.png", "claude-sonnet-5.5")).toBeNull();
		expect(imageReadDenyReason("/tmp/notes.md", "glm-5.3-flash")).toBeNull();
		expect(imageReadDenyReason("/tmp/shot.png", null)).toBeNull();
	});

	test("the image-block vocabulary covers the raster set, not documents", () => {
		for (const f of ["a.png", "a.JPG", "a.jpeg", "a.webp", "a.gif", "a.avif"])
			expect(IMAGE_BLOCK_RE.test(f)).toBe(true);
		for (const f of ["a.pdf", "a.md", "a.ts", "a.jsonl"])
			expect(IMAGE_BLOCK_RE.test(f)).toBe(false);
	});

	test("kev reads the vision row on each offering; unknown stays bare", () => {
		expect(kevModelOptionLabel("glm-5.3")).toBe("glm-5.3 (text-only)");
		expect(kevModelOptionLabel("qwen2.5-vl-7b")).toBe("qwen2.5-vl-7b (vision)");
		expect(kevModelOptionLabel("claude-sonnet-5.5")).toBe("claude-sonnet-5.5");
	});

	test("the dead-lane wedge classifier recognizes the image-poison shape", () => {		const poisoned = [
			"API Error: 400 {\"error\":{\"type\":\"invalid_request_error\",",
			'"message":"messages.1.content.0.image: image blocks are not supported"}}',
			"API Error: 502 retrying 1/10",
			"API Error: 502 retrying 2/10",
		].join("\n");
		const wedge = imagePoisonWedge(poisoned) ?? "";
		expect(wedge).toContain("image-poison wedge");
		expect(wedge).toContain("no resume recovers it");
		expect(wedge).toContain("2 5xx");
		// an ordinary death, and a 400 with no image evidence, stay unclassified
		expect(imagePoisonWedge("lane exited code 1\nnothing to see")).toBeNull();
		expect(
			imagePoisonWedge('400 {"error":{"type":"invalid_request_error"}} bad tool'),
		).toBeNull();
	});

	test("the read gate REFUSES an image Read from a text-only lane", () => {
		writeLane("glm-5.3-flash");
		const r = gateSpawn(
			"pre-read",
			{
				tool_name: "Read",
				tool_input: { file_path: shot },
				cwd: laneWorld,
				session_id: "autow2854t",
			},
			{ cwd: laneWorld },
		);
		const out = r.json?.hookSpecificOutput;
		expect(out?.permissionDecision).toBe("deny");
		expect(out?.permissionDecisionReason ?? "").toContain("TEXT-ONLY");
	});

	test("the same Read ALLOWS when the lane carries no model (legacy entry)", () => {
		writeLane(null);
		const r = gateSpawn(
			"pre-read",
			{
				tool_name: "Read",
				tool_input: { file_path: shot },
				cwd: laneWorld,
				session_id: "autow2854t",
			},
			{ cwd: laneWorld },
		);
		expect(r.json?.hookSpecificOutput?.permissionDecision ?? "allow").toBe(
			"allow",
		);
	});
});
