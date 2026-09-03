import axios from "axios";

function getJiraClient() {
  const baseUrl = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;

  if (!baseUrl || !email || !apiToken) {
    throw new Error(
      "Missing Jira config. Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in your .env file."
    );
  }

  return axios.create({
    baseURL: baseUrl.replace(/\/$/, ""),
    auth: { username: email, password: apiToken },
    headers: { "content-type": "application/json" },
  });
}

function paragraph(text) {
  return {
    type: "paragraph",
    content: text ? [{ type: "text", text }] : [],
  };
}

function heading(text) {
  return {
    type: "heading",
    attrs: { level: 4 },
    content: [{ type: "text", text }],
  };
}

function bulletList(items) {
  if (!items || items.length === 0) {
    return paragraph("(none)");
  }

  return {
    type: "bulletList",
    content: items.map((item) => ({
      type: "listItem",
      content: [paragraph(String(item))],
    })),
  };
}

export function buildCommentBody(knowledge) {
  const content = [heading("🤖 Agent Development Context"), paragraph(knowledge.problem)];

  content.push(heading("Decisions"));
  (knowledge.decisions || []).forEach((entry) => {
    content.push(paragraph(`Decision: ${entry.decision}`));
    content.push(paragraph(`Rationale: ${entry.rationale}`));
  });
  if (!knowledge.decisions || knowledge.decisions.length === 0) {
    content.push(paragraph("(none)"));
  }

  content.push(heading("Alternatives considered"));
  content.push(bulletList(knowledge.alternatives));

  content.push(heading("Files changed"));
  content.push(bulletList(knowledge.codeContext && knowledge.codeContext.files));

  content.push(heading("Risks"));
  content.push(bulletList(knowledge.risks));

  content.push(heading("Testing"));
  content.push(bulletList(knowledge.testing));

  return {
    type: "doc",
    version: 1,
    content,
  };
}

export async function addKnowledgeComment(issueKey, knowledge) {
  const client = getJiraClient();

  const body = buildCommentBody(knowledge);

  const response = await client.post(`/rest/api/3/issue/${issueKey}/comment`, { body });

  return response.data;
}
