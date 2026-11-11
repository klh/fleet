# Fleet HOST supervisor seed (experimental preparation)

This packages the production `runner-control.ts` service, its official Pi Durable
dependencies, Bun, and the static Docker CLI. The reserved image identity is
`ghcr.io/klh/fleet/supervisor-seed` (family `supervisor`, role `host`, service
`runner-control`). There is no published HOST descriptor yet.

The initial source under test is `bbe638a4aa2f6c864bf98f3cc4f496da11cb52f9`.
Checkpoint continuity is **unwired** at that source. Packaging and local checks
do not establish restart-safe deployment readiness. Publication remains blocked
until the complete continuity implementation and negative controls pass against
an exact committed source. No model weights, Pi CLI, BLAM, judges, checkout,
keys, profiles, or journals belong in the final image.

Build from separate immutable source and recipe commits, using the committed
helper. Substitute the reviewed recipe commit; no runtime package installation
is performed. `--plan` emits a local-only plan; removing it builds and loads one
architecture. The helper has no publication mode.

```sh
bun packages/suspenders/deploy/host/build.ts --source bbe638a4aa2f6c864bf98f3cc4f496da11cb52f9 --recipe RECIPE_COMMIT --version 0.1.0-experimental.w2990.3 --platform linux/arm64 --plan
```

The helper archives committed source, stages regular recipe blobs independently,
and uses an isolated context. The shared health probe is explicitly overwritten
with the frozen recipe blob. Bun/Docker CLI base indices and Docker source
archive checksum are pinned in `contract.ts` and the Dockerfile. Only bundles,
closure inventory, license notices and the static CLI enter the final stage.
BuildKit local `--load` may discard attestations: requested provenance/SBOM is
not evidence of remote attestations or a verified signature.

Flock's existing strict per-platform contract remains six fields:
`schemaVersion`, `family`, `version`, full digest `image`, `sourceCommit`, and
`architecture`. A future release will supply these projections alongside the
HOST envelope with source/recipe/evidence metadata. A Flock derivative must have
its own version and preserve the parent service entrypoint, user and filesystem.
Copying `/etc/flock/profile.json` does not configure this runtime automatically;
a reviewed explicit settings adapter is required.

## Linux deployment contract

`compose.yaml` requires explicit host networking. The current runtime listens on
IPv4 loopback and forces `/var/run/docker.sock`; `DOCKER_HOST` does not select a
TCP broker. A mounted Docker socket grants host-level container authority even
when the supervisor process is nonroot. Supply the actual socket group as a
supplementary GID, and preload the pinned guest image on that same daemon.

Keep `FLEET_SUPERVISOR_HOSTNAME` stable and unique for the journal's lifetime.
Job manifests bind `node:os.hostname()`. A random recreated container hostname
will invalidate legitimate reopen. Host networking does not imply shared UTS:
the checked recipe uses explicit `hostname`, without host UTS mode.

Provision state and seed directories as the nonroot UID, mode 0700. Mount each
at its **identical host absolute path**, since guest Docker bind mounts are
resolved by the host daemon. Container-only paths and arbitrary named-volume
aliases do not establish that mapping. Keys/profiles/settings are private,
owner-matched, regular files; keys are distinct mode 0600 files. Keep persistent
journals writable while the root filesystem and configuration remain read-only.

Run this command as the configured nonroot owner on the Linux Docker host,
before compose. The deployment JSON must be a private regular file containing
the fields of `HostDeploymentSchema` in `deployment.ts`; the command checks
owner/permissions, socket GID, identical configured paths and distinct private
credential contents, and prints only a redacted verdict.

```sh
bun --no-install packages/suspenders/deploy/host/deployment.ts --file /private/deployment.json
```

Then run the image with `--check` and the same mounts and identity.
`settings.example.json` intentionally refuses startup until a
verified guest digest is supplied. Profiles must use verified serving metadata
and an immutable matching profile digest; no example invents model capacity.
Mint authority needs admin WRITE and proxy READ. Owner control and health READ
credentials must be separate; health mounts neither mint key nor journal.

The health service is a separate process that authenticates GET
`/v1/runner/runs`. It uses the existing bounded monitor and confirming re-probe
policy and publishes only its own `/healthz` verdict on loopback. This proves
protected control-route reachability, not inference quality or continuity.
Docker Desktop tests are local fixture evidence, not a Linux production rollout,
H100/Azure activation, native amd64 performance, or signature verification.
