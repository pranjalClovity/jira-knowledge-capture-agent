Let's build the first working MVP in JavaScript/Node.js.

I’d structure it so we can later plug in Jira + Teamwork Graph/Rovo without rewriting the core.

MVP we’ll build now
Claude Code / Cursor
        ↓
   Session Capture
        ↓
     Node.js CLI
        ↓
 ┌──────┴────────┐
 │               │
Git changes    Session
 │               │
 └──────┬────────┘
        ↓
 AI Summarizer
        ↓
Decision + Rationale
        ↓
Jira PROJ-123

For the first implementation, we'll make the CLI functional without requiring a running backend.

1. Create the project

Run:

mkdir agent-knowledge
cd agent-knowledge
npm init -y

Install:

npm install commander dotenv axios
npm install -D nodemon

We'll use:

commander → CLI commands
dotenv → credentials/config
axios → Jira/API calls
Node's built-in child_process → Git commands
2. Folder structure

Create:

agent-knowledge/
│
├── src/
│   ├── cli.js
│   ├── session.js
│   ├── git.js
│   ├── jira.js
│   └── summarizer.js
│
├── sessions/
│
├── .env
├── .gitignore
└── package.json
3. CLI

Create src/cli.js:

const { Command } = require("commander");
const {
  startSession,
  stopSession,
  getCurrentSession,
} = require("./session");

const program = new Command();

program
  .name("agent-knowledge")
  .description("Capture AI coding session knowledge and sync it to Jira")
  .version("1.0.0");

program
  .command("start")
  .option("-i, --issue <issue>", "Jira issue key")
  .action(async (options) => {
    await startSession(options.issue);
  });

program
  .command("stop")
  .action(async () => {
    await stopSession();
  });

program
  .command("status")
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

program.parseAsync();
4. Git utility

Create src/git.js:

const { execSync } = require("child_process");

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

function getCurrentBranch() {
  return runGit("git branch --show-current");
}

function getGitDiff() {
  return runGit("git diff HEAD");
}

function getChangedFiles() {
  const output = runGit("git diff HEAD --name-only");

  if (!output) {
    return [];
  }

  return output.split("\n").filter(Boolean);
}

function getGitStatus() {
  return runGit("git status --short");
}

module.exports = {
  getCurrentBranch,
  getGitDiff,
  getChangedFiles,
  getGitStatus,
};
5. Jira issue detection

Add this to git.js:

function detectJiraIssue(branch) {
  if (!branch) {
    return null;
  }

  const match = branch.match(
    /\b([A-Z][A-Z0-9]+-\d+)\b/i
  );

  return match ? match[1].toUpperCase() : null;
}

And export it:

module.exports = {
  getCurrentBranch,
  getGitDiff,
  getChangedFiles,
  getGitStatus,
  detectJiraIssue,
};

Now:

feature/PROJ-123-auth-fix
              ↓
           PROJ-123

automatically.

6. Session manager

Create src/session.js:

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  getCurrentBranch,
  getGitDiff,
  getChangedFiles,
  detectJiraIssue,
} = require("./git");

const SESSION_DIR = path.join(process.cwd(), "sessions");

const ACTIVE_SESSION_FILE = path.join(
  SESSION_DIR,
  "active.json"
);

function ensureSessionDirectory() {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
}

function saveActiveSession(session) {
  fs.writeFileSync(
    ACTIVE_SESSION_FILE,
    JSON.stringify(session, null, 2)
  );
}

function getCurrentSession() {
  if (!fs.existsSync(ACTIVE_SESSION_FILE)) {
    return null;
  }

  return JSON.parse(
    fs.readFileSync(ACTIVE_SESSION_FILE, "utf8")
  );
}

