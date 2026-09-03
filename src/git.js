import { execSync } from "child_process";

function runGit(command) {
  try {
    return execSync(command, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function getCurrentBranch() {
  return runGit("git branch --show-current");
}

// Excludes this tool's own bookkeeping directory (must match session.js's
// SESSION_DIR folder name) so a session never captures its own state files
// as if they were part of the user's changes.
const EXCLUDE_SESSIONS_DIR = '":(exclude)sessions"';

// `git diff HEAD` alone ignores untracked (brand-new) files. Intent-to-add
// registers them in the index with a zero-content placeholder so they show
// up as additions, then `git reset` immediately undoes that - the working
// tree is never touched and the index ends up exactly as it started.
function withUntrackedVisible(fn) {
  runGit(`git add -A -N -- ${EXCLUDE_SESSIONS_DIR}`);
  try {
    return fn();
  } finally {
    runGit("git reset");
  }
}

export function getGitDiff() {
  return withUntrackedVisible(() => runGit(`git diff HEAD -- ${EXCLUDE_SESSIONS_DIR}`));
}

export function getChangedFiles() {
  const output = withUntrackedVisible(() =>
    runGit(`git diff HEAD --name-only -- ${EXCLUDE_SESSIONS_DIR}`)
  );

  if (!output) {
    return [];
  }

  return output.split("\n").filter(Boolean);
}

export function getGitStatus() {
  return runGit("git status --short");
}

export function detectJiraIssue(branch) {
  if (!branch) {
    return null;
  }

  const match = branch.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);

  return match ? match[1].toUpperCase() : null;
}
