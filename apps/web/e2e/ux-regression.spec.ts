import { test, expect, type Page } from '@playwright/test';
import { api, login } from './utils';

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

async function task(page: Page) {
  const projects = await api<{ data: { id: string }[] }>(page, 'get', '/projects');
  const projectId = projects.data[0]!.id;
  const row = await api<{ id: string }>(page, 'post', '/tasks', { projectId, title: `UX regression ${Date.now()}`, description: doc('Original description') });
  return { id: row.id, projectId, url: `/projects/${projectId}/tasks/${row.id}` };
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page);
});

test('quick create retains its draft and all property pickers are keyboard reachable', async ({ page }) => {
  const opener = page.getByRole('button', { name: 'New task', exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'New task', exact: true });
  await dialog.getByPlaceholder('Task title').fill('Retained UX draft');
  for (const name of [/^Status:/, /^Priority:/, /^Assignees:/, /^Project:/, /^Labels:/, /^Due date:/]) {
    await expect(dialog.getByRole('button', { name })).toHaveAttribute('type', 'button');
  }
  await dialog.getByRole('button', { name: /^Priority:/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menu').locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Priority:/ })).toBeFocused();
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(dialog.getByPlaceholder('Task title')).toHaveValue('Retained UX draft');
  await expect(dialog.getByPlaceholder('Task title')).toBeFocused();
});

test('task properties are focusable and status Enter opens its picker', async ({ page }) => {
  const row = await task(page);
  await page.goto(row.url);
  await expect(page.getByRole('textbox', { name: 'Task title', exact: true })).toBeVisible();
  const status = page.locator('aside').last().getByRole('button', { name: /Todo|Backlog/ }).first();
  await status.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(status).toBeFocused();
});

test('a failed task save retains text and retry stores it', async ({ page }) => {
  const row = await task(page);
  await page.goto(row.url);
  const editor = page.locator('.task-desc .tiptap');
  await expect(editor).toBeVisible();
  await page.route(`**/api/v1/tasks/${row.id}`, async (route) => {
    if (route.request().method() === 'PATCH') await route.fulfill({ status: 500, json: { error: { code: 'test_failure', message: 'Temporary save failure' } } });
    else await route.continue();
  });
  await editor.fill('Important text after a failed save');
  await expect(page.getByRole('status').filter({ hasText: 'Not saved' })).toBeVisible();
  await expect(editor).toContainText('Important text after a failed save');
  await page.unroute(`**/api/v1/tasks/${row.id}`);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(async () => JSON.stringify((await api<any>(page, 'get', `/tasks/${row.id}`)).description)).toContain('Important text after a failed save');
  await page.reload();
  await expect(editor).toContainText('Important text after a failed save');
});

test('KB navigation restores the draft, conflict keeps both versions, and explicit choice saves', async ({ page }) => {
  const space = await api<{ id: string }>(page, 'post', '/spaces', { name: `UX conflict ${Date.now()}` });
  const first = await api<{ id: string }>(page, 'post', '/pages', { spaceId: space.id, title: 'UX first', body: doc('Baseline') });
  const second = await api<{ id: string }>(page, 'post', '/pages', { spaceId: space.id, title: 'UX second', body: doc('Other page') });
  const url = `/kb/${space.id}/${first.id}`;
  await page.goto(url);
  const editor = page.locator('.tiptap[contenteditable="true"]').first();
  await editor.fill('Local KB draft to preserve');
  await page.goto(`/kb/${space.id}/${second.id}`);
  await page.goto(url);
  await expect(editor).toContainText('Local KB draft to preserve');
  const current = await api<any>(page, 'get', `/pages/${first.id}`);
  await api(page, 'patch', `/pages/${first.id}`, { body: doc('Remote collaborator text'), version: current.version });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Someone else changed' })).toBeVisible();
  await expect(editor).toContainText('Local KB draft to preserve');
  await page.getByRole('button', { name: 'Show their version' }).click();
  await expect(page.getByText('Remote collaborator text', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Keep my version' }).click();
  await expect.poll(async () => JSON.stringify((await api<any>(page, 'get', `/pages/${first.id}`)).body)).toContain('Local KB draft to preserve');
});

test('invoice fields have names, discount remains readable and invalid typed dates block submit', async ({ page }) => {
  await page.goto('/finance');
  await page.getByRole('button', { name: 'Invoices', exact: true }).click();
  await page.getByRole('button', { name: 'New invoice', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New invoice', exact: true });
  const companies = await api<{ data: { id: string }[] }>(page, 'get', '/companies');
  await dialog.getByRole('combobox', { name: 'Company', exact: true }).selectOption(companies.data[0]!.id);
  await dialog.getByRole('textbox', { name: /^Description\s*, line 1$/ }).fill('UX item');
  await expect(dialog.getByRole('spinbutton', { name: /^Qty\s*, line 1$/ })).toBeVisible();
  await dialog.getByRole('spinbutton', { name: /^Unit price\s*, line 1$/ }).fill('100');
  const discount = dialog.getByRole('combobox', { name: 'Discount', exact: true });
  await discount.selectOption('percent');
  expect((await discount.boundingBox())!.width).toBeGreaterThan(100);
  const due = dialog.getByRole('textbox', { name: 'Due date (optional)', exact: true });
  await due.fill('2000-01-01');
  await due.press('Enter');
  await expect(due).toHaveAttribute('aria-invalid', 'true');
  await dialog.getByRole('button', { name: 'Create draft', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(due).toBeFocused();
  await due.fill('');
  await due.press('Enter');
  const issue = dialog.getByRole('textbox', { name: 'Issue date', exact: true });
  await issue.fill(`${new Date().getFullYear() + 1}-01-01`);
  await issue.press('Enter');
  await due.focus();
  await page.keyboard.press('ArrowDown');
  const focusedDay = page.getByRole('grid').locator('[data-focused="true"]');
  await expect(focusedDay).toBeEnabled();
  await expect(focusedDay).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
});

test('list status, checkbox, board card and context menu work from the keyboard', async ({ page }) => {
  const item = await task(page);
  const url = `/projects/${item.projectId}?section=tasks`;
  await page.goto(url);
  await page.getByRole('button', { name: 'Display', exact: true }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.keyboard.press('Escape');
  const link = page.locator(`a[href="${item.url}"]`);
  const row = link.locator('xpath=ancestor::div[contains(@class,"group/row")]');
  const status = row.getByRole('button', { name: /^Status:/ });
  await status.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(url);
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  const checkbox = row.getByRole('checkbox');
  await checkbox.focus();
  await expect(checkbox).toHaveCSS('opacity', '1');
  await page.keyboard.press('Space');
  await expect(checkbox).toBeChecked();
  await page.getByRole('button', { name: 'Display', exact: true }).click();
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await page.keyboard.press('Escape');
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu').locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(link).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(item.url);
});

test('compact CRM keeps related records reachable and sidebar state follows the company', async ({ page }) => {
  const companies = await api<{ data: { id: string; name: string }[] }>(page, 'get', '/companies');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/companies/${companies.data[0]!.id}`);
  const toggle = page.getByRole('button', { name: 'Show sidebar', exact: true });
  await expect(toggle).toBeVisible();
  await toggle.click();
  const sidebar = page.getByRole('dialog', { name: 'Sidebar', exact: true });
  await expect(sidebar.getByRole('link', { name: 'CRM', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  await expect(sidebar).toBeHidden();
  const linked = page.getByRole('heading', { name: /^Contacts(?: \d+)?$/ });
  await linked.scrollIntoViewIfNeeded();
  await expect(linked).toBeVisible();
});

test('an initial Projects API failure is an error, not an empty workspace', async ({ page }) => {
  await page.route('**/api/v1/projects', (route) => route.fulfill({ status: 500, json: { error: { code: 'test_failure', message: 'Unavailable' } } }));
  await page.goto('/projects');
  const error = page.getByRole('alert').filter({ hasText: 'Could not load the data' });
  await expect(error).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await page.unroute('**/api/v1/projects');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(error).toHaveCount(0);
});

test('realtime updates an open task and detects a KB conflict before Save', async ({ page }) => {
  const row = await task(page);
  await page.goto(row.url);
  const title = page.getByRole('textbox', { name: 'Task title', exact: true });
  await expect(title).toBeVisible();
  const server = await api<any>(page, 'get', `/tasks/${row.id}`);
  await api(page, 'patch', `/tasks/${row.id}`, { title: 'Changed from another session', version: server.version });
  await expect(title).toHaveValue('Changed from another session');

  const space = await api<{ id: string }>(page, 'post', '/spaces', { name: `Realtime ${Date.now()}` });
  const kb = await api<any>(page, 'post', '/pages', { spaceId: space.id, title: 'Realtime page', body: doc('Baseline') });
  await page.goto(`/kb/${space.id}/${kb.id}`);
  const editor = page.locator('.tiptap[contenteditable="true"]').first();
  await editor.fill('My unsaved draft');
  await api(page, 'patch', `/pages/${kb.id}`, { body: doc('Their remote edit'), version: kb.version });
  await expect(page.getByRole('alert').filter({ hasText: 'Someone else changed' })).toBeVisible();
  await expect(editor).toContainText('My unsaved draft');
});

test('timer agrees with the API across reload and Stop can be resumed', async ({ page }) => {
  const row = await task(page);
  const current = await api<any>(page, 'get', '/time/timer');
  expect(current).toBeNull();
  await api(page, 'post', '/time/timer/start', { taskId: row.id, note: 'UX regression' });
  try {
    await page.goto('/time');
    const clocks = page.getByText(/^\d{2}:\d{2}:\d{2}$/);
    await expect(clocks).toHaveCount(2);
    await expect.poll(async () => (await api<any>(page, 'get', '/time/timer')).elapsedSeconds).toBeGreaterThanOrEqual(2);
    await page.reload();
    await expect(clocks).toHaveCount(2);
    const sample = await api<any>(page, 'get', '/time/timer');
    const seconds = (value: string) => value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
    for (const value of await clocks.allTextContents()) expect(Math.abs(seconds(value) - sample.elapsedSeconds)).toBeLessThanOrEqual(2);
    await page.keyboard.press('t');
    await expect(page.getByRole('button', { name: 'Resume timer', exact: true })).toBeVisible();
    expect(await api(page, 'get', '/time/timer')).toBeNull();
    await page.getByRole('button', { name: 'Resume timer', exact: true }).click();
    await expect.poll(async () => (await api<any>(page, 'get', '/time/timer'))?.taskId).toBe(row.id);
  } finally {
    if (await api(page, 'get', '/time/timer')) await api(page, 'post', '/time/timer/stop');
  }
});

test('Back restores the scrolled CRM pane instead of returning to the top', async ({ page }) => {
  const companies = await api<{ data: { id: string }[] }>(page, 'get', '/companies');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/companies/${companies.data[0]!.id}`);
  const contacts = page.getByRole('heading', { name: /^Contacts(?: \d+)?$/ });
  await contacts.scrollIntoViewIfNeeded();
  await page.mouse.move(200, 650);
  await page.mouse.wheel(0, 300);
  await expect(contacts).toBeVisible();
  const scroller = contacts.locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")]').first();
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  const position = await scroller.evaluate((element) => element.scrollTop);
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await page.getByRole('dialog', { name: 'Sidebar', exact: true }).getByRole('link', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(contacts).toBeVisible();
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThanOrEqual(position - 2);
});