async function startSession(issue) {
  ensureSessionDirectory();

  const branch = getCurrentBranch();

  const jiraIssue =
    issue ||
    detectJiraIssue(branch);

  if (!jiraIssue) {
    console.error(
      "Could not detect Jira issue."
    );

    console.error(
      "Use: agent-knowledge start --issue PROJ-123"
    );

    process.exit(1);
  }

  const session = {
    id: crypto.randomUUID(),
    jiraIssue,
    agent: "unknown",
    branch,
    startedAt: new Date().toISOString(),
  };

  saveActiveSession(session);

  console.log("");
  console.log("✓ Agent knowledge session started");
  console.log(`✓ Jira issue: ${jiraIssue}`);
  console.log(`✓ Branch: ${branch || "unknown"}`);
  console.log(`✓ Session: ${session.id}`);
  console.log("");
}

async function stopSession() {
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

  const outputFile = path.join(
    SESSION_DIR,
    `${session.id}.json`
  );

  fs.writeFileSync(
    outputFile,
    JSON.stringify(completedSession, null, 2)
  );

  fs.unlinkSync(ACTIVE_SESSION_FILE);

  console.log("");
  console.log("✓ Session captured");
  console.log(
    `✓ Files changed: ${completedSession.changedFiles.length}`
  );
  console.log(`✓ Saved: ${outputFile}`);
  console.log("");
}

module.exports = {
  startSession,
  stopSession,
  getCurrentSession,
};
7. Update package.json

Change:

"scripts": {
  "start": "node src/cli.js"
}

and add:

"bin": {
  "agent-knowledge": "./src/cli.js"
}

So eventually:

npm link

Then you can run:

agent-knowledge start

instead of:

node src/cli.js start
8. Test it

Go to any Git repository:

cd your-project

Create a branch:

git checkout -b feature/PROJ-123-auth-fix

Then:

agent-knowledge start

You should get:

✓ Agent knowledge session started
✓ Jira issue: PROJ-123
✓ Branch: feature/PROJ-123-auth-fix
✓ Session: <id>

Then modify some code.

Check:

agent-knowledge status

Finally:

agent-knowledge stop

You'll get:

✓ Session captured
✓ Files changed: 3
✓ Saved: sessions/<session-id>.json
9. Now comes the important part: AI summarization

Our captured JSON currently contains:

{
  "jiraIssue": "PROJ-123",
  "branch": "feature/PROJ-123-auth-fix",
  "changedFiles": [
    "src/auth.js",
    "src/token.js"
  ],
  "gitDiff": "..."
}

Next we'll transform it into:

{
  "problem": "...",

  "decisions": [
    {
      "decision": "...",
      "rationale": "..."
    }
  ],

  "alternatives": [],

  "codeContext": {
    "files": [],
    "functions": []
  },

  "risks": [],

  "testing": []
}

That is the actual knowledge model of our application.

10. Then Jira

After summarization:

Session
   ↓
Summarizer
   ↓
Knowledge JSON
   ↓
Jira Adapter
   ↓
PROJ-123

We can either:

MVP

Add a Jira comment.

Better

Create a structured Jira panel:

🤖 Agent Development Context

Decision
────────
Moved authentication to async flow.

Rationale
─────────
Previous implementation blocked DB connection.

Alternatives
─────────────
❌ Increase timeout
❌ Add retry
✅ Async execution

Files
─────
auth.js
token.js
11. And finally TWG/Rovo

Once the Jira flow works, we'll add:

                 ┌─────────────┐
                 │    Jira     │
                 └──────┬──────┘
                        │
                        ▼
              ┌─────────────────┐
              │ Teamwork Graph  │
              └────────┬────────┘
                       │
                connected context
                       │
                       ▼
              ┌─────────────────┐
              │ Rovo / AI       │
              └─────────────────┘

Then we can make the killer feature:

"Why was this code change made?"

And answer using:

Jira
+
Agent session
+
Decision
+
Rationale
+
Code
+
Related work
One thing I would change from our earlier plan

Don't start by integrating TWG.

Build this exact vertical slice first:

Git branch
    ↓
Jira issue detection
    ↓
Session capture
    ↓
Git diff
    ↓
AI summary
    ↓
Jira

Once that works end-to-end, then we'll plug TWG/Rovo into it.