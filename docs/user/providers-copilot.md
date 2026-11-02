# GitHub Copilot

GitHub Copilot is disabled by default. Install the
[Copilot CLI](https://github.com/features/copilot/cli) with
`npm install -g @github/copilot` on the machine hosting your environment, then
run `copilot login` as the account that runs T3 Code.

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable **GitHub Copilot**. Set **Binary path** if `copilot` is not on the
host's `PATH`. Refresh provider status after installation or login, then select
Copilot in a thread's model picker.

To use a token instead of the saved login, add `COPILOT_GITHUB_TOKEN` to the
instance's environment variables. For a separate account, add another provider
instance and configure its token; instances without a token use the host's saved
Copilot login.

## Models

Models, reasoning levels, and context tiers come from your Copilot account on
the selected host. The **Auto** model lets Copilot choose a model. Refresh provider
status after your plan or organization policy changes. For models with reasoning
levels, T3 Code selects the reported default, or Medium when available. You can
change it in the model picker.

## Permissions and limitations

Copilot supports every [permission mode](./permission-modes.md). Plan mode shows
Copilot's plan in the thread; send a follow-up to implement it.

Copilot subagents appear as their own threads under the conversation. You can
steer a running turn, queue follow-ups, rewind the conversation, and fork a
thread from a completed turn. Copilot token use appears on **Usage**; these
cost estimates are not your Copilot bill or premium request count.

Copilot can use T3 Code's tools. Install, sign in, and update Copilot on each
host where you want it to run; connecting devices do not need it installed.
Updates can run from **Settings → Providers** when T3 Code recognizes how the CLI
was installed.
