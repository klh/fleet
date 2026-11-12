# Published supervisor seed 0.1.2-experimental.w2990.3

The private HOST seed is published at:

```text
ghcr.io/klh/fleet/supervisor-seed@sha256:75c3210657d2501cd8b9c8765199169980c9d3cc784db1d925c5a21789d8dc31
```

[descriptor.json](descriptor.json) is the canonical HOST descriptor, including
the strict six-field Flock projections. [published.json](published.json) is the
actual committed publisher's successful promotion result. Runtime source is
`7ba526c1dab00e543cdbcfb63d550631156568ea`, recipe is
`fe2e7e8052abea62079382350ecce3b63046cd47`, and publisher is
`503792087059417afb3e2b6a164590215bb1e683`. These are independent identities.

[published.raw](published.raw) retains the exact CLI output bytes;
`published.json` and [request.json](request.json) use canonical formatting with
unchanged JSON values. [acceptance.json](acceptance.json) and both evidence
reports retain the exact reviewed bytes. Closure artifacts remain external at
`/opt/fleet/runtime-closure.json` inside each exact platform-manifest-pinned image;
[references.json](references.json) records those pins, hashes and replay needs.
They must be obtained and hash-checked before supplying an artifacts input to
the committed CLI's read-only `verify` command. [manifest.json](manifest.json)
hashes every receipt attachment except itself using the stated algorithm.

[progression.json](progression.json) preserves the first upload's post-write
association refusal, the operator's documented Connect Repository repair, the
read-only recovery, and successful promotion without rebuilding or uploading
another image. [first-upload-failure.log](first-upload-failure.log) is the exact
sanitized failure output. Original local acceptance is unchanged; registry
index, local OCI index, platform manifest and config retain distinct meanings.

[references.json](references.json) points to immutable Git evidence and external
content-addressed registry metadata. Original local acceptance is committed at
`8256c86fe2728570a58e492e1b26f80230d4eafa`. Supplemental tests against both exact
pulled platform manifests are committed at
`97db696d60a682dc55d6e80edb8fdaedb8ee4444`: 10/10 controls passed, with four
positive HOST CID bindings and four guest observations. Three observer operation
diagnostics remain separate; the observer is not described as entirely
successful. Raw OCI attestations remain external registry blobs identified by
digest; transient review packet hashes are audit identifiers, not promised
attachments.

Qualification used scripted-local Docker Desktop, including an emulated amd64
HOST and observed arm64 guests. It establishes no real-provider quality,
native-amd64, H100, Azure or full-HOST activation result. Signatures remain
`not-inspected`. Provenance/SPDX verification checks content-addressed metadata;
runtime layer payloads were not downloaded and rehashed by that verifier. The
image's build-time continuity label remains `unverified`; the separate receipt
records tested continuity. Consumers must pin the digest because GHCR tag PUT
does not provide an atomic create-only guarantee.
