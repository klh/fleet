# Existing published seed qualification

`test/qualify-existing.ts` qualifies only the immutable b57 index. It does not
build, tag, publish, install dependencies, or alter running Fleet services.
The caller supplies the reviewed HOST `hostProcess` guardian through the narrow
`ProcessRunner` interface; there is no default subprocess fallback or production
dependency on the Suspenders package. Use the committed 0247a701 helper closure
for the external qualification driver, with its source identity recorded.

Run each platform and each mode (`main`, `fallback`, `neutral`, `unkeyed`) separately.
The main mode checks finite 60-second scoped credentials, identity/discovery,
control-key inference/admin denial, synthetic SSE and revocation. Fallback setup
is checked through the real policy loader. Fixture limits are operator pins,
not provider/hardware claims. Seven core catalog fields are required; admission
is optional. Fresh database failures refuse qualification; no live DB upgrade or
locked-database repair is attempted.

Execution binds the published platform manifest to the actual container config,
checks source/recipe labels, UID/guest architecture and resource limits, then
stops and joins the UUID-owned producer before full-CID removal and absence checks.
Any ownership/cleanup uncertainty retains private fixture files and refuses a
success result. Raw credential-bearing inspection output and key responses stay
in memory. Returned facts contain neither secrets nor private filesystem paths.

Docker containerd may report an index as `.Image`/`.Id`; these values are recorded
as opaque local image IDs. Selection instead requires the container's exact
`ImageManifestDescriptor` and platform. Bounded image-save/archive reads verify
raw manifest/config SHA256 bytes before parsing and compare config labels and
rootFS with platform-specific inspection. CLI pretty-printed JSON is not hashed.

Running keyed fixtures use the existing authenticated `/v1/admin/drain` with a
250ms grace through exact-CID Docker exec before checked stop/join. This uses only
the isolated fixture's admin credential, never a control credential. Bare SIGTERM
does not invoke f19's planned drain. Primary refusals are recorded before teardown;
if teardown also fails, both errors survive. The unkeyed boot negative has no
admin credential: its graceful-cleanup disposition remains unresolved, and exit137
must not be presented as clean qualification.

The historical f19 builder and receipts are preserved for provenance. This new
qualification does not invoke that builder or assert its readiness for a new
publication. Local amd64 execution on an arm64 Docker Desktop host is emulation.
