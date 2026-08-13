import { expect, type Page } from '@playwright/test';

export const OWNER = { email: 'owner@e2e.local', password: 'password123' };

/** Sign in through the real form and wait until the shell is up. */
export async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.fill('input[type=email]', OWNER.email);
  await page.fill('input[type=password]', OWNER.password);
  await page.keyboard.press('Enter');
  // The sidebar is the shell's proof of life.
  await expect(page.getByText('Projects', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
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
