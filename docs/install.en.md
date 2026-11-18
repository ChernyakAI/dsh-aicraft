# Installing, updating and uninstalling AICraft

[Русский](install.md) | English · [AICraft](../README.en.md)

## Installation

Install AICraft through **Discover**, the plugin list in DSH, or from a **GitHub Releases** archive. Both provide a ready plugin; building AICraft is unnecessary. Dependencies require npm registry access; Git installation also requires Git and access to GitHub.

### Through Discover
<a id="discover"></a>

1. Install a version of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) compatible with the plugin version you are installing. Enable **Custom plugin indexes** in **Plugins**.
2. Open **Plugins → Discover → Index sources** and add:

   `https://raw.githubusercontent.com/ChernyakAI/dsh-aicraft/master/dsh-plugin-index.json`

3. Click **Refresh**, find **AICraft**, choose a compatible version in **Versions**, and click **Install**.
4. Check the manager result and the actual installed version in **Plugins**. Stop on an error and resolve its stated cause; do not bypass incompatibility with a DSH version exemption.
5. Fully quit DSH and launch it again. In Desktop, use **Quit DeepSeek Harness**. Open **AICraft** in the sidebar.

If the source is unavailable or the required version is missing, use the published archive below.

### From a GitHub Releases archive

> The plugin manager is available to agents in **Standard** and **Creator** when the current DSH profile is available.

1. Install a version of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) compatible with the plugin version you are installing.
2. Download the plugin installation archive (`.tgz`) from [Releases](https://github.com/ChernyakAI/dsh-aicraft/releases).
3. In DSH, open **Plugins → Add plugin**, enter the path to the downloaded archive, and install it. Do not unpack the archive. Access to the npm registry is required to install dependencies.
4. Fully quit DSH and launch it again. In Desktop, use **Quit DeepSeek Harness**: closing the window may leave the application running in the system tray.
5. Open **AICraft** in the sidebar.

If you use the CLI, add the archive to the profile you use to run DSH:

```sh
dsh plugin --profile <profile> add "<path>/dsh-aicraft-<version>.tgz"
```

Desktop uses the `desktop` profile; the standard Web setup uses `web`. The `dsh` command must belong to your DSH installation.

## Updating
<a id="updating"></a>

For a Git installation, open **Discover** and click **Refresh** to fetch the version list. Refresh changes only the list. To update AICraft itself, wait for executors to finish, select the available update, and confirm **Update**. Check the version and loading result, then fully restart DSH. Follow the manager error if the update fails; restoration of the previous version is not guaranteed.

For an archive installation, keep the existing procedure: wait for the agent to finish its work. Remove the previous plugin through **Plugins**, install the new `.tgz`, and fully restart DSH. Removing the package preserves the `.aicraft/` files in your projects.

If AICraft does not appear or a new command returns HTTP 404, check the DSH version and selected profile, and make sure you fully quit the application before restarting it.

## Uninstalling
<a id="uninstalling"></a>

1. Wait for AICraft executors to finish.
2. Open **Plugins**, select the installed **dsh-aicraft** package and remove it. This applies to both Git and archive installations.
3. Check the manager result, then fully quit and restart DSH. In Desktop, use **Quit DeepSeek Harness**.

Removing the plugin preserves the `.aicraft/` files in your projects. The Discover index is a separate source of the version list; removing it does not uninstall AICraft.
