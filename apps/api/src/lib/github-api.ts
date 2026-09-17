/** api.github.com for github.com apps, <host>/api/v3 for GHE ones. Pure: no config, no database. */
export function githubApiBase(htmlUrl: string): string {
  try {
    const origin = new URL(htmlUrl).origin;
    return origin === 'https://github.com' ? 'https://api.github.com' : `${origin}/api/v3`;
  } catch {
    return 'https://api.github.com';
  }
}
