<!--
FILE: plugin/docs/agents/install.md
DESCRIPTION: Locate and verify an AICraft installation through native DSH tools
-->
# Installing AICraft as an agent

Use DSH's built-in `plugin_manager` in the current profile. Inspect the existing installation and compatibility before installing the requested release; keep a working installation if it already satisfies the request.

## Sources

- [Official index](https://raw.githubusercontent.com/ChernyakAI/dsh-aicraft/master/dsh-plugin-index.json): use the selected entry's exact Git commit.
- [Official Releases](https://github.com/ChernyakAI/dsh-aicraft/releases): use the actual `.tgz` asset of the selected release.

Both routes provide a ready plugin. For a source build, see [build.md](build.md).

## Installation and completion

Follow the manager's documented operations and approval flow. Git installations update through **Update** in Discover; the agent tool does not expose that operation. Manual UI steps are in the [user guide](../install.en.md).

If the manager is unavailable, ask whether to enable it or use the actual DSH CLI with a confirmed profile. Do not change user projects or tasks.

Check the installed version and actual plugin loading. Report any required restart; do not terminate the DSH session running this agent. Report incomplete installation or activation explicitly.

## Archive verification

Compare the exact downloaded release archive against its `SHA256SUMS`; stop on a mismatch. Direct installation by URL through the manager does not itself confirm this check. A locally built archive has its own checksum, separate from the published release checksum.
