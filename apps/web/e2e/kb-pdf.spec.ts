/**
 * Knowledge base PDF pages, end to end through the UI: create a space,
 * open the new-page dialog, pick the PDF type, hand it a file, and read
 * the document back from the inline viewer's own request.
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { login } from './utils';

const FIXTURE_PDF = fileURLToPath(new URL('./fixtures/handbook.pdf', import.meta.url));

test('a PDF page is created from the dialog and served inline', async ({ page }) => {
  await login(page);
  await page.goto('/kb');

  // Space via the sidebar "+".
  await page.getByTitle('New space').click();
  await page.getByPlaceholder('Space name').fill(`Handbook ${Date.now()}`);
  await page.getByRole('button', { name: 'Create' }).click();

  // New page → type PDF → choose the fixture file.
  await page.getByTitle('New page').first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('Page title').fill('Company handbook');
  await dialog.getByText('PDF', { exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByText('Choose a PDF…').click();
  await (await chooser).setFiles(FIXTURE_PDF);
  await expect(dialog.getByText('handbook.pdf', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Create' }).click();

  // The page opens as a viewer: file row + iframe; the editor stays away.
  await expect(page.getByText('handbook.pdf', { exact: false }).first()).toBeVisible();
  const frame = page.locator('iframe');
  await expect(frame).toBeVisible();

  // The document the iframe points at really streams as a PDF.
  const src = await frame.getAttribute('src');
  expect(src).toBeTruthy();
  const res = await page.request.get(src!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/pdf');
  expect((await res.body()).length).toBeGreaterThan(100);

  // Editor affordances of a pdf page: replace + open in new tab.
  await expect(page.getByText('Replace file')).toBeVisible();
  await expect(page.getByText('Open in new tab')).toBeVisible();
});

test('an article page still gets the rich-text editor', async ({ page }) => {
  await login(page);
  await page.goto('/kb');
  await page.getByTitle('New space').click();
  await page.getByPlaceholder('Space name').fill(`Docs ${Date.now()}`);
  await page.getByRole('button', { name: 'Create' }).click();

  await page.getByTitle('New page').first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('Page title').fill('Plain article');
  // Article is the default type – just create.
  await dialog.getByRole('button', { name: 'Create' }).click();

  await expect(page.locator('.ProseMirror').first()).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
});
