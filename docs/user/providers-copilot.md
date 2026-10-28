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
instance's environment variables. Add another provider instance for a separate
account.

## Models

Models, reasoning levels, and context tiers come from your Copilot account on
the selected host. **Auto** lets Copilot choose. Refresh provider status after
your plan or organization policy changes.

## Permissions and limitations

Copilot supports every [permission mode](./permission-modes.md). Plan mode shows
Copilot's plan in the thread; send a follow-up to implement it.

Copilot subagents appear as their own threads under the conversation. You can
steer a running turn, queue follow-ups, rewind the conversation, and fork a
thread from any completed turn. Copilot token use appears on **Usage**.

Copilot can use T3 Code's tools. Install, sign in, and update Copilot on each
host where you want it to run; connecting devices do not need it installed.
Updates can run from **Settings → Providers** when T3 Code recognizes the npm
launcher.
