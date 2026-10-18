# Installing AICraft as an agent inside DeepSeek Harness

Follow this guide when the user asks you to install AICraft. Install the plugin in the current DSH profile. Do not modify the user's projects or tasks.

## Manager route: preparation

1. Find the built-in `plugin_manager` tool, normally enabled in Creator mode. If it is unavailable, explain this and offer the user a choice: switch to Creator mode, or continue without it using the CLI route below. Wait for their choice; missing Creator mode does not prevent building the package. If they switch, resume the manager route. Do not use the alternative route to bypass denied approval.
2. DeepSeek Harness **0.2.0-rc.2**, GitHub Releases access, and npm registry access are required. Check the current runtime version: the built-in `plugin_manager` with `action: "list_version_exemptions"` returns `runtimeVersion`. This action only reads data; do not grant compatibility exemptions.
3. Respect DSH approval requests. Plugin management requires approval for the call or an appropriate access mode. Do not bypass denied or unavailable approval. Do not change the session's access mode to install the plugin.
4. Call `plugin_manager`:

```json
{"action":"list_bundles","limit":100}
```

Follow `nextOffset` to read further pages. Look for `dsh-aicraft`. If the required version is already installed, enabled, and has no errors, do not reinstall it. If the same version is installed but disabled, enable it with `action: "set_bundle", target: "dsh-aicraft", enabled: true` and proceed to verification. Do not remove an existing plugin just to check it.

## Obtaining the package URL

Use only [Releases from the official AICraft repository](https://github.com/ChernyakAI/dsh-aicraft/releases). Select the version requested by the user, or the latest stable release if no version was specified.

Use the GitHub API to retrieve the assets of the latest stable release:

```text
https://api.github.com/repos/ChernyakAI/dsh-aicraft/releases/latest
```

Find `dsh-aicraft-<version>.tgz` in the release's `assets` and use its `browser_download_url`. Pass the direct HTTPS archive URL to the manager, not a release page, repository, or source archive. If the release or package is missing, report this and build it from the official repository following [Building from source](build.md). Never invent a URL; install the resulting local archive only after confirming that DSH can access it.

You do not need to download the archive to Downloads or determine the OS username: `plugin_manager` fetches the archive by URL in DSH's own environment and installs it in the current profile. The DSH machine needs access to GitHub Releases and the npm registry, even if agent tools have internet access in another environment.

If the user supplies a local archive, an absolute path is acceptable only after confirming that the file exists and is accessible to the DSH manager on its machine. Do not guess a path through `C:/Users/<user>` or assume that a path in a container or on a remote machine is accessible to DSH. If shared access cannot be confirmed, use the release URL or report the obstacle.

## Archive verification

### Downloaded release archive

Compare the downloaded file's SHA-256 with its entry in `SHA256SUMS` from the same release. A mismatch means the archive is not byte-for-byte identical: stop installation and report it. Matching extracted files do not make a failed release checksum pass; do not rewrite or recompress the archive to obtain a match.

Only claim verification for the actual archive being installed. `plugin_manager` has no `SHA256SUMS` parameter; direct URL installation does not verify the publisher's checksum. If prior verification is required, verify a local archive accessible to DSH and install that exact file, or report the unmet requirement.

### Locally built archive

Compute a new SHA-256 for the finished local package and save it alongside that package. The release's `SHA256SUMS` describes the published archive, not every independently built package. Different hashes may reflect packaging metadata, including gzip timestamps, even when extracted files match.

If reproducibility comparison is requested, report archive byte equality separately from extracted-content equality and identify any metadata differences. Do not describe matching contents as a successful release-checksum verification.

## Installation

When updating an existing AICraft installation, make sure its executors have finished before changing the package. Follow the user-authorized update: first remove the old bundle using `plugin_manager` with `action: "remove_bundle", target: "dsh-aicraft"`, check the result, then install the new package using the selected release URL. If only initial installation was requested but the plugin already exists, clarify before turning the request into an update. On `stop-profile` or `bundle-in-use`, stop the update and explain that the user must fully quit DSH and perform installation; do not terminate the current session yourself or install over a failed removal.

To install, call the tool with the direct archive URL. The example below shows the format only; use the actual `browser_download_url` from the release:

```json
{"action":"install_bundle","target":"https://github.com/ChernyakAI/dsh-aicraft/releases/download/<tag>/dsh-aicraft-<version>.tgz","enabled":true}
```

The same call works on Windows, Linux, and macOS; no local path or CLI profile selection is needed.

Do not infer success from pnpm output alone. Check `packageResult.exitCode`, if present, as well as `error` and `application` in the operation result. `failed`, `cancelled`, and `overridden` do not mean successful activation. If DSH reports incompatibility, do not grant a compatibility exemption: report the required and actual versions. If `pendingBuilds` is returned, ask the user for separate permission to run installation scripts; pass `approvedBuilds` only after explicit approval for the listed packages. A general request to install the plugin is not sufficient approval for those scripts.

## Alternative without Creator mode

If the user chooses to continue without Creator mode, obtain a release archive or build one following [Building from source](build.md). Identify the CLI belonging to their actual DSH installation and the active profile; do not guess a profile or edit profile files by hand. Check that the archive is accessible in the CLI's environment and use:

```sh
dsh plugin --profile <confirmed-profile> add "<absolute-path-to-archive>"
```

For an authorized update, wait for executors to finish, remove the old package with the same CLI and confirmed profile, then add the new archive. If the running profile prevents installation or removal, preserve the package and give the user the remaining commands to run after fully quitting DSH; do not terminate your own session. If CLI access is unavailable, still prepare the package and explain how the user can install it through **Plugins → Add plugin**. Report preparation, installation and activation separately; building alone is not installation.

Verify the CLI result and installed bundle in the confirmed profile. The manager-specific checks below apply only when `plugin_manager` is available. Both routes require the full restart described below.

## Verification and completion

Request `list_bundles` again: `dsh-aicraft` must appear in the required version with `enabled: true` and no error. `enabled` represents a saved selection, not proof of loading.

- For `application: "applied"`, also request `list_plugins` with pagination and check plugin entries using the identifiers in the bundle's `rows`. Do not report the plugin as loaded if its entries have errors or are inactive.
- For `application: "restart-required"`, report that the package is installed but activation awaits a restart.
- Recommend a full DSH restart after installing or updating AICraft. In Desktop, use **Quit DeepSeek Harness**, then launch again; closing the window is insufficient. Do not terminate the DSH instance running this session yourself.

Briefly report the installed version, activation result, and whether a restart is needed. After restarting, the user can open AICraft in the sidebar. If verification is incomplete, name the remaining step instead of claiming full readiness.

References: [DSH 0.2.0-rc.2 plugin manager](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/boot/plugin-manager/README.md) and [plugin_manager tool contract](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/boot/plugin-manager/src/tools.ts).
