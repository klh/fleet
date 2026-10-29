// hooks/board/routes-posture.ts — W1315.4: the board's posture surface.
// GET /api/posture — panel state: configured flag, base selection + CAS
// revision, the selected fleet's posture names, and the effective
// resolution for ?project= (.prefer layers), with per-entry shared-pool
// occupancy and hold/disabled state.
// POST /api/posture/selection — CAS save of the base selection through the
// W1315.2 store; a repository .prefer file is never read or written here.
import { existsSync } from "node:fs";
import { z } from "zod";
import { db } from "./context.ts";
import { json, readJson, writeGuard } from "./helpers.ts";
import {
	entryKey,
	postureOccupancy,
} from "../lib/posture/posture.admission.ts";
import { readPostureLayers } from "../lib/posture/posture.prefer.ts";
import { resolvePosture } from "../lib/posture/posture.resolve.ts";
import {
	readStackPostureConfig,
	saveStackPostureSelection,
} from "../lib/posture/posture.store.ts";
import { STACK_PATH } from "../lib/stack-config.ts";
import { PostureSelectionSchema } from "../lib/posture/posture.zod.ts";

const STALE = "changed since the preview";
const UNMIGRATED = "has not been migrated";

const messageOf = (e: unknown): string =>
	e instanceof Error ? e.message : String(e);

/** Schema law (W1238.4): the POST body shape, safeParse'd by name. */
export const PostureSelectionBodySchema = z.strictObject({
	selection: PostureSelectionSchema,
	revision: z.string().min(1),
});

type PostureDoc = NonNullable<
	ReturnType<typeof readStackPostureConfig>["document"]
>;

/** The selected fleet's posture names (fleet existence checked by resolve). */
function postureNames(document: PostureDoc): string[] {
	const fleet = document.fleets[document.selection.fleet];
	return fleet ? Object.keys(fleet.postures) : [];
}

/** One entry with live shared-pool occupancy and hold/disabled state. */
function entryView(
	entry: { hub: string; model: string; policy: string; lanes: number | "MAX" },
	occupancy: Map<string, number>,
): {
	hub: string;
	model: string;
	policy: string;
	lanes: number | "MAX";
	occupancy: number;
	held: boolean;
	disabled: boolean;
} {
	const occ = occupancy.get(entryKey(entry)) ?? 0;
	const numeric = typeof entry.lanes === "number";
	return {
		...entry,
		occupancy: occ,
		held: numeric && occ >= entry.lanes,
		disabled: entry.policy === "OFF" || entry.lanes === 0,
	};
}

/** ?project= must be a real directory before the .prefer walk runs —
 * null (absent) | path | a 400 Response. */
function projectDir(url: URL): string | null | Response {
	const raw = url.searchParams.get("project");
	if (raw === null) return null;
	if (raw.length === 0 || !existsSync(raw))
		return json(
			{ ok: false, error: `project directory not found: ${raw}` },
			400,
		);
	return raw;
}

/** GET /api/posture — the panel snapshot. Un-migrated machine →
 * configured:false with the migration reason; malformed stack config →
 * a loud 500 (drift fails loud, never a silently empty panel). */
function postureView(url: URL): Response {
	const project = projectDir(url);
	if (project instanceof Response) return project;
	let snapshot: ReturnType<typeof readStackPostureConfig>;
	try {
		snapshot = readStackPostureConfig(STACK_PATH());
	} catch (e) {
		return json({ ok: false, error: messageOf(e) }, 500);
	}
	if (!snapshot.document)
		return json({
			ok: true,
			configured: false,
			revision: snapshot.revision,
			unconfiguredReason:
				"postures not migrated in stack.json — legacy routing applies",
		});
	return configuredView(snapshot, project ?? "");
}

/** The configured:true branch — resolve, then join live occupancy. */
function configuredView(
	snapshot: ReturnType<typeof readStackPostureConfig>,
	project: string,
): Response {
	const document = snapshot.document;
	if (!document)
		return json({ ok: false, error: "postures vanished mid-request" }, 500);
	const selection = document.selection;
	let resolved: ReturnType<typeof resolvePosture>;
	try {
		resolved = resolvePosture(
			document,
			project.length === 0 ? [] : readPostureLayers(project),
		);
	} catch (e) {
		return json({ ok: false, error: messageOf(e) }, 500);
	}
	const occupancy = postureOccupancy(db);
	const overrides = [
		...new Set(Object.values(resolved.sources).filter((s) => s !== "base")),
	];
	return json({
		ok: true,
		configured: true,
		revision: snapshot.revision,
		selection,
		postures: postureNames(document),
		effective: {
			...resolved.selection,
			overridden: resolved.selection.posture !== selection.posture,
			overrides,
			sources: resolved.sources,
			entries: resolved.entries.map((e) => entryView(e, occupancy)),
		},
	});
}

/** POST /api/posture/selection — the CAS save. Stale revision → 412
 * (client reloads and re-applies), un-migrated machine → 409, unknown
 * fleet/posture → 400. The base selection only — .prefer files untouched. */
async function applySelection(req: Request): Promise<Response> {
	const parsed = await readJson(req);
	if (!parsed.ok) return parsed.resp;
	const safe = PostureSelectionBodySchema.safeParse(parsed.body);
	if (!safe.success) {
		const details = safe.error.issues
			.map((i) => `${i.path.join(".") || "$"}: ${i.message}`)
			.join("; ");
		return json({ ok: false, error: details }, 400);
	}
	const { selection, revision } = safe.data;
	try {
		const fresh = saveStackPostureSelection(STACK_PATH(), selection, revision);
		return json({
			ok: true,
			revision: fresh.revision,
			selection: fresh.document?.selection ?? null,
		});
	} catch (e) {
		const message = messageOf(e);
		if (message.includes(STALE))
			return json({ ok: false, error: message, code: "stale" }, 412);
		if (message.includes(UNMIGRATED))
			return json({ ok: false, error: message, code: "unmigrated" }, 409);
		return json({ ok: false, error: message }, 500);
	}
}

export async function handlePosture(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (url.pathname === "/api/posture" && req.method === "GET")
		return postureView(url);
	if (url.pathname === "/api/posture/selection" && req.method === "POST") {
		const guard = writeGuard(req, url);
		if (guard) return guard;
		return applySelection(req);
	}
	return null;
}
