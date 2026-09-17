/**
 * Which tools the harness may call without asking (R35), and which it may
 * never call. On its own file because the worker needs it and nothing else
 * of the prompt module, which reads the task out of the database.
 */

/** Tools the harness may call without asking. MCP servers are named at run time. */
export function allowedToolsFor(mcpServerNames: string[]): string[] {
  // dontAsk denies anything not listed: background Bash needs BashOutput/KillShell to be usable at all.
  const base = ['Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', 'LS', 'Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'NotebookEdit', 'Skill'];
  const mcp = mcpServerNames.flatMap((n) => [`mcp__${n}`, `mcp__${n}__*`]);
  return [...base, ...mcp];
}

export const DISALLOWED_TOOLS = [
  'Bash(git push*)',
  // History rewrites: the platform pushes the branch between runs (unfinished
  // work goes out as a WIP commit), so an amended or rebased commit is a
  // push refused as non-fast-forward.
  'Bash(git commit --amend*)',
  'Bash(git rebase*)',
  'Bash(git reset*)',
  'Bash(git branch -D*)',
  'Bash(git branch -f*)',
  'Bash(git remote*)',
  'Bash(sudo*)',
];
