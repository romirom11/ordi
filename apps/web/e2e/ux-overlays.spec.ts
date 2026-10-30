/**
 * Overlay primitives in the real app, for the parts e2e/ux-regression.spec.ts
 * does not already drive: the page behind a dialog is inert, the search
 * palette exposes its active result to assistive tech and hands focus back,
 * and toasts are announced once through a live region with a named Close.
 */
import { test, expect } from '@playwright/test';
import { login } from './utils';

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page);
});

test('search palette is a named combobox whose active option follows the arrows', async ({ page }) => {
  const opener = page.getByRole('button', { name: 'New task', exact: true });
  await opener.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');

  const dialog = page.getByRole('dialog', { name: 'Search' });
  await expect(dialog).toBeVisible();
  const input = dialog.getByRole('combobox', { name: 'Search' });
  await expect(input).toBeFocused();
  // The page behind the palette cannot be reached.
  expect(await page.evaluate(() => !!document.querySelector('main')?.closest('[inert]'))).toBe(true);

  // "Pro" matches the Projects navigation command on the client side.
  await input.fill('Pro');
  const options = dialog.getByRole('listbox').getByRole('option');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  const firstId = await options.first().getAttribute('id');
  await expect(input).toHaveAttribute('aria-activedescendant', firstId!);
  if (await options.count() > 1) {
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(input).toHaveAttribute('aria-activedescendant', (await options.nth(1).getAttribute('id'))!);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => !!document.querySelector('[inert]'))).toBe(false);
});

test('a created task is announced once and its toast has a named Close', async ({ page }) => {
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New task', exact: true });
  const title = `Announced ${Date.now()}`;
  await dialog.getByPlaceholder('Task title').fill(title);
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(dialog).toBeHidden();

  const status = page.getByRole('status').filter({ hasText: 'created' });
  await expect(status).toHaveCount(1);
  // The visible toast is not itself a live region – no double announcement.
  const visible = page.locator('[data-overlay-keep] .pointer-events-auto').filter({ hasText: 'created' });
  await expect(visible).toBeVisible();
  expect(await visible.evaluate((el) => !!el.closest('[aria-live],[role="status"],[role="alert"]'))).toBe(false);

  const close = visible.getByRole('button', { name: 'Close' });
  await expect(close).toHaveAttribute('type', 'button');
  await close.click();
  await expect(visible).toBeHidden();
});

test('notifications close before the compact sidebar and keep keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const toggle = page.getByRole('button', { name: 'Show sidebar', exact: true });
  await toggle.click();
  const sidebar = page.getByRole('dialog', { name: 'Sidebar', exact: true });
  const bell = sidebar.getByRole('button', { name: /^Notifications(?: \(\d+\))?$/ });
  await bell.focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('dialog', { name: 'Notifications', exact: true });
  await expect(panel).toBeVisible();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    expect(await panel.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(sidebar).toBeVisible();
  await expect(bell).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sidebar).toBeHidden();
  await expect(toggle).toBeFocused();
});
