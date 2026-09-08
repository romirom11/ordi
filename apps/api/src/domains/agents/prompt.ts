/**
 * The brief an agent receives (plan 2026-09-05-001, R25). The task goes in
 * the prompt; the rules of engagement are appended to the harness's own
 * system prompt. Everything is plain text: the harness reads markdown fine
 * and the agent reads bodies back through the ordi MCP server anyway.
 */
import { getDb, schema, eq, and, asc, isNull } from '@ordi/db';
import { docToText } from '@ordi/shared';

const { tasks, projects, comments, users, taskLinks, gitLinks, taskLabels, labels, taskStatuses } = schema;

export interface PromptContext {
  taskId: string;
  ref: string;
  title: string;
  projectKey: string;
  projectName: string;
  /** The status category the agent should leave the task in. */
  completionCategory: string;
  completionStatusName: string | null;
  branch: string | null;
  repoFullName: string | null;
  agentName: string;
  instructions: string;
  /** Follow-up runs: only the new comment goes in the prompt. */
  followUpCommentId: string | null;
  /** A retry of a run that stopped early, continuing the same session and branch. */
  resumedAfterStop?: boolean;
  /** The session to continue could not be found: the full brief again, plus what is already on the branch. */
  sessionLost?: boolean;
  connectorSlugs: string[];
}

export async function buildTaskBrief(ctx: PromptContext): Promise<string> {
  const { db } = getDb();
  const [task] = await db.select().from(tasks).where(eq(tasks.id, ctx.taskId));
  if (!task) throw new Error('Task not found');
  const [project] = await db.select({ description: projects.description }).from(projects).where(eq(projects.id, task.projectId));
  const [labelRows, linkRows, gitRows, commentRows, statusRow] = await Promise.all([
    db.select({ name: labels.name }).from(taskLabels).innerJoin(labels, eq(labels.id, taskLabels.labelId)).where(eq(taskLabels.taskId, task.id)),
    db.select({ url: taskLinks.url, title: taskLinks.title }).from(taskLinks).where(eq(taskLinks.taskId, task.id)),
    db.select({ type: gitLinks.type, url: gitLinks.url, title: gitLinks.title, state: gitLinks.state }).from(gitLinks).where(eq(gitLinks.taskId, task.id)),
    db.select({ id: comments.id, body: comments.body, authorId: comments.authorId, createdAt: comments.createdAt, authorName: users.name, authorType: users.actorType })
      .from(comments).leftJoin(users, eq(users.id, comments.authorId))
      .where(and(eq(comments.taskId, task.id), isNull(comments.deletedAt))).orderBy(asc(comments.createdAt)),
    task.statusId ? db.select({ name: taskStatuses.name }).from(taskStatuses).where(eq(taskStatuses.id, task.statusId)) : Promise.resolve([]),
  ]);

  const lines: string[] = [];
  const followUp = ctx.followUpCommentId ? commentRows.find((c) => c.id === ctx.followUpCommentId) : undefined;
  if (ctx.resumedAfterStop && !ctx.sessionLost) {
    lines.push(`# Continue ${ctx.ref}: ${task.title}`);
    lines.push('');
    lines.push('Your previous run on this task stopped before you could report (a step limit, a timeout or a cancel). This run continues the same session on the same branch.');
    lines.push('Start by checking `git log` and `git status` to see what is already there, finish the remaining work with as few steps as possible, and end with the structured report.');
    lines.push('');
  } else if (ctx.followUpCommentId && !ctx.sessionLost) {
    lines.push(`# Follow-up on ${ctx.ref}: ${task.title}`);
    lines.push('');
    lines.push('You already worked on this task in this session. A teammate replied on the task:');
    lines.push('');
    if (followUp) {
      lines.push(`> **${followUp.authorName ?? 'Someone'}** wrote:`);
      lines.push(quote(docToText(followUp.body)));
    }
    lines.push('');
    lines.push('Continue from where you left off, address the reply, and finish with the same structured report.');
    lines.push('');
  } else {
    lines.push(`# ${ctx.ref}: ${task.title}`);
    lines.push('');
    lines.push(`Project: ${ctx.projectKey} – ${ctx.projectName}`);
    if (statusRow[0]?.name) lines.push(`Current status: ${statusRow[0].name}`);
    if (task.priority && task.priority !== 'none') lines.push(`Priority: ${task.priority}`);
    if (task.dueDate) lines.push(`Due: ${task.dueDate}`);
    if (labelRows.length) lines.push(`Labels: ${labelRows.map((l) => l.name).join(', ')}`);
    if (ctx.repoFullName) lines.push(`Repository: ${ctx.repoFullName}`);
    if (ctx.branch) lines.push(`Branch: ${ctx.branch} (already checked out in the working directory)`);
    lines.push('');
    lines.push('## Description');
    lines.push('');
    lines.push(docToText(task.description).trim() || '(no description)');
    lines.push('');
    if (project?.description) {
      lines.push('## About the project');
      lines.push('');
      lines.push(String(project.description).trim());
      lines.push('');
    }
    if (linkRows.length || gitRows.length) {
      lines.push('## Links');
      lines.push('');
      for (const l of linkRows) lines.push(`- ${l.title ? `${l.title}: ` : ''}${l.url}`);
      for (const g of gitRows) lines.push(`- ${g.type}${g.state ? ` (${g.state})` : ''}: ${g.url ?? g.title ?? ''}`);
      lines.push('');
    }
    if (commentRows.length) {
      lines.push('## Comments so far');
      lines.push('');
      for (const c of commentRows) {
        const who = c.authorType === 'agent' ? `${c.authorName ?? 'agent'} (agent)` : (c.authorName ?? 'Someone');
        lines.push(`**${who}** – ${c.createdAt.toISOString().slice(0, 16).replace('T', ' ')}`);
        lines.push(quote(docToText(c.body)));
        lines.push('');
      }
    }
    if (ctx.sessionLost) {
      lines.push('## Earlier work');
      lines.push('');
      lines.push('A previous run already worked on this task, but its conversation is no longer available, so you start with a fresh context.');
      lines.push(ctx.branch
        ? `Its commits are on branch ${ctx.branch}, already checked out: read \`git log\` and \`git status\` first and continue from there rather than starting over.`
        : 'Read the comments above to see what was already done and continue from there.');
      lines.push('');
      if (followUp) {
        lines.push('## Latest reply');
        lines.push('');
        lines.push(`> **${followUp.authorName ?? 'Someone'}** wrote:`);
        lines.push(quote(docToText(followUp.body)));
        lines.push('');
        lines.push('Address this reply as part of the work.');
        lines.push('');
      }
    }
  }
  return lines.join('\n').trim() + '\n';
}

