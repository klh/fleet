// hooks/board/routes-files.ts — W858.8 orchestrator file attachments (route
// module). Upload = multipart POST (the bytes ride the wire; a browser File
// has no reusable local path — never pretend otherwise). Retrieval rides a
// capability URL: the per-file secret IS the credential, expiry purges on
// touch, DELETE removes early. hostGuard already gates every request.
import { json, writeGuard } from "./helpers.ts";
import {
	dropLimits,
	dropUrl,
	publicMeta,
	purgeExpiredDrops,
	readDrop,
	removeDrop,
	resolveDrop,
	storeDrop,
	validateDrop,
} from "./drop-files.ts";
import { sanitizeDropName } from "./drop-files.ts";

// GET/DELETE one attachment by capability URL (/api/files/<id>?k=<secret>)
function retrieval(req: Request, url: URL, id: string): Response {
	if (req.method !== "GET" && req.method !== "DELETE")
		return json({ ok: false, error: "GET or DELETE" }, 405);
	const r = resolveDrop(id, url.searchParams.get("k") ?? "");
	if (!r.ok && r.reason === "expired")
		return json({ ok: false, error: "attachment expired" }, 410);
	if (!r.ok)
		return json(
			{ ok: false, error: "no such attachment (wrong or missing secret)" },
			404,
		);
	if (req.method === "DELETE") {
		const guard = writeGuard(req, url);
		if (guard) return guard;
		removeDrop(id);
		return json({ ok: true, deleted: id });
	}
	if (url.searchParams.get("meta"))
		return json({ ok: true, file: publicMeta(r.meta) });
	return new Response(readDrop(r.meta), {
		headers: {
			"content-type": r.meta.type || "application/octet-stream",
			"x-content-type-options": "nosniff",
			"cache-control": "no-store",
			"content-disposition": `attachment; filename="${r.meta.name}"`,
		},
	});
}

// batch validation failures map kind → status: size 413, type 415, else 400
const uploadReject = (
	kind: string,
	errors: string[],
): { ok: false; resp: Response } => ({
	ok: false,
	resp: json(
		{ ok: false, error: errors.join("; ").slice(0, 300) },
		kind === "size" ? 413 : kind === "type" ? 415 : 400,
	),
});

// multipart parse + count caps; per-file validation rides the caller
async function parseMultipart(
	req: Request,
	limits: ReturnType<typeof dropLimits>,
): Promise<{ ok: true; parts: File[] } | { ok: false; resp: Response }> {
	const ct = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
	if (ct !== "multipart/form-data")
		return { ok: false, resp: json({ ok: false, error: "content-type must be multipart/form-data" }, 415) };
	let form: FormData;
	try {
		form = await req.formData();
	} catch {
		return { ok: false, resp: json({ ok: false, error: "unparseable multipart body" }, 400) };
	}
	const parts = form.getAll("files").filter(
		(v): v is File => typeof v === "object" && v !== null && "arrayBuffer" in v,
	);
	if (!parts.length)
		return { ok: false, resp: json({ ok: false, error: "no files field" }, 400) };
	if (parts.length > limits.maxFiles)
		return { ok: false, resp: json({ ok: false, error: `more than ${limits.maxFiles} files` }, 400) };
	return { ok: true, parts };
}

// parse, validate, store the batch; every file passes before the first stores
async function upload(req: Request): Promise<Response> {
	const limits = dropLimits();
	const p = await parseMultipart(req, limits);
	if (!p.ok) return p.resp;
	const errors: string[] = [];
	let kind: "size" | "type" | "name" = "name";
	for (const f of p.parts) {
		const v = validateDrop(sanitizeDropName(f.name), f.size, limits);
		if (!v.ok) {
			errors.push(`${f.name}: ${v.error}`);
			kind = v.kind;
		}
	}
	if (errors.length) return uploadReject(kind, errors).resp;
	purgeExpiredDrops();
	const stored: Record<string, unknown>[] = [];
	for (const f of p.parts) {
		const bytes = new Uint8Array(await f.arrayBuffer());
		const s = storeDrop({
			name: f.name,
			type: f.type || "application/octet-stream",
			bytes,
		});
		if (!s.ok) return json({ ok: false, error: s.error }, 500);
		stored.push({
			...publicMeta(s.meta),
			url: dropUrl(new URL(req.url).origin, s.meta),
		});
	}
	return json({ ok: true, files: stored });
}

export async function handleFiles(
	req: Request,
	url: URL,
): Promise<Response | null> {
	const m = url.pathname.match(/^\/api\/files\/([0-9a-f]{16})$/);
	if (m) return retrieval(req, url, m[1]);
	if (url.pathname === "/api/orchestrate/files" && req.method === "POST") {
		const guard = writeGuard(req, url);
		if (guard) return guard;
		return upload(req);
	}
	return null;
}
