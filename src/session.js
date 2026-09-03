import fs from "fs";
import path from "path";
import crypto from "crypto";

import { getCurrentBranch, getGitDiff, getChangedFiles, detectJiraIssue } from "./git.js";

const SESSION_DIR = path.join(process.cwd(), "sessions");

const ACTIVE_SESSION_FILE = path.join(SESSION_DIR, "active.json");

function ensureSessionDirectory() {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
}

function saveActiveSession(session) {
  fs.writeFileSync(ACTIVE_SESSION_FILE, JSON.stringify(session, null, 2));
}

export function getCurrentSession() {
  if (!fs.existsSync(ACTIVE_SESSION_FILE)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(ACTIVE_SESSION_FILE, "utf8"));
}

export function getSessionFile(sessionId) {
  return path.join(SESSION_DIR, `${sessionId}.json`);
}

export function loadSession(sessionId) {
  const file = getSessionFile(sessionId);

  if (!fs.existsSync(file)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function saveSession(session) {
  fs.writeFileSync(getSessionFile(session.id), JSON.stringify(session, null, 2));
}

export function getLatestSessionId() {
  ensureSessionDirectory();

  const files = fs
    .readdirSync(SESSION_DIR)
    .filter((file) => file.endsWith(".json") && file !== "active.json")
    .map((file) => ({
      file,
      mtime: fs.statSync(path.join(SESSION_DIR, file)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) {
    return null;
  }

  return files[0].file.replace(/\.json$/, "");
}

// Only auto-detects tools with a confirmed, documented environment marker.
// CLAUDECODE=1 is set by Claude Code itself. Anything else (Cursor, manual
// coding, etc.) has to go through --agent, since guessing at undocumented
// env vars for other tools would just produce a confident-looking wrong answer.
function detectAgent() {
  if (process.env.CLAUDECODE === "1") {
    return "claude-code";
  }

  return "unknown";
}

export async function startSession(issue, agent) {
  ensureSessionDirectory();

  const branch = getCurrentBranch();

  const jiraIssue = issue || detectJiraIssue(branch);

  if (!jiraIssue) {
    console.error("Could not detect Jira issue.");
    console.error("Use: agent-knowledge start --issue PROJ-123");
    process.exit(1);
  }

  const session = {
    id: crypto.randomUUID(),
    jiraIssue,
    agent: agent || detectAgent(),
    branch,
    startedAt: new Date().toISOString(),
  };

  saveActiveSession(session);

  console.log("");
  console.log("Agent knowledge session started");
  console.log(`Jira issue: ${jiraIssue}`);
  console.log(`Branch: ${branch || "unknown"}`);
  console.log(`Agent: ${session.agent}`);
  console.log(`Session: ${session.id}`);
  console.log("");
}

export async function stopSession() {
  const session = getCurrentSession();

  if (!session) {
    console.log("No active session.");
    return;
  }

  const completedSession = {
    ...session,
    endedAt: new Date().toISOString(),
    changedFiles: getChangedFiles(),
    gitDiff: getGitDiff(),
  };

  saveSession(completedSession);

  fs.unlinkSync(ACTIVE_SESSION_FILE);

  console.log("");
  console.log("Session captured");
  console.log(`Files changed: ${completedSession.changedFiles.length}`);
  console.log(`Saved: ${getSessionFile(completedSession.id)}`);
  console.log("");

  return completedSession;
}
