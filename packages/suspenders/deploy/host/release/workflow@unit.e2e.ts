import { imageMetadata } from "./test-fixture.ts";
import { readPackageMetadata } from "./preflight.ts";
import { expect, test } from "@playwright/test";
import {
	candidateTag,
	publishCandidate,
	promoteCandidate,
	type ReleaseDriver,
} from "./workflow.ts";
import { fixture, request, now } from "./test-fixture.ts";
import { hash } from "./evidence.ts";

function setup() {
	const f = fixture();
	const calls: string[] = [];
	const tags = new Map<string, string>();
	let metadata: unknown = {
		name: "fleet/supervisor-seed",
		package_type: "container",
		visibility: "private",
		repository: { full_name: "klh/fleet", private: true },
	};
	let buildFailure = false;
	const driver: ReleaseDriver = {
		imageMetadata: async (source, recipe) => {
			expect(source).toBe(request.sourceCommit);
			expect(recipe).toBe(request.recipeCommit);
			return { ...imageMetadata };
		},
		publisher: async () => ({
			publisherCommit: "c".repeat(40),
			helpers: [
				{
					path: "packages/suspenders/deploy/host/process.ts",
					sha256: "d".repeat(64),
				},
			],
		}),
		metadata: async () => {
			calls.push("metadata");
			return metadata;
		},
		resolve: async (tag) => {
			calls.push(`resolve:${tag}`);
			return tags.get(tag) ?? null;
		},
		read: f.reader,
		stage: async () => {
			calls.push("stage");
			return {
				context: "/isolated-fixture",
				recipeFiles: [
					{
						path: "Dockerfile",
						gitPath: "packages/suspenders/deploy/host/Dockerfile",
						sha256: "e".repeat(64),
					},
				],
				clean: async () => {
					calls.push("clean");
				},
			};
		},
		build: async (argv, cwd) => {
			calls.push("build");
			expect(cwd).toBe("/isolated-fixture");
			expect(argv).toContain("--push");
			expect(argv).not.toContain("--load");
			expect(argv).toContain(`CREATED=${imageMetadata.created}`);
			expect(argv.filter((arg) => arg.startsWith("CREATED="))).toHaveLength(1);
			expect(argv.some((arg) => arg.includes("SOURCE_DATE_EPOCH"))).toBe(false);
			if (buildFailure) throw new Error("fixture build failed");
			tags.set(argv[argv.indexOf("--tag") + 1], f.index.digest);
		},
		promote: async (tag, bytes) => {
			calls.push("promote");
			tags.set(tag, hash(bytes));
		},
	};
	return {
		...f,
		driver,
		calls,
		tags,
		setMetadata: (value: unknown) => {
			metadata = value;
		},
		failBuild: () => {
			buildFailure = true;
		},
	};
}
test("candidate validates before upload, cleans staging and promotes exact verified index @unit", async () => {
	const f = setup();
	const candidate = await publishCandidate(
		request,
		f.acceptance,
		f.artifacts,
		f.driver,
		now,
	);
	expect(candidate.publication).toBe("private-candidate");
	expect(candidate.verification.imageMetadata).toEqual({
		...imageMetadata,
		derivation: "max(sourceCommit.committerEpoch,recipeCommit.committerEpoch)",
	});
	expect(f.calls.indexOf("metadata")).toBeLessThan(f.calls.indexOf("build"));
	expect(f.calls.at(-1)).toBe("clean");
	expect(f.calls).not.toContain("promote");
	const result = await promoteCandidate(
		request,
		f.acceptance,
		candidate.digest,
		f.artifacts,
		f.driver,
		now,
	);
	expect(result.publication).toBe("published");
	expect(result.descriptor.image).toContain(`@${f.index.digest}`);
	expect(f.calls.filter((call) => call === "promote")).toHaveLength(1);
	await expect(
		promoteCandidate(
			request,
			f.acceptance,
			candidate.digest,
			f.artifacts,
			f.driver,
			now,
		),
	).rejects.toThrow("already exists");
});
test("unaccepted/private-mismatch/corrupt-evidence requests never stage or upload @unit", async () => {
	for (const mode of ["missing", "public", "report"] as const) {
		const f = setup();
		if (mode === "public") f.setMetadata({ visibility: "public" });
		if (mode === "report") f.artifacts[0].report = new Uint8Array();
		await expect(
			publishCandidate(
				request,
				mode === "missing" ? [] : f.acceptance,
				f.artifacts,
				f.driver,
				now,
			),
		).rejects.toThrow();
		expect(f.calls).not.toContain("stage");
		expect(f.calls).not.toContain("build");
	}
});
test("build failure and tested-subject drift clean stage and never promote @unit", async () => {
	for (const mode of ["build", "drift"] as const) {
		const f = setup();
		if (mode === "build") f.failBuild();
		else
			f.driver.build = async (argv) => {
				f.calls.push("build");
				f.tags.set(argv[argv.indexOf("--tag") + 1], f.index.digest);
				f.blobs.set(f.config.digest, new TextEncoder().encode("{}"));
			};
		await expect(
			publishCandidate(request, f.acceptance, f.artifacts, f.driver, now),
		).rejects.toThrow();
		expect(f.calls.at(-1)).toBe("clean");
		expect(f.calls).not.toContain("promote");
	}
});
test("wrong/moved candidate and existing release tag cannot promote @unit", async () => {
	const f = setup();
	f.tags.set(
		candidateTag(request, f.acceptance, imageMetadata, now),
		`sha256:${"0".repeat(64)}`,
	);
	await expect(
		promoteCandidate(
			request,
			f.acceptance,
			f.index.digest,
			f.artifacts,
			f.driver,
			now,
		),
	).rejects.toThrow("Candidate");
	expect(f.calls).not.toContain("promote");
});

