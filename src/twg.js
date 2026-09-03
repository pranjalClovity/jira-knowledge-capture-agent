import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

// `twg -o json` always wraps its payload in a YAML envelope and writes the
// real JSON to a temp file (this is how the CLI keeps large payloads out of
// an agent's context). We only need the parsed `stdout` file's contents.
const STDOUT_FILE_PATTERN = /^\s*stdout:\s*"([^"]+)"/m;

// Falls back to this machine's known TWG install location if TWG_CLI_PATH
// isn't set in the environment. Without this, every project this tool runs
// in needs its own .env, since a system-wide env var set via `setx` doesn't
// propagate to terminals/VS Code windows that were already open when it was set.
const KNOWN_INSTALL_PATHS = [
  process.env.LOCALAPPDATA &&
    path.join(process.env.LOCALAPPDATA, "Programs", "twg", "bin", "twg.exe"),
].filter(Boolean);

function getTwgBinary() {
  if (process.env.TWG_CLI_PATH) {
    return process.env.TWG_CLI_PATH;
  }

  const found = KNOWN_INSTALL_PATHS.find((candidate) => fs.existsSync(candidate));
  return found || "twg";
}

export function runTwg(args) {
  const bin = getTwgBinary();

  let stdout;
  try {
    stdout = execFileSync(bin, [...args, "-o", "json"], { encoding: "utf8" });
  } catch (error) {
    const detail = error.stderr ? error.stderr.toString().trim() : error.message;
    throw new Error(`twg ${args.join(" ")} failed: ${detail}`);
  }

  const match = stdout.match(STDOUT_FILE_PATTERN);

  if (!match) {
    throw new Error(`Could not parse twg output for: twg ${args.join(" ")}\n${stdout}`);
  }

  const outputFile = match[1].replace(/\\\\/g, "\\");
  return JSON.parse(fs.readFileSync(outputFile, "utf8"));
}

function bulletList(items, label) {
  if (!items || items.length === 0) {
    return [`**${label}**`, "", "_None recorded._", ""];
  }

  return [`**${label}**`, "", ...items.map((item) => `- ${item}`), ""];
}

export function formatKnowledgeAsMarkdown(knowledge) {
  const lines = ["### 🤖 Agent Development Context", ""];

  lines.push(knowledge.problem || "_No problem summary provided._", "");

  const decisions = knowledge.decisions || [];
  lines.push("**Decisions**", "");
  if (decisions.length === 0) {
    lines.push("_None recorded._", "");
  } else {
    decisions.forEach((entry) => {
      lines.push(`- **Decision:** ${entry.decision}`);
      lines.push(`  **Rationale:** ${entry.rationale}`);
    });
    lines.push("");
  }

  lines.push(...bulletList(knowledge.alternatives, "Alternatives considered"));
  lines.push(...bulletList(knowledge.codeContext && knowledge.codeContext.files, "Files changed"));
  lines.push(...bulletList(knowledge.risks, "Risks"));
  lines.push(...bulletList(knowledge.testing, "Testing"));

  return lines.join("\n").trim();
}

// TWG is the mediatory store: it already holds authenticated access to Jira
// (and Bitbucket) via `twg login`, so this writes through TWG's Jira surface
// instead of talking to the Jira REST API directly with our own token.
export async function addKnowledgeComment(issueKey, knowledge) {
  const body = formatKnowledgeAsMarkdown(knowledge);

  return runTwg([
    "jira",
    "workitem",
    "comment",
    "create",
    "--issue-id",
    issueKey,
    "--body",
    body,
    "--body-format",
    "markdown",
  ]);
}

export function whoami() {
  return runTwg(["whoami"]);
}
