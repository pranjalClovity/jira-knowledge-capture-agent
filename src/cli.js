#!/usr/bin/env node
import "dotenv/config";

import path from "path";
import { execSync } from "child_process";
import { Command } from "commander";

import {
  startSession,
  stopSession,
  getCurrentSession,
  loadSession,
  saveSession,
  getSessionFile,
  getLatestSessionId,
} from "./session.js";

import * as jira from "./jira.js";
import * as twg from "./twg.js";
import { getAgentCli, checkCliInstalled, runAgentPrompt } from "./agentRunner.js";

const program = new Command();

program
  .name("agent-knowledge")
  .description("Capture AI coding session knowledge and sync it to Jira")
  .version("1.0.0");

function resolveSessionId(sessionId) {
  const id = sessionId || getLatestSessionId();

  if (!id) {
    console.error("No captured sessions found. Run 'agent-knowledge stop' first.");
    process.exit(1);
  }

  return id;
}

function loadSessionOrExit(sessionId) {
  const session = loadSession(sessionId);

  if (!session) {
    console.error(`No session found for id: ${sessionId}`);
    console.error(`Expected file: ${getSessionFile(sessionId)}`);
    process.exit(1);
  }

  return session;
}

// Self-contained on purpose: whichever Claude Code session reads this has no
// memory of this tool's schema, so the file path and exact shape are spelled
// out in full rather than assumed as shared context.
function buildSummarizePrompt(id) {
  const relativePath = path.relative(process.cwd(), getSessionFile(id)).split(path.sep).join("/");

  return [
    "New, standalone task - unrelated to anything else in this conversation, and not a request to update",
    "any other summary/doc file you may already have open:",
    "",
    `Read the JSON file at ${relativePath} and add ONE new top-level field to it, called "knowledge"`,
    '(keep every other field in that file exactly as-is). Base it on that file\'s own "gitDiff" field:',
    "{",
    '  "problem": "<1-2 sentences: what problem this change addresses>",',
    '  "decisions": [{ "decision": "<what was done>", "rationale": "<why>" }],',
    '  "alternatives": ["<other approaches considered or obvious, if any>"],',
    '  "codeContext": { "files": ["<changed files>"], "functions": ["<functions touched, if identifiable>"] },',
    '  "risks": ["<risks or follow-ups>"],',
    '  "testing": ["<testing done, or needed>"]',
    "}",
    `Write the result back to ${relativePath} only - no other file. Then let me know it's done.`,
  ].join("\n");
}

// Best-effort: if this fails (non-Windows, no clip.exe, etc.) the prompt is
// still printed, so typing/pasting it manually is always the fallback.
function copyToClipboard(text) {
  try {
    execSync("clip", { input: text });
    return true;
  } catch {
    return false;
  }
}

function printSummarizePrompt(id, log = console.error) {
  const prompt = buildSummarizePrompt(id);
  const copied = copyToClipboard(prompt);

  log(prompt);
  log("");
  log(
    copied
      ? "(Copied to your clipboard - just paste it into Claude Code chat as-is, don't retype it.)"
      : "(Could not auto-copy - copy the block above exactly, don't retype/paraphrase it.)"
  );
}

// If the session's agent has an installed CLI, run it right here instead of
// making the user paste the prompt by hand. Returns { ran: false } when there's
// no known/installed CLI for this agent, so callers fall back to the manual flow.
function tryAutoSummarize(id, agentName) {
  const cli = getAgentCli(agentName);

  if (!cli) {
    return { ran: false };
  }

  const check = checkCliInstalled(cli);

  if (!check.installed) {
    console.error(`${cli.label} CLI not runnable on PATH (${check.reason}) - falling back to manual paste.`);
    return { ran: false };
  }

  console.error(`Detected ${cli.label} CLI - running it to summarize this session automatically...`);

  const prompt = buildSummarizePrompt(id);
  const result = runAgentPrompt(cli, prompt, process.cwd());

  return { ran: true, cliLabel: cli.label, ...result };
}

function requireKnowledge(session, id) {
  if (!session.knowledge) {
    const auto = tryAutoSummarize(id, session.agent);

    if (auto.ran && auto.success) {
      const updated = loadSession(id);

      if (updated && updated.knowledge) {
        return updated.knowledge;
      }

      console.error(`${auto.cliLabel} ran but didn't add a "knowledge" field to the session.`);
    } else if (auto.ran) {
      console.error(`Could not run ${auto.cliLabel} automatically: ${auto.reason}`);
    }

    console.error("This session hasn't been summarized yet. Paste this to Claude Code:");
    console.error("");
    printSummarizePrompt(id);
    console.error("");
    console.error("Then run this again.");
    process.exit(1);
  }

  return session.knowledge;
}

function assertValidVia(via) {
  if (!["twg", "api"].includes(via)) {
    console.error(`Unknown --via target: ${via}. Use 'twg' or 'api'.`);
    process.exit(1);
  }
}

