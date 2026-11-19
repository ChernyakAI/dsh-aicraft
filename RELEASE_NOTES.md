# Release notes

## Version 0.4.2

- Adds support for **DeepSeek Harness 0.2.2-rc.5**.

## Version 0.4.1

- Adds support for **DeepSeek Harness 0.2.2-rc.3**.
- Agents can coordinate staged work: inspect tasks, launch executors, review results and move between stages. At any stage, you can give the coordinator an instruction — see the [example and short guide](https://github.com/ChernyakAI/dsh-aicraft/blob/v0.4.1/docs/usage.en.md#coordinator).
- Adds interface translations for all eight DSH languages and an optional profile-wide OneC Dark theme.
- Adds reasoning effort selection for a stage or a single run; run history preserves the parameters actually used.
- Keeps AICraft navigation available when switching task conversations, with links to executor and caller chats.
- Improves role editing with resizable windows, heading recognition and confirmed deletion of instructions used by processes.
- Simplifies new default assignments and names new executor conversations with the stage's position and title. Existing assignments and conversations are preserved.
- Adds installation through a custom Discover index. Add the source, install AICraft and use Update for later versions — see [installation](https://github.com/ChernyakAI/dsh-aicraft/blob/v0.4.1/docs/install.en.md#discover) and [updates](https://github.com/ChernyakAI/dsh-aicraft/blob/v0.4.1/docs/install.en.md#updating). Release archive installation remains available.

## Version 0.3.1

- Adds support for **DeepSeek Harness 0.2.1-rc.5**.
- Fixed panel updates after connection loss.
- Trying to run an empty assignment now shows an error.
- The project knowledge list only includes `.md` files saved directly in the knowledge folder. Files in subfolders and links to files are not shown.
- The built-in reviewer instructions require a full task review, including after fixes.

## Version 0.2.1

- Adapted the plugin for DeepSeek Harness 0.2.1-rc.3.

## Version 0.0.1

Experimental version of the plugin for DeepSeek Harness.

- A workflow builder for different types of tasks.
- Project rules, role instructions, and editable step prompts.
- Model selection for each step or individual run, with separate executor chats.
- Artifacts, run history, execution time, and task expenses (DeepSeek models only).
- Complete, skip, and repeat steps; finish and reopen tasks.
- Collaboration through Git: settings and task data are stored in project files.
