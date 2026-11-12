import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const PlatformSchema = z.enum(["linux/amd64", "linux/arm64"]);
const LabelsSchema = z.record(z.string(), z.string());
const SubjectSchema = z.object({
	platform: PlatformSchema,
	manifestDigest: DigestSchema,
	configDigest: DigestSchema,
	rawManifest: z.instanceof(Uint8Array),
	rawConfig: z.instanceof(Uint8Array),
	container: z.object({
		Image: DigestSchema,
		Config: z.object({
			Image: z.literal(
				"ghcr.io/klh/fleet/buckle-seed@sha256:b57ec30f3582d298f4b465d3a8cd629ab3447b3b644dd26efde5a4cb0a062189",
			),
		}),
		ImageManifestDescriptor: z.object({
			digest: DigestSchema,
			platform: z.object({
				os: z.literal("linux"),
				architecture: z.enum(["amd64", "arm64"]),
			}),
		}),
	}),
	image: z.object({
		Id: DigestSchema,
		Architecture: z.enum(["amd64", "arm64"]),
		Os: z.literal("linux"),
		Descriptor: z.object({ mediaType: z.string() }),
		Config: z.object({ Labels: LabelsSchema }),
		RootFS: z.object({
			Type: z.literal("layers"),
			Layers: z.array(DigestSchema),
		}),
	}),
});
const ManifestSchema = z.object({ config: z.object({ digest: DigestSchema }) });
const ConfigSchema = z.object({
	architecture: z.enum(["amd64", "arm64"]),
	os: z.literal("linux"),
	config: z.object({ Labels: LabelsSchema }),
	rootfs: z.object({
		type: z.literal("layers"),
		diff_ids: z.array(DigestSchema),
	}),
});
export function verifySubject(input: unknown) {
	const data = SubjectSchema.parse(input),
		arch = data.platform.split("/")[1];
	if (
		data.container.ImageManifestDescriptor.digest !== data.manifestDigest ||
		data.container.ImageManifestDescriptor.platform.architecture !== arch
	)
		throw Error("Container platform descriptor mismatch");
	if (
		`sha256:${createHash("sha256").update(data.rawManifest).digest("hex")}` !==
		data.manifestDigest
	)
		throw Error("Raw manifest digest mismatch");
	const manifest = ManifestSchema.parse(
		JSON.parse(Buffer.from(data.rawManifest).toString("utf8")),
	);
	if (
		manifest.config.digest !== data.configDigest ||
		`sha256:${createHash("sha256").update(data.rawConfig).digest("hex")}` !==
			data.configDigest
	)
		throw Error("Raw config digest mismatch");
	const config = ConfigSchema.parse(
		JSON.parse(Buffer.from(data.rawConfig).toString("utf8")),
	);
	if (config.architecture !== arch || data.image.Architecture !== arch)
		throw Error("Inspected platform image mismatch");
	if (!isDeepStrictEqual(config.rootfs.diff_ids, data.image.RootFS.Layers))
		throw Error("Inspected rootFS mismatch");
	if (!isDeepStrictEqual(config.config.Labels, data.image.Config.Labels))
		throw Error("Inspected labels mismatch");
	return {
		platformManifest: data.manifestDigest,
		configDigest: data.configDigest,
		localImageId: data.container.Image,
		inspectedImageId: data.image.Id,
		localImageDescriptorMediaType: data.image.Descriptor.mediaType,
		rootFSVerified: true,
		rawConfigVerified: true,
	};
}