test("expired acceptance after staging refuses upload and joins staging cleanup @unit", async () => {
	const f = setup();
	const stage = f.driver.stage;
	f.driver.stage = async (...args) => {
		const staged = await stage(...args);
		await new Promise((resolve) => setTimeout(resolve, 20));
		return staged;
	};
	const closeToExpiry =
		Date.parse(f.acceptance[0].completedAt) + 24 * 60 * 60 * 1000 - 10;
	await expect(
		publishCandidate(
			request,
			f.acceptance,
			f.artifacts,
			f.driver,
			closeToExpiry,
		),
	).rejects.toThrow("stale");
	expect(f.calls).not.toContain("build");
	expect(f.calls.at(-1)).toBe("clean");
});
test("privacy change at promotion boundary prevents exact-index PUT @unit", async () => {
	const f = setup();
	const candidate = await publishCandidate(
		request,
		f.acceptance,
		f.artifacts,
		f.driver,
		now,
	);
	let reads = 0;
	const metadata = f.driver.metadata;
	f.driver.metadata = async () => {
		reads++;
		if (reads === 2) return { visibility: "public" };
		return metadata();
	};
	await expect(
		promoteCandidate(
			request,
			f.acceptance,
			candidate.digest,
			f.artifacts,
			f.driver,
			now,
		),
	).rejects.toThrow();
	expect(f.calls).not.toContain("promote");
});

test("build-time public/association drift refuses positive private-candidate result @unit", async () => {
	for (const metadata of [
		{ visibility: "public" },
		{
			name: "fleet/supervisor-seed",
			package_type: "container",
			visibility: "private",
			repository: { full_name: "foreign/repo", private: true },
		},
	]) {
		const f = setup();
		const build = f.driver.build;
		f.driver.build = async (argv, cwd) => {
			await build(argv, cwd);
			f.setMetadata(metadata);
		};
		await expect(
			publishCandidate(request, f.acceptance, f.artifacts, f.driver, now),
		).rejects.toThrow();
		expect(f.calls.at(-1)).toBe("clean");
		expect(f.calls).not.toContain("promote");
	}
});
test("promotion-time metadata drift refuses published receipt and retains actual tag side effect @unit", async () => {
	const f = setup();
	const candidate = await publishCandidate(
		request,
		f.acceptance,
		f.artifacts,
		f.driver,
		now,
	);
	const promote = f.driver.promote;
	f.driver.promote = async (tag, bytes) => {
		await promote(tag, bytes);
		f.setMetadata({ visibility: "public" });
	};
	await expect(
		promoteCandidate(
			request,
			f.acceptance,
			candidate.digest,
			f.artifacts,
			f.driver,
			now,
		),
	).rejects.toThrow();
	expect(
		f.tags.get(`ghcr.io/klh/fleet/supervisor-seed:${request.version}`),
	).toBe(f.index.digest);
});

async function bootstrapProof() {
	return readPackageMetadata(async (path) => ({
		status: path.includes("/container/") ? 404 : 200,
		headers: {},
		bytes: 100,
		body: path.includes("/container/")
			? { status: "404", message: "Package not found." }
			: path === "/user"
				? { login: "klh", type: "User" }
				: path === "/repos/klh/fleet"
					? {
							full_name: "klh/fleet",
							html_url: "https://github.com/klh/fleet",
							private: false,
							owner: { login: "klh", type: "User" },
						}
					: [],
	}));
}
test("guarded first upload accepts documented-default proof and requires actual private association after push @unit", async () => {
	const f = setup();
	f.setMetadata(await bootstrapProof());
	const build = f.driver.build;
	f.driver.build = async (argv, cwd) => {
		await build(argv, cwd);
		f.setMetadata({
			name: "fleet/supervisor-seed",
			package_type: "container",
			visibility: "private",
			repository: { full_name: "klh/fleet", private: false },
		});
	};
	const result = await publishCandidate(
		request,
		f.acceptance,
		f.artifacts,
		f.driver,
		now,
	);
	expect(result.registry.beforeUpload.state).toBe("bootstrap");
	expect(result.registry.afterUpload.visibility).toBe("private");
	expect(result.registry.afterUpload.repository.private).toBe(false);
});
test("bootstrap upload with absent or wrong/public post-push metadata refuses positive receipt @unit", async () => {
	for (const mode of ["absent", "public"] as const) {
		const f = setup();
		f.setMetadata(await bootstrapProof());
		if (mode === "public") {
			const build = f.driver.build;
			f.driver.build = async (argv, cwd) => {
				await build(argv, cwd);
				f.setMetadata({ visibility: "public" });
			};
		}
		await expect(
			publishCandidate(request, f.acceptance, f.artifacts, f.driver, now),
		).rejects.toThrow();
		expect(f.calls).toContain("build");
		expect(f.calls).not.toContain("promote");
		expect(f.calls.at(-1)).toBe("clean");
	}
});

test("mutation receipts bind reviewed publisher separately from source/recipe and dirty publisher refuses upload @unit", async () => {
	const f = setup();
	f.driver.publisher = async () => {
		throw Error("Publisher helper differs from own committed source");
	};
	await expect(
		publishCandidate(request, f.acceptance, f.artifacts, f.driver, now),
	).rejects.toThrow("Publisher helper");
	expect(f.calls).not.toContain("build");
});