async function pushKnowledge(issueKey, knowledge, via) {
  if (via === "twg") {
    await twg.addKnowledgeComment(issueKey, knowledge);
  } else {
    await jira.addKnowledgeComment(issueKey, knowledge);
  }
}

program
  .command("start")
  .description("Start capturing a new agent knowledge session")
  .option("-i, --issue <issue>", "Jira issue key")
  .option("-a, --agent <agent>", "which AI agent is doing the work (auto-detects Claude Code)")
  .action(async (options) => {
    await startSession(options.issue, options.agent);
  });

program
  .command("stop")
  .description("Stop the active session and capture the git diff")
  .action(async () => {
    const session = await stopSession();

    if (!session) {
      return;
    }

    const auto = tryAutoSummarize(session.id, session.agent);

    if (auto.ran && auto.success) {
      const updated = loadSession(session.id);

      if (updated && updated.knowledge) {
        console.log(`Knowledge summary generated automatically via ${auto.cliLabel}.`);
        console.log("Next: run 'agent-knowledge push'.");
        return;
      }

      console.log(`${auto.cliLabel} ran but didn't add a "knowledge" field - falling back to manual paste.`);
    } else if (auto.ran) {
      console.log(`Could not run ${auto.cliLabel} automatically: ${auto.reason}`);
      console.log("Falling back to manual paste.");
    }

    console.log("Next: paste this to Claude Code, then run 'agent-knowledge push'.");
    console.log("");
    printSummarizePrompt(session.id, console.log);
    console.log("");
  });

program
  .command("status")
  .description("Show the currently active session")
  .action(() => {
    const session = getCurrentSession();

    if (!session) {
      console.log("No active session.");
      return;
    }

    console.log("Active session:");
    console.log(`Session ID : ${session.id}`);
    console.log(`Jira Issue : ${session.jiraIssue}`);
    console.log(`Agent      : ${session.agent}`);
    console.log(`Started    : ${session.startedAt}`);
  });

program
  .command("push")
  .description("Push a session's knowledge summary to Jira as a comment")
  .argument("[sessionId]", "session id (defaults to the most recently captured session)")
  .option("-i, --issue <issue>", "override the Jira issue key")
  .option(
    "-v, --via <target>",
    "how to reach Jira: 'twg' (mediated through the TWG CLI, default) or 'api' (direct Jira REST call)",
    "twg"
  )
  .action(async (sessionId, options) => {
    assertValidVia(options.via);

    const id = resolveSessionId(sessionId);
    const session = loadSessionOrExit(id);
    const knowledge = requireKnowledge(session, id);

    const issueKey = options.issue || session.jiraIssue;

    if (!issueKey) {
      console.error("No Jira issue key found on the session. Pass --issue PROJ-123.");
      process.exit(1);
    }

    console.log(`Pushing knowledge summary to ${issueKey} (via ${options.via})...`);

    await pushKnowledge(issueKey, knowledge, options.via);

    saveSession({
      ...session,
      pushedAt: new Date().toISOString(),
      pushedVia: options.via,
      pushedTo: issueKey,
    });

    console.log("");
    console.log(`Comment added to ${issueKey}`);
    console.log("");
  });

program
  .command("continue")
  .description(
    "Advance the session through capture -> push, picking up wherever it left off (summarizing must happen in Claude Code chat first)"
  )
  .option("-i, --issue <issue>", "override the Jira issue key")
  .option(
    "-v, --via <target>",
    "how to reach Jira: 'twg' (mediated through the TWG CLI, default) or 'api' (direct Jira REST call)",
    "twg"
  )
  .action(async (options) => {
    assertValidVia(options.via);

    const active = getCurrentSession();
    const id = active ? active.id : getLatestSessionId();

    if (!id) {
      console.error("Nothing to continue. Run 'agent-knowledge start' first.");
      process.exit(1);
    }

    if (active) {
      console.log("Active session found, capturing git diff...");
      await stopSession();
    }

    let session = loadSessionOrExit(id);

    if (session.pushedAt) {
      console.log(`Already pushed to ${session.pushedTo} at ${session.pushedAt}. Nothing to continue.`);
      return;
    }

    const knowledge = requireKnowledge(session, id);

    const issueKey = options.issue || session.jiraIssue;

    if (!issueKey) {
      console.error("No Jira issue key found on the session. Pass --issue PROJ-123.");
      process.exit(1);
    }

    console.log(`Pushing knowledge summary to ${issueKey} (via ${options.via})...`);

    await pushKnowledge(issueKey, knowledge, options.via);

    session = {
      ...session,
      pushedAt: new Date().toISOString(),
      pushedVia: options.via,
      pushedTo: issueKey,
    };
    saveSession(session);

    console.log("");
    console.log(`Comment added to ${issueKey}`);
    console.log("");
  });

program.parseAsync().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
