<!--
FILE: plugin/docs/agents/build.md
DESCRIPTION: Build and package the plugin in its supported development environment
-->
# Building AICraft from source

Node.js 24 LTS and pnpm 11.28.5 are required. The supported DSH version is 0.2.1-rc.5; no adjacent DSH checkout is needed.

From the root of the public repository, run:

```sh
pnpm install --frozen-lockfile
pnpm pack --pack-destination "<output-directory>"
```

Replace `<output-directory>` with an output directory appropriate to the user's request. `pnpm pack` checks types and builds the plugin automatically. On failure, stop dependent actions and report the cause.

Check the archive and the presence of `LICENSE` and `THIRD_PARTY_NOTICES.md`. Compute SHA-256 for this local build and save its own `SHA256SUMS` alongside it; do not use the published release checksum as its expected hash. See [archive verification](install.md#archive-verification) for the separate release and local-build checks. Keep Russian and English user documentation synchronized. Agent guides in `docs/agents/` are English only.

Building leaves `lib/`, `.build/`, and installed dependencies. Afterwards, remove only temporary files you created that are no longer needed; preserve source code, other people's changes, and the finished package.

Report the archive and checksum paths and the check results. Installing, publishing, and restarting DSH are outside the build task unless the user separately requested them.
