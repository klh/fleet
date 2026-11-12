# Supervisor seed release

This producer publishes the private HOST runner-control supervisor seed. Source,
recipe, publisher and experimental version are independent pins. It reuses
`../build.ts:stageContext` with the trusted bounded HOST runner: Git streams an
archive to an owned temporary file, then bounded tar extracts it. Every context
is removed after success or failure. The producer's standalone build CLI retains
its existing default runner; these bounded-staging claims apply to this release
workflow's explicit injection.

Mutation requires all executed publisher helpers to match their OWN recorded
`publisherCommit`. The selected image recipe may be older: its contract must
remain compatible, and all five actual staged recipe files must match their
committed Git blob bytes. Helper and staged-file hashes are recorded separately
from the image's `sourceCommit` and `recipeCommit`. Immutable Git object reads
use `--no-replace-objects`; mutable replacement refs cannot substitute source,
recipe or publisher helper content.

CREATED comes exclusively from the shared producer `imageCreated` API: the later
original source/recipe committer epoch. The plan and executed build use that same
argument; verification requires matching OCI identity labels and SLSA CREATED
argument. The outer HOST receipt records all four derived values and the
derivation. No timestamp CLI/input field, wall-clock fallback or
SOURCE_DATE_EPOCH override is provided. OCI config.Created/history remain
BuildKit-produced; this label does not establish byte-reproducible builds, and
acceptance still requires the exact pushed platform/config/diff-ID identity.

The first private publication is recorded in the
[0.1.2-experimental.w2990.3 receipt](receipts/0.1.2-experimental.w2990.3/README.md),
including the immutable descriptor, exact acceptance and pulled-image
qualification references. The failed first-upload association check and its
subsequent repair remain part of that history. Unit fixtures remain synthetic;
the image's continuity label remains `unverified`, with actual runtime proof in
the separate release receipt.

## Inputs and trust

All commands run from the Fleet checkout:

```text
bun packages/suspenders/deploy/host/release/cli.ts --help
```

A request JSON contains exactly:

- `schemaVersion: 1`
- `sourceCommit`, `recipeCommit`: full committed 40-hex SHAs
- `version`: canonical `MAJOR.MINOR.PATCH-experimental[.IDENTIFIER...]`
- `platforms`: unique `linux/amd64` and/or `linux/arm64`

The acceptance JSON is an array of strict per-platform
`fleet-host-packaged-continuity` receipts described by
`ContinuityReceiptSchema` in `contract.ts`. Each receipt must cover the exact
request source, recipe, version and platform and be completed within 24 hours,
without future timestamps, failed or skipped cases. Its `subject` distinguishes
`localIndex`, `platformManifest`, `configDigest`, ordered `rootFsDiffIds` and
`runtimeClosureSha256`. A Desktop image-inspect ID can be an INDEX digest.
Read the platform/config identities from exported OCI metadata; never infer
their roles from Docker's `.Id` field.

`verification` identifies the committed test source, exact test-source aggregate,
command and immutable report hash. The corresponding redacted report must
conform to `ContinuityEvidenceSchema` in `evidence.ts`: actual old/new HOST
and guest CIDs, epoch/key IDs, revoke-before-issue ordering, unchanged original
deadline, post-resume tool call, workspace and prior/new conversation hashes.
Unauthorized resume, corrupt archive and missing bound HOST journal must each
show refusal, zero successful model effects and no surviving guest/key, with
checked cleanup. Do not include raw keys, model headers, journal contents or
private HOST paths. Reports describe scripted-local Docker Desktop verification;
they make no provider-quality, native-amd64, H100, Azure or full-HOST activation
claim.

An artifacts JSON resolves paths relative to that JSON's directory:

```json
[
  {
    "platform": "linux/arm64",
    "closure": "arm64-runtime-closure.json",
    "report": "arm64-continuity-evidence.json"
  }
]
```

The files' actual bytes must match the receipt hashes. Inputs are bounded regular
files opened without following the final symlink. The report's source, recipe,
version, platform, config and test-source identity must agree with the receipt.
The closure's architecture and pinned Docker CLI identity must agree too.

These are operator-controlled acceptance records, not signed proof that tests
ran. Review the exact test source and immutable execution evidence before
authorizing execution. Signatures remain `not-inspected`; this tool performs no
signature verification. Its `verified` provenance/SBOM fields mean that actual
content-addressed attestation bytes, subject, build identity/pins and runtime
package closure were inspected, not that a signing authority authenticated them.

## Two phases

Before any upload, obtain explicit authorization for the concrete reviewed request
and acceptance packet. Preserve the native merge/review gates separately.
`--execute` selects a mutating command; it carries no approval or authentication.

