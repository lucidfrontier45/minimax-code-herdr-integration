# herdr-integration (MiniMax Code plugin)

Reports MiniMax Code (`mcode`) lifecycle state to [Herdr](https://herdr.dev) so the
agent shows up in the Herdr sidebar as `working` / `idle` / `blocked`, and so Herdr
can re-open the exact session after a server restart.

Protocol reference: https://herdr.dev/docs/add-herdr-support/

## How it works

MiniMax Code runs **plugin hooks**, not standalone user hooks (standalone hooks are
retired in mcode 0.6.x — the runtime reports
`"hooks": {"status": "retired", "reason": "Standalone user hooks are no longer supported. Custom hooks belong to Plugins."}`).

So this is a normal local plugin:

```
~/.minimax/plugins/herdr-integration/
├── .minimax-plugin/plugin.json     # MiniMax plugin manifest (v1)
├── hooks/hooks.json                # hook definitions
├── bin/herdr-report.cjs            # the reporter (POSIX + Windows)
├── scripts/                        # launchers (see below)
│   ├── mcode-herdr                 # POSIX (bash)
│   ├── mcode-herdr.cmd             # Windows (cmd.exe shim)
│   └── mcode-herdr.ps1             # Windows (PowerShell)
└── icon.png
```

`mcode` picks up every directory under `~/.minimax/plugins/` automatically — no
`mcode plugin add` needed. Editing the plugin is picked up on the next session.

### Event → Herdr state

| mcode hook event    | Herdr state | meaning                                   |
| ------------------- | ----------- | ----------------------------------------- |
| `SessionStart`      | `idle`      | session opened, waiting for the first prompt |
| `UserPromptSubmit`  | `working`   | a turn started                            |
| `PreToolUse`        | `working`   | tool call in flight                       |
| `PostToolUse`       | `working`   | tool call finished                        |
| `PermissionRequest` | `blocked`   | waiting for the user to approve something |
| `Stop`              | `idle`      | turn finished, agent ready for input      |
| `SessionEnd`        | *(release)* | the user quit; the pane goes back to Herdr |

Every state report also carries the resume command
(`mcode --session <session_id>`) and `--agent-session-id`, and `--seq` is a
monotonically increasing number persisted in the plugin data dir, so late or
out-of-order reports can never overwrite newer state.

## Why there is also a wrapper (`mcode-herdr`)

MiniMax Code creates its session **lazily**. A freshly launched TUI has no
session id yet, and no plugin hook fires until the first prompt is submitted —
`SessionStart` is dispatched with the first turn, not at process start. A plugin
alone therefore can only tell Herdr "an agent is here" *after* the user already
typed something.

The launcher scripts live in `scripts/` next to this README:

| file             | platform            |
| ---------------- | ------------------- |
| `mcode-herdr`    | Linux/macOS (bash)  |
| `mcode-herdr.ps1`| Windows (PowerShell)|
| `mcode-herdr.cmd`| Windows (cmd shim)  |

`mcode-herdr` closes that gap. It runs in the pane's shell — where
`HERDR_PANE_ID` and `HERDR_BIN_PATH` *are* available — and reports the agent as
`idle` before handing over to `mcode`:

```
mcode-herdr              # report idle, then exec mcode
mcode-herdr --session ID # report idle + session id + resume command
mcode-herdr --report-only
```

On POSIX it is put on `PATH` with a symlink, so the shell functions below can
find it:

```
ln -sfn ~/.minimax/plugins/herdr-integration/scripts/mcode-herdr ~/.local/bin/mcode-herdr
```

`~/.bashrc` and `~/.zshrc` define a `mcode` shell function that routes
interactive launches through the wrapper and leaves non-interactive ones
(`mcode exec`, `mcode plugin`, `mcode --version`, …) untouched. The resume
command Herdr restores with is plain `mcode --session <id>`, so a restored pane
does not depend on the wrapper.

## Pane resolution

`herdr pane current` maps a terminal to a pane, but that mapping can be stale
for panes created by a split — a freshly split pane was observed resolving to
its sibling, which put the report in the wrong pane. The plugin therefore
resolves the pane from the process tree instead:

1. the pane used last time for this session, if it still hosts us;
2. `herdr pane current`, if its foreground process or shell is an ancestor of
   the hook process;
3. otherwise a scan of all panes (`herdr pane list` + `herdr pane process-info
   --pane <id>`) for the pane whose foreground process or shell is an ancestor.

The result is cached per session id under `PLUGIN_DATA/panes/`. The scan costs
~40 ms and only runs when the fast paths disagree.

## The two mcode-specific gotchas this plugin works around

1. **No `HERDR_*` in the hook environment.** mcode sanitizes the environment of
   hook processes: only `PATH`, `HOME`, `LANG`, `TERM`, `SHELL`, `USER`,
   `TMPDIR`, `TEMP`, `TMP`, `PATHEXT`, `SystemRoot`, `ComSpec`, `USERPROFILE`,
   `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, plus `PLUGIN_ROOT`,
   `PLUGIN_DATA`, `MINIMAX_PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`,
   `CODEX_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `PLUGIN_DATA` and
   `*_PROJECT_DIR`. `HERDR_PANE_ID`, `HERDR_BIN_PATH` and `HERDR_ENV` are
   dropped. The reporter therefore resolves the pane with
   `herdr pane current` (which maps the calling terminal to its pane) instead of
   reading `$HERDR_PANE_ID`.

2. **A report must never land in the wrong pane.** See *Pane resolution* above:
   the pane is matched against the hook process's ancestors, not against
   Herdr's terminal-to-pane map, which can be stale for split panes.

## Manifest requirements that are easy to get wrong

MiniMax plugin manifests (`~/.minimax/plugins/<name>/.minimax-plugin/plugin.json`)
are validated strictly. All of these are **required**:

- `schemaVersion: 1`
- `name` matching `^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$` (lowercase, no spaces)
- `version` (semver), `description`, `author`, `displayName`
- `icon` pointing at a real `.png` / `.jpg` / `.webp` file
- `category` (one of `Studio`, `Design & Sites`, `Code`, `Business`, `Sales`,
  `Productivity`, `Science & Healthcare`, `Education`, `Other`)
- `exampleQueries`, `apps`, `mcpServers`, `skills` arrays — `skills` entries
  must look like `skills/<name>/SKILL.md`, `mcpServers` entries must end in
  `.mcp.json`, `apps` entries in `.app.json`
- at least one executable capability (hooks count)

A single violation makes the whole plugin fail to load **silently** — no hook
runs and no error is printed.

## Windows

The **plugin is the same on Windows** — `bin/herdr-report.cjs` is cross-platform
and the hook command resolves the plugin root inside node rather than in the
shell:

```
node -e "require((process.env.MINIMAX_PLUGIN_ROOT || process.env.PLUGIN_ROOT) + '/bin/herdr-report.cjs')"
```

That matters because a hook command runs through the platform shell: `$VAR`
only expands on POSIX shells and `%VAR%` only on `cmd.exe`, and MiniMax hook
definitions do not accept an `args` array. Letting node read
`process.env` sidesteps both.

What differs on Windows:

- **Process tree.** There is no `/proc`, so the ancestor chain is read from
  `Win32_Process.ParentProcessId` through PowerShell (`Get-CimInstance`).
  That costs roughly half a second, so the result is cached per session in
  `PLUGIN_DATA/panes/<session>.json` and reused for every later event.
- **The launcher.** `mcode-herdr` has to be a PowerShell script instead of a
  bash script. Copy `scripts/mcode-herdr.cmd` and `scripts/mcode-herdr.ps1`
  into a directory on `PATH` — `%USERPROFILE%\.minimax\bin` (added by the
  MiniMax Code installer) or `%LOCALAPPDATA%\Programs\Herdr\bin` (Herdr's own
  stable alias) both work.
- **The shell hook.** To get launch-time reporting, add this to your
  PowerShell profile (`$PROFILE`):

  ```powershell
  function mcode {
      $first = if ($args.Count -gt 0) { $args[0] } else { '' }
      if ($first -in @('exec','acp','app-server','plugin','login','logout',
                       'update','provider','tools','--version','-v','--help','-h')) {
          & mcode.cmd @args
      } else {
          & mcode-herdr.cmd @args
      }
  }
  ```

- **Sequence numbers.** The wrapper and the plugin must share one counter, or
  Herdr rejects the lower number as stale. Both write
  `%USERPROFILE%\.minimax\v2\plugin-data\hooks\herdr-integration\seq` (and
  `~/.minimax/v2/...` on POSIX), which is computed from the home directory
  rather than from `PLUGIN_DATA` so the two sides always agree.

Herdr's own Windows support covers the rest: `Supported agent self-report
integrations: supported` — `herdr pane report-agent` and `release-agent`
behave the same on Windows.

Caveat: the Windows launcher and the PowerShell-based process-tree lookup were
written against Herdr's Windows documentation but **not executed on a Windows
host**, so treat them as unverified until you run them there. The Linux path is
verified end to end.

## Troubleshooting

Hook activity is traced to:

```
~/.minimax/v2/plugin-data/hooks/herdr-integration/herdr-integration.log
```

Check the live state with:

```bash
herdr agent list
herdr pane current          # which pane this terminal belongs to
```

If the agent is missing from `herdr agent list`, the plugin did not load —
re-check the manifest rules above. If the log says
`skipped: not running inside a Herdr pane`, the pane-identity check failed.
