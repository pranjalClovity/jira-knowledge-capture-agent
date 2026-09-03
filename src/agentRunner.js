import { spawnSync } from "child_process";
import os from "os";
import path from "path";

// Registry of coding-agent CLIs this tool can drive non-interactively, keyed by
// the same `agent` value session.js's detectAgent()/--agent stores on a session.
// Only agents with a verified non-interactive/auto-approve flag belong here -
// guessing at another tool's flags would just fail silently or worse.
const AGENT_CLIS = {
  "claude-code": {
    label: "Claude Code",
    bin: "claude",
    versionArgs: ["--version"],
    // -p runs one prompt non-interactively and exits; acceptEdits auto-approves
    // file edits (but not arbitrary bash) so the write happens without a TTY.
    promptArgs: (prompt) => ["-p", prompt, "--permission-mode", "acceptEdits"],
    // The native (non-npm) installer's documented default install directory.
    // Used as a direct fallback: a shell whose PATH was captured before this
    // install (or before a PATH edit) won't see it via bare-name lookup alone,
    // so we also try the full path here regardless of the live PATH.
    extraDirs: () => [path.join(os.homedir(), ".local", "bin")],
  },
};

// npm-installed CLIs are .cmd/.exe shims on Windows, and spawnSync can't
// resolve a bare name like "claude" to those without going through a shell.
// shell:true is not a safe fix here - Node's own DEP0190 warning says an args
// array passed with shell:true is concatenated, not escaped. So instead we
// try the bare name first, then explicit .cmd/.exe suffixes, never a shell.
const WIN32_SUFFIXES = ["", ".cmd", ".exe"];

// "Not found" shows up as ENOENT for a bare name, but as EINVAL when we
// explicitly try a .cmd/.bat suffix that doesn't exist (a Windows/libuv quirk -
// it can't launch a nonexistent batch file as a native image). Both mean
// "keep trying the next candidate", not "this is the answer".
const NOT_FOUND_CODES = new Set(["ENOENT", "EINVAL"]);

// Bare names are resolved against the current (possibly stale) PATH; full
// paths into each of the CLI's known install directories are tried regardless
// of PATH, so a fresh install is still found without restarting the shell.
function candidatePaths(cli) {
  const suffixes = process.platform === "win32" ? WIN32_SUFFIXES : [""];
  const bareNames = suffixes.map((suffix) => cli.bin + suffix);

  const extraDirs = cli.extraDirs ? cli.extraDirs() : [];
  const fullPaths = extraDirs.flatMap((dir) => suffixes.map((suffix) => path.join(dir, cli.bin + suffix)));

  return [...bareNames, ...fullPaths];
}

function spawnCli(cli, args, cwd, timeout) {
  const options = { cwd, encoding: "utf8", stdio: "pipe", maxBuffer: 20 * 1024 * 1024, timeout };

  let result;
  let triedAs;

  for (const candidate of candidatePaths(cli)) {
    triedAs = candidate;
    result = spawnSync(candidate, args, options);

    if (!(result.error && NOT_FOUND_CODES.has(result.error.code))) {
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

// `claude --version` should return almost instantly - if it doesn't, don't let
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

export function runAgentPrompt(cli, prompt, cwd) {
  const result = spawnCli(cli, cli.promptArgs(prompt), cwd, PROMPT_RUN_TIMEOUT_MS);

  if (result.status !== 0 || result.error) {
    return { success: false, reason: describeFailure(result) };
  }

  return { success: true, output: result.stdout };
}