1. Read-only inventory/preflight:

   ```text
   bun packages/suspenders/deploy/host/release/cli.ts preflight
   ```

   Existing package metadata must show private visibility and exact
   `klh/fleet` association. The official source repository is public; its
   visibility is independent of the private container package.

   For an absent first package, structured package404 alone is insufficient.
   Preflight also requires authenticated owner `klh`, its exact source repo
   and a complete owner-package inventory (at most 10 pages, 8 MiB total and 30s).
   Authentication/permission/transient errors, contradictory or truncated
   inventory refuse. The proof explicitly names a documented default rather
   than observed visibility: [GHCR defaults first publications to private and
   supports source-label association](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
   An authorized initial candidate push may create the package. Actual private
   metadata and exact association are mandatory AFTER upload and before any
   positive receipt or promotion. No placeholder, visibility change or separate
   package-create API is used. Tokens stay in memory and HTTP headers.

2. Review the plan with request/acceptance/artifact files:

   ```text
   bun packages/suspenders/deploy/host/release/cli.ts plan --request request.json --acceptance acceptance.json --artifacts artifacts.json --output plan.json
   ```

   The plan contains pins and build argv, with `publication: not-published`.
   It has no invented registry digest. Local `--load` is a separate producer
   action and never establishes registry publication.

3. After authorization, upload a private candidate:

   ```text
   bun packages/suspenders/deploy/host/release/cli.ts candidate --request request.json --acceptance acceptance.json --artifacts artifacts.json --execute --output candidate.json
   ```

   Candidate tags combine version and a request identity hash. Existing final
   or candidate tags refuse before upload; privacy is checked again immediately
   before the build. Existing packages use observed private metadata; bootstrap uses the explicit documented-default proof above. Buildx requests max provenance and SPDX SBOM attestations.
   After upload, verification reads the actual raw registry index, one manifest
   per requested platform, config and bound attestation blobs. All fetched
   digests/sizes are checked. The tested platform manifest/config/diff IDs must
   match exactly. Rebuilding a changed config leaves a private unpromoted
   candidate and refuses a verified result: test the actual pulled digest and
   supply fresh acceptance before continuing. Never retag an old receipt.

4. Read-only re-verification or later promotion uses the actual candidate digest:

   ```text
   bun packages/suspenders/deploy/host/release/cli.ts verify --request request.json --acceptance acceptance.json --artifacts artifacts.json --digest DIGEST --output verification.json
   bun packages/suspenders/deploy/host/release/cli.ts promote --request request.json --acceptance acceptance.json --artifacts artifacts.json --digest DIGEST --execute --output published.json
   ```

   Replace DIGEST with the actual `sha256:` digest captured from the registry.
   Promotion rechecks privacy, tag absence, candidate digest and all verification
   before PUTting the exact already-verified index bytes to the independent
   version tag. It then resolves the version tag, verifies the chain again and re-reads actual private package/repository metadata before reporting success.
   Outputs use exclusive creation; preserve existing receipts and failed-path
   logs. If a post-upload/PUT verification or receipt write fails, inspect the
   registry before retrying; failure does not imply that no upload occurred.

GHCR provides no atomic create-only tag PUT. Serialize the authorized publisher;
a separate credential holder can race a tag write. Consumers must pin the verified
digest. Tag-absence checks and a digest re-read do not establish registry-enforced
immutability. Candidate cleanup/deletion requires a separate explicit decision;
the tool preserves failed private candidates for diagnosis.

## What verification records

The separate HOST envelope records publisher commit/helper and staged-recipe hashes, request hash, actual OCI index reference,
per-platform manifest/config/layer descriptors/diff IDs, provenance and SPDX
blob digests, closure/report identities, acceptance controls and truthful signature
status. The existing `HostSupervisorDescriptorSchema` produces its descriptor,
and its `flockInputs` contain exactly the existing SIX fields per platform.
No HOST role/evidence fields enter the strict Flock projection.

Runtime layer descriptors are recorded from the verified manifest; large runtime
layer payloads are not downloaded/rehashed by this metadata verifier. Closure
bytes come from the exact config-bound packaged acceptance, not host extraction
of registry layers. Registry JSON/attestation responses are capped at 8 MiB each
and 32 MiB per verification. Publisher HOST commands use the reviewed shared
guardian, irreversible deadlines, combined 8 MiB output caps and checked inherited
pipe/group teardown. Trusted descendants that deliberately detach are outside
that same-group tooling contract; Docker runtime containment is separate. The
build command has a 20-minute bound. Terminating its HOST client does not prove
a remote BuildKit job stopped; inspect the registry after any failure. SLSA v1 verification follows the
actual pinned BuildKit statement shape, including exact base-image purls and
checksum-pinned Docker/Pi notice dependencies. Unsupported shapes refuse.

Blob GETs may follow at most three HTTPS redirects to exact ghcr.io or
pkg-containers.githubusercontent.com origins, sharing one deadline and byte
budget. Userinfo/non-default ports/foreign origins refuse; bearer authorization
is permanently removed after crossing origin. Manifest and promotion requests
never follow redirects. Signed redirect URLs and auth failure payloads are
redacted. This follows the [OCI redirect credential rule](https://github.com/opencontainers/distribution-spec/blob/main/spec.md).

## Focused verification

```text
bun run node_modules/@playwright/test/cli.js test --config packages/suspenders/deploy/playwright.config.ts packages/suspenders/deploy/host/release --project=unit
qlty check packages/suspenders/deploy/host/release/*.ts
```

These checks use synthetic OCI graphs, an injected publisher driver and bounded
trusted HOST child witnesses. They issue no image builds, registry pushes,
package creation, model calls or activation.
