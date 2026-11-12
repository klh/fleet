import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { verifySubject } from "./test/qualification-subject.ts";

function example() {
	const rawConfig = Buffer.from(
		JSON.stringify({
			architecture: "arm64",
			os: "linux",
			config: { Labels: { fixture: "exact" } },
			rootfs: { type: "layers", diff_ids: [`sha256:${"c".repeat(64)}`] },
		}),
	);
	const configDigest = `sha256:${createHash("sha256").update(rawConfig).digest("hex")}`;
	const rawManifest = Buffer.from(
		JSON.stringify({ config: { digest: configDigest } }),
	);
	const manifestDigest = `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`;
	return {
		platform: "linux/arm64",
		manifestDigest,
		configDigest,
		rawManifest,
		rawConfig,
		container: {
			Image: `sha256:${"a".repeat(64)}`,
			Config: {
				Image:
					"ghcr.io/klh/fleet/buckle-seed@sha256:b57ec30f3582d298f4b465d3a8cd629ab3447b3b644dd26efde5a4cb0a062189",
			},
			ImageManifestDescriptor: {
				digest: manifestDigest,
				platform: { architecture: "arm64", os: "linux" },
			},
		},
		image: {
			Id: manifestDigest,
			Architecture: "arm64",
			Os: "linux",
			Descriptor: { mediaType: "application/vnd.oci.image.index.v1+json" },
			Config: { Labels: { fixture: "exact" } },
			RootFS: { Type: "layers", Layers: [`sha256:${"c".repeat(64)}`] },
		},
	};
}
test("containerd index ID remains opaque while exact platform descriptor binds raw manifest/config and rootFS", () => {
	const input = example();
	expect(input.container.Image).not.toBe(input.configDigest);
	expect(input.image.Id).not.toBe(input.container.Image);
	expect(input.image.Id).not.toBe(input.configDigest);
	expect(verifySubject(input)).toMatchObject({
		configDigest: input.configDigest,
		platformManifest: input.manifestDigest,
		localImageId: input.container.Image,
	});
});
test("missing/wrong platform descriptors and wrong raw subjects refuse", () => {
	const input = example();
	for (const descriptor of [
		undefined,
		{
			...input.container.ImageManifestDescriptor,
			digest: `sha256:${"d".repeat(64)}`,
		},
		{
			...input.container.ImageManifestDescriptor,
			platform: { architecture: "amd64", os: "linux" },
		},
	])
		expect(() =>
			verifySubject({
				...input,
				container: { ...input.container, ImageManifestDescriptor: descriptor },
			}),
		).toThrow();
	expect(() =>
		verifySubject({ ...input, rawConfig: Buffer.from("{}") }),
	).toThrow("config digest");
	expect(() =>
		verifySubject({ ...input, rawManifest: Buffer.from("{}") }),
	).toThrow("manifest digest");
	expect(() =>
		verifySubject({
			...input,
			image: { ...input.image, RootFS: { Type: "layers", Layers: [] } },
		}),
	).toThrow("rootFS");
	expect(() =>
		verifySubject({
			...input,
			image: { ...input.image, Config: { Labels: { fixture: "wrong" } } },
		}),
	).toThrow("labels");
});
