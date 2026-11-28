/**
 * The profile is split into sections, and personal MCP/API access – the
 * Connections section – lives there rather than among the workspace settings.
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

  await nav.getByRole('link', { name: 'Connections' }).click();
  await expect(page).toHaveURL(/\/profile\/connections$/);
  await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible();
  // Your agent comes first, then connecting a client, then what is connected.
  const headings = page.getByRole('heading', { level: 3 });
  await expect(headings.nth(0)).toHaveText('Your agent');
  await expect(headings.nth(1)).toHaveText('Connect a client');
  await expect(headings.nth(2)).toHaveText('Connected clients');

  // A reload lands on the same section.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Connect a client' })).toBeVisible();

  // The old address still leads there, and Back does not bounce off it.
  await page.goto('/profile/security');
  await page.goto('/profile/mcp');
  await expect(page).toHaveURL(/\/profile\/connections$/);
  await expect(page.getByRole('heading', { name: 'Connect a client' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/profile\/security$/);
});

test('your agent is renamed in place', async ({ page }) => {
  await login(page);
  await page.goto('/profile/connections');
  // The e2e user may have no agent yet: make one first.
  const create = page.getByRole('button', { name: 'Create agent' });
  const rename = page.getByRole('button', { name: 'Rename agent' });
  await expect(create.or(rename)).toBeVisible();
  if (await create.isVisible()) {
    await page.getByLabel('Agent name').fill(`e2e-agent-${Date.now()}`);
    await create.click();
  }
  await expect(rename).toBeVisible();
  // The name is text, not an always-open field.
  await expect(page.getByRole('textbox', { name: 'Agent name' })).toHaveCount(0);

  // Escape puts it back and returns focus to the pencil.
  await rename.click();
  const field = page.getByRole('textbox', { name: 'Agent name' });
  await expect(field).toBeFocused();
  await field.fill('Not saved');
  await field.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(rename).toBeFocused();
  await expect(page.getByText('Not saved')).toHaveCount(0);

  // Enter saves.
  const name = `e2e-agent-${Date.now()}`;
  await rename.click();
  await field.fill(name);
  await field.press('Enter');
  await expect(field).toHaveCount(0);
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(rename).toBeFocused();
});

test('personal MCP moved out of workspace settings', async ({ page }) => {
  await login(page);
  await page.goto('/settings/integrations');
  await expect(page.locator('aside nav').getByRole('link', { name: 'MCP', exact: true })).toHaveCount(0);

  // Old links still work.
  await page.goto('/settings/mcp');
  await expect(page).toHaveURL(/\/profile\/connections$/);

  // A token for scripts is made under its own collapsed section, apart from
  // connecting a client.
  const name = `e2e-token-${Date.now()}`;
  await page.getByRole('button', { name: /^Tokens for scripts/ }).click();
  await page.getByRole('button', { name: 'Create token', exact: true }).click();
  await page.getByPlaceholder('e.g. CI deploy').fill(name);
  await page.getByRole('button', { name: 'Select all' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Copy the token now')).toBeVisible();
  await expect(page.getByText(name)).toBeVisible();
});
