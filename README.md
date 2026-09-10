# deepseek-acp

**English** | [简体中文](README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/deepseek-acp)](https://www.npmjs.com/package/deepseek-acp)
[![npm monthly downloads](https://img.shields.io/npm/dm/deepseek-acp)](https://www.npmjs.com/package/deepseek-acp)
[![CI status](https://github.com/xintaofei/deepseek-acp/actions/workflows/ci.yml/badge.svg)](https://github.com/xintaofei/deepseek-acp/actions/workflows/ci.yml)

Turns [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) into a
**full-featured editor-facing coding agent** that communicates with clients over the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP).

**Supported clients**: any editor that implements ACP. Development testing is done with
**[codeg](https://github.com/xintaofei/codeg)**. **[Zed](https://zed.dev)** uses the same protocol
and can be configured as shown below, but has not yet been validated feature by feature.

---

## Why This Exists

DeepSeek Harness ships with an ACP server (`@deepseek-ai/dsh-acp`), but it is designed for
**automation only**, not for human interaction. The upstream description is explicit:

> This package is a transport adapter, not a UI integration or a capability seam.
> It does not expose editor navigation, transcript replay, commands, modes,
> configuration pickers, elicitation, reasoning, plans, titles, or tool presentation.

Its primary client is `dsh-subagent-acp`, a channel through which a parent harness spawns child
agents. That design is right for this use case: it emits only **committed** assistant messages,
omits uncommitted intermediate state, and returns a clean automation result.

The same design falls short inside an editor:

- **You cannot see what the model is doing.** Tool calls, command output, and file changes remain
  only in the session log; the UI shows nothing but the final text. If the model edits your files,
  you have to run `git diff` yourself to find out what changed.
- **There is no token-by-token streaming.** Updates arrive only after a complete message is
  committed, leaving the UI motionless during long responses.
- **Sessions are disposable.** Once closed, they are gone: there is no restore, list, or title.
- **There is no control surface.** You cannot switch models, change file permissions, enable plan
  mode, or run slash commands.
- **MCP is rejected.** Any non-empty `mcpServers` value fails immediately.

The upstream project actually built a complete editor-facing bridge, then deliberately removed it
on 2026-07-24 for product-positioning reasons, not because it was technically infeasible. **This
project fills that vacated niche**: the same harness core, with a protocol surface designed for
humans.

---

## Feature Comparison

| Feature | `@deepseek-ai/dsh-acp` (built in) | **deepseek-acp** (this project) |
|---|---|---|
| Purpose | Automation-only transport adapter | Full editor-facing agent |
| Response streaming | Only after a complete message is committed | Token by token |
| Reasoning | No; remains in the log | Yes; `agent_thought_chunk` |
| Tool calls | No presentation | Cards with status transitions |
| File diffs | No | Native editor diff view |
| Terminal output | No | Terminal cards using the Zed `_meta` convention |
| Task plans | No | `plan` updates and plan mode |
| Session restore / list | No; sessions disappear when closed | `load` / `list` / `resume` / `close`, with titles |
| Session forks | No | `session/fork`, with separate parent and child logs; forks at a chosen message when the client names one |
| In-session model switching | No | Model, reasoning level, and file-permission selectors |
| Slash commands | No | Command catalog; commands do not enter model context |
| Skills | No | Loaded by the model on demand; user-invocable skills appear in slash completion |
| Model-to-user questions | No | Form elicitation, with a button fallback for unsupported clients |
| MCP servers | No; rejects non-empty values | Per-session mounting, stdio and HTTP, isolated between sessions |
| Context usage | No | `usage_update` progress indicator |
| Unsaved buffers | No | Routes `fs/read_text_file` through the editor |
| Embedded context (`@` files) | No; `embeddedContext: false` | Fully inlined |
| Image input | No; `image: false` | Preserves interleaved order; bytes stored in a content-addressed store |
| Permission prompts | One-time allow / reject | Same, plus elevation for sandbox boundary crossings |
| Multiple sessions | Yes | Yes |

**Sandboxing.** Commands and file operations share the same boundary. The default mode is
`workspace-write`, with writable roots set to `{session cwd, system temporary directory}`. Shell
and file tools use the same policy definition. Boundary crossings are rejected, and the model can
request elevation for a single operation through `session/request_permission`.

Windows uses the system PowerShell, preferring PowerShell 7 and falling back to Windows PowerShell
5.1. The tool is named `pwsh`, and Git Bash is not required. Linux and macOS use `bash`. The Windows
ACL backend reports `enforcement: partial`: it restricts ordinary NTFS writes, but does not restrict
reads, network access, or process visibility, and does not promise coverage for WSL, FAT, Everyone
ACLs, or hard-link boundaries. If sandboxing is unavailable, execution is rejected instead of
silently falling back to unrestricted access.

**Built-in tools**: the platform shell (`pwsh` on Windows, `bash` on Linux and macOS), `read`,
`write`, `edit`, `glob`, `grep`, `todo_write`, `ask_user_question`, `exit_plan_mode`, and `lsp` when
supported by the current machine, as described below.

**Context compaction.** When a long session approaches the context-window limit, older messages
are automatically summarized into a replacement message instead of letting the next request fail
with a context-limit error. You can also run `/compact` manually. Clients that declare
`session.compaction` receive `compaction_update` and `compaction_summary_chunk` notifications that
show which segment was compacted and what summary replaced it. Other clients still get compaction,
but without progress updates.

**Repetition guard.** If the model repeatedly calls the same tool with identical arguments, the
agent injects an escalation prompt. It does not add anything to the tool catalog, reject the call,
or rewrite its arguments. The model retains control, so legitimate repeated calls continue to work.

**Image input.** Paste or drag images into the editor. Text and images enter the model in their
original interleaved order, so `before [image] after [image]` does not become
`before after [image] [image]`. Image bytes are stored in a content-addressed store under
`$DSH_HOME/attachments/`, while session logs contain references only. Writing base64 directly into
the log could make a single entry tens of megabytes, and every restore would have to read the whole
file. The default model, `deepseek-flash`, accepts images. On a text-only route the message is
rejected with a prompt naming the current model, so you know to switch in the model selector. PNG,
JPEG, WebP, and GIF are supported, with up to 20 images per message.

**Code navigation (`lsp`).** Language servers are connected automatically when installed; if none
are found, the entire tool is omitted. At startup, the agent scans `PATH` once for built-in
candidates (`typescript-language-server`, `pyright-langserver`, `gopls`, and `rust-analyzer`). This
is deliberate: the upstream stdio host resolves every executable while loading the plugin, so one
missing executable prevents any provider from registering. A hard-coded default table would mean
that missing `gopls` could disable editor integration entirely. To use a different server, such as
`deno lsp`, a project-local `node_modules/.bin/...` executable, or an in-house implementation, set
`DEEPSEEK_ACP_LSP_SERVERS` to a servers JSON value. It **replaces the entire built-in table**. The
tool itself is read-only and exposes four operations: `goToDefinition`, `findReferences`,
`goToImplementation`, and `hover`.

**Intentionally omitted**: delegation through `fs/write_text_file`, which would bypass the sandbox
and make the file-permission selector meaningless; background jobs, because updates from
self-initiated turns have no corresponding `stopReason`; and the upstream `packages/extensions/`
system (`cordis_define` / `cordis_run`). That system lets the model rewrite its own runtime inside
`node:vm` with a live service facade, bypassing the sandbox above, and its startup controls live in
an unpublished browser-side package. **Blocked by upstream limitations**: `session/delete`, because
the persistence backend has no delete or purge API, and the MCP `sse` / `acp` transports.

---

## Editor Setup

The executable is `deepseek-acp` and speaks ACP over stdio. **Starting the server requires no
arguments**: editors can launch it directly. The `--setup`, `--version`, and `--help` switches run
their action and exit without entering server mode. Any other arguments still start the server
normally. Editors may pass extra arguments for their own reasons, and rejecting them would turn a
working integration into a generic "connection failed" message.

There are two ways to provide an API key; choose one:

- **`deepseek-acp --setup`**: paste the key once in an interactive prompt. It is stored in
  `$DSH_HOME/.credentials.yaml` with mode `0600`. See [Login](#login) below.
- **Client environment variables**: both configurations below show where to set one.

**Do not rely on `export` in `.zshrc`.** GUI editors do not inherit the login shell environment,
and neither do the child processes they spawn. This is why `--setup` stores credentials in a file
independently of the launch environment.

### Login

During `initialize`, the server may advertise an ACP **Terminal Auth** method:

```json
{ "id": "terminal", "type": "terminal", "args": ["--setup"] }
```

It is sent **only to clients that declare support** through
`clientCapabilities.auth.terminal === true` or `_meta["terminal-auth"] === true`, a convention that
predates the capability flag. Without either signal, `authMethods` is an empty array, exactly as it
was before this feature existed. Terminal login is an opt-in method type, and advertising it to an
unprepared client would only cause problems. The top-level `clientCapabilities.terminal` flag does
**not** count: that flag indicates support for the `terminal/*` methods used by terminal cards, which
is a different feature.

Supporting clients launch the **same executable** with `--setup` in a separate interactive terminal
and wait for it to exit. **Exit code 0 means success**, after which they reconnect. You can run the
same command manually:

```sh
deepseek-acp --setup      # Paste the key and press Enter. Terminal input is hidden.
```

The stored credential key is `DEEPSEEK_API_KEY`, written to `$DSH_HOME/.credentials.yaml`. This
source takes precedence over the two `.env` layers, so an old key left in `.env` cannot override it.
An environment variable explicitly passed to the process still has the highest priority, because
it represents the intent for that particular run.

Advertising this method does **not** block session creation. This project never returns
`auth_required`; without a key, the first turn still fails with `MISSING_CREDENTIAL`. Terminal Auth
simply gives clients a login entry point.

### Zed

Add an `agent_servers` entry to `settings.json`:

```json
{
  "agent_servers": {
    "DeepSeek Harness": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "deepseek-acp"],
      "env": { "DEEPSEEK_API_KEY": "sk-..." }
    }
  }
}
```

If installed globally with `npm i -g deepseek-acp`, set `command` to `deepseek-acp` and leave
`args` empty.

### codeg

codeg **already includes** this agent, so there is no need to add a custom entry. Open
**Settings > Agents**, find **DeepSeek Harness**, and select **Install**. Once installed, the same
control becomes **Upgrade** and follows the version in codeg's built-in registry. The installed
package uses the same npx distribution shown above, so a prior global npm installation is not
required.

Enter the key in the **DeepSeek Harness Configuration** panel on the same page:

| Field | Description |
|---|---|
| API endpoint | Leave empty to use the official endpoint |
| API key | Passed to the agent as `DEEPSEEK_API_KEY`; **leave empty after using `--setup`**, because environment variables override the credential file |

**Save DeepSeek Configuration** affects only **new** sessions. Reconnect any running session to
apply changes. The model and reasoning level are not configured in this panel; they are
session-level selectors available from the input box.

Older codeg versions without the built-in entry can still use **Settings > Agents > Add Custom
Agent > Manual Configuration**. Set the registry ID to `deepseek-acp`, the distribution information
to `{"npx": {"package": "deepseek-acp@0.9.0", "cmd": "deepseek-acp"}}`, and the environment
variable to `DEEPSEEK_API_KEY=sk-...`; leave the version-query command empty. The **Version** field
must match the version in the distribution information. codeg checks them during preflight, and a
mismatch appears as a connection failure rather than a validation error.

When MCP is enabled, `codeg-mcp` is mounted as a server and the model sees tool names with a
**session prefix**, such as `mcp__a1_codeg-mcp__<tool>`. `serverName` is globally unique within a
process, while ACP's `mcpServers` is a per-session parameter. Without the prefix, a second session
could not mount the server.

### Session Logs

Logs are written to `$DSH_HOME/sessions` (`~/.dsh/sessions`) by default. Override the location with
`DEEPSEEK_ACP_SESSIONS_ROOT`. Session restore, listing, and titles all read from this directory.

---

## Acknowledgments

- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**: the core of this project.
  This adapter would not exist without it, and the former editor-facing bridge provided substantial
  guidance.
- **[LinuxDO](https://linux.do)**: the community where this project began.

---

## License

This project is licensed under MIT; see [`LICENSE`](LICENSE). **It is an unofficial community
adapter, is not affiliated with DeepSeek, and is not endorsed by DeepSeek.**

The repository contains no verbatim copies of third-party source code. However, substantial parts
of the **test suite and design** derive from the former DeepSeek Harness editor-facing ACP bridge
(`packages/ui/acp`, removed on 2026-07-24). **That snapshot is licensed under BSD-3-Clause, not the
MIT license used by the repository today**, because upstream changed its license only after the
deletion. Its original copyright notice and license text are included in [`LICENSE`](LICENSE) as
required by clause 1 of the BSD license.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) to contribute.
