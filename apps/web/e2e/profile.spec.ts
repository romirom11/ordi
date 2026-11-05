/**
 * The profile is split into sections, and personal MCP/API access lives there
 * rather than among the workspace settings.
 */
import { test, expect } from '@playwright/test';
import { login } from './utils';

test('profile sections each have their own url', async ({ page }) => {
  await login(page);
  await page.goto('/profile');
  const nav = page.locator('aside nav');

  // The default section keeps the bare url and shows only account things.
  await expect(page.getByText('Change photo')).toBeVisible();
  await expect(page.getByText('Two-factor authentication')).toHaveCount(0);

  await nav.getByRole('link', { name: 'Notifications' }).click();
  await expect(page).toHaveURL(/\/profile\/notifications$/);
  await expect(page.getByText('Email notifications')).toBeVisible();

  await nav.getByRole('link', { name: 'Security' }).click();
  await expect(page).toHaveURL(/\/profile\/security$/);
  await expect(page.getByRole('button', { name: 'Change password' })).toBeVisible();

  await nav.getByRole('link', { name: 'MCP & API' }).click();
  await expect(page).toHaveURL(/\/profile\/mcp$/);
  await expect(page.getByText('Connect a client')).toBeVisible();

  // A reload lands on the same section.
  await page.reload();
  await expect(page.getByText('Connect a client')).toBeVisible();
});

test('personal MCP moved out of workspace settings', async ({ page }) => {
  await login(page);
  await page.goto('/settings/integrations');
  await expect(page.locator('aside nav').getByRole('link', { name: 'MCP', exact: true })).toHaveCount(0);

  // Old links still work.
  await page.goto('/settings/mcp');
  await expect(page).toHaveURL(/\/profile\/mcp$/);

  // An API token is created from the access list, without opening the stdio fallback.
  const name = `e2e-token-${Date.now()}`;
  await page.getByRole('button', { name: 'Create token' }).first().click();
  await page.getByPlaceholder('e.g. claude-desktop').fill(name);
  await page.getByRole('button', { name: 'Select all' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Copy the token now')).toBeVisible();
  await expect(page.getByText(name)).toBeVisible();
});
