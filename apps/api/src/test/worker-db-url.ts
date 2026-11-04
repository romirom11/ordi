/** The database a test worker uses: the template's name plus the worker's pool id. */
export function workerDatabaseUrl(templateUrl: string, poolId: string | number): string {
  const url = new URL(templateUrl);
  url.pathname = `/${url.pathname.slice(1)}_w${poolId}`;
  return url.toString();
}
