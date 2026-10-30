import { expect, type Cookie, type Page } from '@playwright/test';

export const OWNER = {
  email: process.env.E2E_OWNER_EMAIL ?? 'owner@e2e.local',
  password: process.env.E2E_OWNER_PASSWORD ?? 'password123',
};

let externalCookies: Cookie[] | undefined;

/** Sign in once through the real form, then reuse its session in this worker. */
export async function login(page: Page): Promise<void> {
  // The suite has one worker and more than ten specs. Reusing the first real
  // session keeps the test setup faithful without tripping login rate limits.
  if (externalCookies) {
    await page.context().addCookies(externalCookies);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
    return;
  }
  await page.goto('/');
  await page.fill('input[type=email]', OWNER.email);
  await page.fill('input[type=password]', OWNER.password);
  await page.keyboard.press('Enter');
  // The sidebar is the shell's proof of life.
  await expect(page.getByText('Projects', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  externalCookies = await page.context().cookies();
}

/**
 * Data setup rides page.request – same origin, same session cookie the UI
 * logged in with. Returns the parsed JSON body.
 */
export async function api<T = any>(page: Page, method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, data?: unknown): Promise<T> {
  const res = await page.request[method](`/api/v1${path}`, data === undefined ? undefined : { data });
  if (!res.ok()) throw new Error(`${method.toUpperCase()} ${path} → ${res.status()}: ${await res.text()}`);
  return res.json() as Promise<T>;
}
