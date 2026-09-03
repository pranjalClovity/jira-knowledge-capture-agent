import crossSpawn from "cross-spawn";
import fs from "fs";
import os from "os";
import path from "path";

// Registry of coding-agent CLIs this tool can drive non-interactively, keyed by
// the same `agent` value session.js's detectAgent()/--agent stores on a session.
// Only agents with verified non-interactive/auto-approve flags belong here -
// guessing at another tool's flags would just fail silently or worse. Each
// entry's flags were confirmed against the real installed CLI, not just docs.
const AGENT_CLIS = {
  "claude-code": {
    label: "Claude Code",
    bin: "claude",
    versionArgs: ["--version"],
    // -p runs one prompt non-interactively and exits; acceptEdits auto-approves
    // file edits without a TTY; --tools scopes it to just what this task needs
    // (measured no slower than the full tool set, but is tighter blast radius).
    promptArgs: (prompt) => ["-p", prompt, "--permission-mode", "acceptEdits", "--tools", "Read,Edit"],
    // The native (non-npm) installer's documented default install directory.
    // Used as a direct fallback: a shell whose PATH was captured before this
    // install (or before a PATH edit) won't see it via bare-name lookup alone,
    // so we also try the full path here regardless of the live PATH.
    extraDirs: () => [path.join(os.homedir(), ".local", "bin")],
  },
  "chatgpt-codex": {
    label: "Codex",
    bin: "codex",
    versionArgs: ["--version"],
    // `codex exec` is the non-interactive subcommand and hardcodes its approval
    // policy to "never" internally (there's no TTY to prompt), so the only
    // flag actually needed is --sandbox workspace-write so it's allowed to
    // write the file - these are the documented, correct flags and were
    // confirmed to work with a real authenticated write. --skip-git-repo-check
    // is defensive: exec refuses to run at all outside a directory it
    // considers trusted otherwise.
    //
    // KNOWN LIMITATION (Windows): this machine's ~/.codex/config.toml sets
    // [windows] sandbox = "elevated" - Codex's Windows sandbox goes through
    // helper executables (codex-windows-sandbox-setup.exe etc., also flagged
    // by `codex doctor` for needing Defender exclusions) that require process
    // elevation. Whether that elevation succeeds depends on how the process
    // tree was launched, in ways outside this tool's control - reproduced
    // firsthand: codex accepted --sandbox workspace-write, its own startup
    // banner still showed "sandbox: read-only", and every write was rejected,
    // consistently, when driven unattended this way. This isn't fixable from
    // here; it's the reason `stop` verifies the "knowledge" field actually
    // landed and falls back to the clipboard prompt when it didn't, rather
    // than trusting codex's exit code alone.
    promptArgs: (prompt) => ["exec", prompt, "--sandbox", "workspace-write", "--skip-git-repo-check"],
  },
  "github-copilot": {
    label: "GitHub Copilot",
    bin: "copilot",
    versionArgs: ["--version"],
    // -p runs one prompt non-interactively and exits. --allow-tool scopes it to
    // reading anything (Copilot's docs: "read" has no path-filter support, so
    // this is already the narrowest form) plus writing only the one session
    // file this task targets; --no-ask-user disables its ask_user tool so it
    // never blocks waiting on a TTY that isn't there.
    promptArgs: (prompt, filePath) => [
      "-p",
      prompt,
      "--allow-tool",
      `read, write(${filePath})`,
      "--no-ask-user",
    ],
  },
};

// Bare names are resolved against the live PATH; full paths into each CLI's
// known extra install directories are also tried regardless of PATH, so a
// fresh install (or PATH edited after this shell started) is still found.
function candidatePaths(cli) {
  const extraDirs = cli.extraDirs ? cli.extraDirs() : [];
  return [cli.bin, ...extraDirs.map((dir) => path.join(dir, cli.bin))];
}

// Windows can hand out a cwd through its short (8.3) alias form, e.g.
// "C:\Users\MANOHA~1\..." instead of "C:\Users\manohark_clovity\...", when
// %TEMP%/%TMP% happen to be set that way (confirmed on this machine). Some
// tools register whichever form they're launched with as their workspace
// root, then reject a write resolved through the *other* form as "outside
// the project" - reproduced firsthand against Codex CLI with a short-path
// cwd (a distinct failure from, and not a fix for, the separate Windows
// sandbox-elevation behavior documented on the "chatgpt-codex" entry above).
// fs.realpathSync.native (unlike the plain JS realpathSync) resolves short
// names to their canonical long form, so do that before handing cwd to any
// of these CLIs. Falls back to the raw cwd if that resolution fails for any
// reason (e.g. a cwd that no longer exists) rather than hard-erroring here.
function canonicalize(cwd) {
  try {
    return fs.realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

function spawnCli(cli, args, cwd, timeout) {
  // stdin left open-but-unfed makes Claude Code wait ~3s to see if piped input
  // is coming before proceeding - measured ~17s -> ~8s just from explicitly
  // closing it, since we never have anything to send it anyway.
  //
  // The actual process launch goes through cross-spawn rather than Node's raw
  // spawnSync: on Windows, npm-installed CLIs are .cmd shims, and recent Node
  // (security-hardening against Windows batch-file argument injection) flatly
  // refuses to exec a .cmd file directly without shell:true - confirmed this
  // firsthand as EINVAL even for a real, existing codex.cmd. shell:true isn't
  // a safe fix either (Node's own DEP0190: args become concatenated, not
  // escaped). cross-spawn is the standard, widely-audited library (used
  // internally by npm itself) that resolves and escapes this correctly.
  const options = {
    cwd: canonicalize(cwd),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
    timeout,
  };

  let result;
  let triedAs;

  for (const candidate of candidatePaths(cli)) {
    triedAs = candidate;
    result = crossSpawn.sync(candidate, args, options);

    if (!(result.error && result.error.code === "ENOENT")) {
      break;
    }
  }

  return { ...result, triedAs };
}

function describeFailure(result) {
  if (result.error && result.error.code === "ETIMEDOUT") {
    return `"${result.triedAs}" timed out`;
  }

  if (result.error) {
    return `"${result.triedAs}" - ${result.error.message}`;
  }

  if (result.signal) {
    return `"${result.triedAs}" was killed (${result.signal})`;
  }

  return (result.stderr || "").trim() || `"${result.triedAs}" exited with code ${result.status}`;
}

export function getAgentCli(agentName) {
  return AGENT_CLIS[agentName] || null;
}

// `--version` should return almost instantly - if it doesn't, don't let
// `agent-knowledge stop` hang forever waiting on it.
const VERSION_CHECK_TIMEOUT_MS = 10_000;

export function checkCliInstalled(cli) {
  const result = spawnCli(cli, cli.versionArgs, process.cwd(), VERSION_CHECK_TIMEOUT_MS);

  if (result.status === 0) {
    return { installed: true };
  }

  return { installed: false, reason: describeFailure(result) };
}

// The actual summarization call is an LLM run, so give it real headroom, but
// still bound it - a stuck run shouldn't block `stop`/`push` indefinitely.
const PROMPT_RUN_TIMEOUT_MS = 5 * 60 * 1000;

export function runAgentPrompt(cli, prompt, filePath, cwd) {
  const result = spawnCli(cli, cli.promptArgs(prompt, filePath), cwd, PROMPT_RUN_TIMEOUT_MS);

  if (result.status !== 0 || result.error) {
    return { success: false, reason: describeFailure(result) };
  }

  return { success: true, output: result.stdout };
}
