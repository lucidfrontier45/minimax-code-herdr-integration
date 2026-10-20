#!/usr/bin/env node
/**
 * herdr-report.cjs
 *
 * MiniMax Code plugin hook that reports this agent's lifecycle state to Herdr.
 *
 * Contract: https://herdr.dev/docs/add-herdr-support/
 *   - state   -> `herdr pane report-agent`   (idle | working | blocked)
 *   - session -> `herdr pane report-agent` with `--agent-session-id`
 *   - release -> `herdr pane release-agent`
 *
 * Cross-platform (Linux, macOS, Windows). The hook is started with
 *
 *     node -e "require((process.env.MINIMAX_PLUGIN_ROOT || process.env.PLUGIN_ROOT) + '/bin/herdr-report.cjs')"
 *
 * so that the plugin root is resolved by node itself instead of by the shell --
 * `$VAR` only expands on POSIX shells and `%VAR%` only on cmd.exe.
 *
 * Two mcode-specific constraints shape this script:
 *
 *  1. The hook process gets a sanitized environment (PATH/HOME/... plus
 *     PLUGIN_ROOT and friends). No HERDR_* variable survives, so the pane is
 *     resolved through Herdr instead of `$HERDR_PANE_ID`.
 *  2. Herdr's terminal-to-pane map can be stale for panes created by a split,
 *     so the pane is matched against the process tree: the pane whose
 *     foreground process or shell is an ancestor of this hook process.
 *
 * Every failure is swallowed on purpose: reporting must never slow down or
 * break the agent.
 */

"use strict";

const { spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const SOURCE = "mcode"; // integration id: stable, unique, never prefixed "herdr:"
const AGENT = "mcode"; // name users see in the sidebar
const HERDR_TIMEOUT_MS = 3000;
const IS_WINDOWS = process.platform === "win32";

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function herdrBin() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

function herdr(args) {
  return spawnSync(herdrBin(), args, {
    encoding: "utf8",
    timeout: HERDR_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function herdrJson(args) {
  const res = herdr(args);
  if (!res || res.status !== 0 || !res.stdout) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Process tree
 * ------------------------------------------------------------------ */

/** POSIX: walk /proc/<pid>/stat up the parent chain. */
function posixAncestorPids() {
  const pids = new Set();
  let pid = process.pid;
  for (let depth = 0; depth < 32 && pid > 1; depth += 1) {
    pids.add(pid);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm may contain spaces and parentheses, so start after the last ')'.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number.parseInt(fields[1], 10);
      pid = Number.isFinite(ppid) ? ppid : 0;
    } catch {
      break;
    }
  }
  return pids;
}

/** Windows: walk Win32_Process.ParentProcessId (PowerShell CIM). */
function windowsAncestorPids() {
  const pids = new Set();
  const script = [
    "$p = $PID",
    "$out = @()",
    "while ($p) {",
    "  $proc = Get-CimInstance -ClassName Win32_Process -Filter \"ProcessId=$p\" -ErrorAction SilentlyContinue",
    "  if (-not $proc) { break }",
    "  $out += [int]$proc.ProcessId",
    "  $p = [int]$proc.ParentProcessId",
    "}",
    "($out -join ',')",
  ].join("\n");
  const res = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 15000, windowsHide: true },
  );
  const out = (res?.stdout || "").trim();
  for (const part of out.split(",")) {
    const pid = Number.parseInt(part.trim(), 10);
    if (Number.isFinite(pid)) pids.add(pid);
  }
  return pids;
}

function ancestorPids() {
  return IS_WINDOWS ? windowsAncestorPids() : posixAncestorPids();
}

/* ------------------------------------------------------------------ *
 * Per-session cache (pane + process tree)
 * ------------------------------------------------------------------ */

function stateDir() {
  return (
    process.env.PLUGIN_DATA ||
    join(process.env.HOME || process.env.USERPROFILE || ".", ".minimax", "plugin-data", "herdr-integration")
  );
}

/**
 * Directory holding the sequence counter. It is deliberately NOT derived from
 * PLUGIN_DATA: the launcher wrapper (bash on POSIX, PowerShell on Windows)
 * has to write the same counter, and it computes this path itself.
 */
function sharedDir() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) return join(home, ".minimax", "v2", "plugin-data", "hooks", "herdr-integration");
  return stateDir();
}

function cacheFile(sessionId) {
  const safe = (sessionId || "default").replace(/[^A-Za-z0-9._-]/g, "_");
  return join(stateDir(), "panes", `${safe}.json`);
}

function readCache(sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(cacheFile(sessionId), "utf8"));
    if (parsed && typeof parsed.pane === "string") {
      return {
        pane: parsed.pane,
        ancestors: new Set((parsed.ancestors || []).filter(Number.isFinite)),
      };
    }
  } catch {
    /* no cache yet */
  }
  return null;
}

function writeCache(sessionId, pane, ancestors) {
  try {
    const file = cacheFile(sessionId);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ pane, ancestors: [...ancestors] }));
  } catch {
    /* best effort */
  }
}

/* ------------------------------------------------------------------ *
 * Pane resolution
 * ------------------------------------------------------------------ */

/**
 * Does this pane host the given process tree?
 *
 * Herdr's terminal-to-pane map can be stale for panes created by a split (a
 * fresh pane was observed resolving to its sibling). The only trustworthy link
 * is the process tree: the pane whose shell or foreground process is an
 * ancestor of this hook belongs to us.
 */
