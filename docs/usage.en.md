# Using AICraft

[Русский](usage.md) | English

## Project directory structure

Project settings and task data are stored as files in `.aicraft/`, alongside the source code. When using Git, the full work history is preserved.

Directory structure:

```text
.aicraft/                        # Project settings, knowledge, and tasks
├── project-rules.md             # Shared instructions for the project's agents
├── request.md                   # Requirements template for new tasks
├── accounting.json              # Internal execution accounting data for usage statistics
├── config/                      # Process and role settings
│   ├── processes/               # Processes available when creating a task
│   │   └── <process-id>.jsonc   # Name, steps, roles, and models of one process
│   └── roles/                   # Roles available to the project's processes
│       └── <role-id>.md         # Editable instructions for a particular role
├── knowledge-base/              # Project knowledge: requirements, decisions, reference material
└── tasks/                       # All project tasks
    └── <task-id>/               # Data and results of one task
        ├── request.md           # This task's requirements and acceptance criteria
        ├── state.json           # Task status and the states of its steps
        ├── process.json         # Copy of the process selected when the task was created
        ├── runs.json            # Run history and links to executor chats
        └── <step-id>/           # Working materials for one step
            ├── input-prompt.md  # Saved assignment for launching the executor
            ├── report.md        # Executor's final report
            └── ...              # Other step documents and artifacts
```

Replace identifiers in angle brackets with your process, role, task, and step names. Role and step directories are populated as you configure the project; prompts, run history, reports, and accounting data appear as work progresses. Internal `.gitkeep` files preserve empty directories in Git and are omitted from this diagram.

Editing a process template does not change an existing task: it uses its own `process.json`. Chats themselves are stored by DSH, outside the task directory.

Shared sections of a new input prompt use the demo process language. Manual and legacy processes without a `language` field use English. Project rules and role instructions determine the response language. A saved prompt changes only through Reset to default and explicit saving.

## Data, Git, and usage statistics

Task settings, requirements, states, and artifacts are stored in the `.aicraft/` directory of your project. You can track them in Git alongside the source code. The plugin does not create branches, commit, or merge changes. If the current branch differs from the branch where the task was created, a warning showing both branch names appears below the task list.

Only one open task is allowed in the current project state. Use separate branches or working directories for parallel tasks. If a merge leaves several tasks open, commands that modify data are blocked; return to the required task's branch or reconcile the task states.

The panel updates in response to events. Use **Refresh task** to reload data if needed. Usage statistics update after execution finishes. **Cost** sums available estimates for supported DeepSeek models only; local and other models are not included. Estimates use rates embedded in the plugin. Prices are not updated online. See **Details** and **Detailed usage** for more information.
