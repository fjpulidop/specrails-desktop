# Project environment

Some projects need a credential at run time, such as `NODE_AUTH_TOKEN` for private npm packages. In **Project Settings → Environment**, add the **names** of the variables your rails and loops need. Specrails stores only the names, never the values.

## Where the values come from

When a run starts, Specrails reads each configured name from the environment it was launched with. When you open Specrails from the Dock or Finder, that environment does not include what your shell profile exports, so Specrails also reads the missing names from your login shell (for example `~/.zprofile` or `~/.zshrc`). Keep the real credential in your shell profile, not in the repository.

The check runs in the background when the project opens, when you change the names, and regularly afterwards, so a slow profile does not delay your runs. Values stay in memory for that project only.

## Reading the status chips

Each saved name shows a chip:

| Chip | What it means | What to do |
|------|---------------|------------|
| **Inherited** | Specrails was started with the variable. | Nothing. |
| **From login shell** | Specrails read it from your login shell. | Nothing. |
| **Not defined** | Your login shell does not export it. | Add an `export` for it to your shell profile. |
| **Shell timed out** | Your login shell took too long to start. | Speed up the profile, or raise `SPECRAILS_LOGIN_SHELL_TIMEOUT_MS` (default 10 seconds). |
| **Shell check failed** | Specrails could not read your login shell. | Fix the profile, or launch Specrails from a terminal. |

Hover a chip for the explanation. After fixing your profile, click **Check again**: you do not need to restart Specrails.

If a run starts while a name is unresolved, its log shows one `[environment]` line naming the variable and its status. The run still starts. The value is never shown in the app, the logs or the MCP tools.

On Windows, Specrails uses only the environment it was started with.