function paneHostsUs(paneId, ancestors) {
  if (!ancestors || ancestors.size === 0) return false;
  const info = herdrJson(["pane", "process-info", "--pane", paneId]);
  const procInfo = info?.result?.process_info;
  if (!procInfo) return false;
  const candidates = [
    ...(procInfo.foreground_processes ?? []).map((p) => p.pid),
    procInfo.shell_pid,
  ].filter((pid) => Number.isFinite(pid));
  return candidates.some((pid) => ancestors.has(pid));
}

/**
 * Resolve the Herdr pane this hook belongs to.
 * Returns the pane id, or null when we are not running inside a Herdr pane.
 */
function resolvePane(sessionId) {
  // 1. The pane we used last time, as long as it still hosts us.
  const cached = sessionId ? readCache(sessionId) : null;
  if (cached && paneHostsUs(cached.pane, cached.ancestors)) return cached.pane;

  // 2. Recompute the process tree (once per session) and try again.
  const ancestors = ancestorPids();

  if (cached && paneHostsUs(cached.pane, ancestors)) {
    if (sessionId) writeCache(sessionId, cached.pane, ancestors);
    return cached.pane;
  }

  // 3. `herdr pane current`, when it agrees with the process tree.
  const current = herdrJson(["pane", "current"])?.result?.pane?.pane_id;
  if (typeof current === "string" && paneHostsUs(current, ancestors)) {
    if (sessionId) writeCache(sessionId, current, ancestors);
    return current;
  }

  // 4. Scan every pane and pick the one whose process tree contains us.
  const panes = herdrJson(["pane", "list"])?.result?.panes ?? [];
  for (const pane of panes) {
    const paneId = pane?.pane_id;
    if (typeof paneId !== "string" || paneId === current) continue;
    if (paneHostsUs(paneId, ancestors)) {
      if (sessionId) writeCache(sessionId, paneId, ancestors);
      return paneId;
    }
  }

  log(`no pane hosts this process (current=${current ?? "none"})`);
  return null;
}

/**
 * Monotonic sequence number for this source. Herdr ignores reports whose
 * number is not higher than the last accepted one, so late or out-of-order
 * reports can never overwrite newer state. A timestamp works, but it must
 * strictly increase, hence the persisted counter.
 */
function nextSeq() {
  const file = join(sharedDir(), "seq");
  let last = 0;
  try {
    last = Number.parseInt(readFileSync(file, "utf8").trim(), 10) || 0;
  } catch {
    /* first run */
  }
  const seq = Math.max(Date.now(), last + 1);
  try {
    mkdirSync(sharedDir(), { recursive: true });
    writeFileSync(file, String(seq));
  } catch {
    /* best effort */
  }
  return seq;
}

/** argv that reopens this session after a Herdr server restart. */
function resumeArgv(sessionId, model) {
  if (!sessionId) return [];
  const argv = ["mcode", "--session", sessionId];
  // Only carry the model when it is a plain `provider/model` pair.
  if (typeof model === "string" && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(model)) {
    argv.push("--model", model);
  }
  return argv;
}

/** Append a one-line trace so hook activity can be inspected after the fact. */
function log(line) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(
      join(stateDir(), "herdr-integration.log"),
      `${new Date().toISOString()} ${line}\n`,
      { flag: "a" },
    );
  } catch {
    /* best effort */
  }
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

const payload = (() => {
  const raw = readStdin();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
})();

const event = payload.hook_event_name || "";
const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
const model = payload.model;

const STATE_BY_EVENT = {
  SessionStart: "idle", // ready for the first prompt
  UserPromptSubmit: "working", // a turn started
  PreToolUse: "working",
  PostToolUse: "working",
  PermissionRequest: "blocked", // waiting for the user to decide
  Stop: "idle", // turn finished, waiting for input
};

const state = STATE_BY_EVENT[event];

log(
  `event=${event || "<none>"} session=${sessionId || "<none>"} state=${state || "<none>"} ` +
    `model=${model || "<none>"}`,
);

if (state || event === "SessionEnd") {
  const pane = resolvePane(sessionId);
  if (!pane) {
    log("skipped: not running inside a Herdr pane");
  } else {
    const seq = String(nextSeq());

    if (event === "SessionEnd") {
      // The user quit: hand the pane back to Herdr.
      herdr(["pane", "release-agent", pane, "--source", SOURCE, "--agent", AGENT, "--seq", seq]);
      log(`released pane=${pane}`);
    } else {
      const args = [
        "pane",
        "report-agent",
        pane,
        "--source",
        SOURCE,
        "--agent",
        AGENT,
        "--state",
        state,
        "--seq",
        seq,
      ];

      if (state === "blocked") {
        const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
        args.push(
          "--message",
          tool ? `mcode needs approval for ${tool}` : "mcode needs a decision",
        );
      }

      if (sessionId) args.push("--agent-session-id", sessionId);

      const resume = resumeArgv(sessionId, model);
      if (resume.length) args.push("--", ...resume);

      const res = herdr(args);
      log(
        `reported pane=${pane} state=${state} exit=${res?.status ?? "null"} resume=${resume.join(" ")}`,
      );
    }
  }
}