function quote(text: string): string {
  return text.trim().split('\n').map((l) => `> ${l}`).join('\n');
}

/** Appended to the harness system prompt: how to behave in ordi. */
export function buildRulesOfEngagement(ctx: PromptContext): string {
  const status = ctx.completionStatusName ? `"${ctx.completionStatusName}"` : `the project's ${ctx.completionCategory.replace('_', ' ')} status`;
  const connectors = ctx.connectorSlugs.length
    ? `You may also use these MCP connectors, each exposed as its own MCP server: ${ctx.connectorSlugs.join(', ')}.`
    : 'No external MCP connectors are granted to you.';
  const codeRules = ctx.repoFullName
    ? [
      `- The working directory is a fresh checkout of ${ctx.repoFullName} on branch ${ctx.branch}. Make focused commits with clear messages as you go.`,
      '- Do not push, do not open pull requests and do not change remotes: the platform pushes your branch and opens the pull request when you report done.',
      '- Do not run destructive git commands (reset --hard, force pushes, branch deletion).',
      '- Run the project\'s own checks (tests, lint, typecheck) before you report done.',
    ]
    : ['- This task has no linked repository. Work through the ordi tools and the working directory only.'];
  return [
    `You are ${ctx.agentName}, an AI team member in ordi working on task ${ctx.ref}. You act as a careful colleague: read the task, do the work, and report back.`,
    '',
    'ordi is available to you as the MCP server named "ordi": get_task reads the full card, comment_on_task posts progress, add_task_link attaches a url, update_task_status changes status. Use the task id given in the brief.',
    connectors,
    '',
    'Rules:',
    ...codeRules,
    '- Post a short progress comment with comment_on_task when you start something non-obvious and when you finish; keep comments to a few sentences.',
    `- Do not move the task to a done status. The platform moves it to ${status} after you report done; a human reviews and merges.`,
    '- If the task is ambiguous or you lack access or information, stop and report needs_input with one clear question rather than guessing.',
    '- Never print secrets, tokens or credentials in comments, commits or output.',
    ctx.instructions.trim() ? `\nInstructions from the workspace:\n${ctx.instructions.trim()}` : '',
    '',
    'Your final answer must be the structured report the platform asked for: status (done, needs_input or blocked), a summary of what you did, the branch, and the pull request url if one already exists (leave it null otherwise).',
  ].join('\n');
}

/** Tools the harness may call without asking (R35). MCP servers are named at run time. */
export function allowedToolsFor(mcpServerNames: string[]): string[] {
  // dontAsk denies anything not listed: background Bash needs BashOutput/KillShell to be usable at all.
  const base = ['Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', 'LS', 'Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'NotebookEdit', 'Skill'];
  const mcp = mcpServerNames.flatMap((n) => [`mcp__${n}`, `mcp__${n}__*`]);
  return [...base, ...mcp];
}

export const DISALLOWED_TOOLS = [
  'Bash(git push*)',
  'Bash(git reset --hard*)',
  'Bash(git branch -D*)',
  'Bash(git remote*)',
  'Bash(sudo*)',
];
