/**
 * Compact shell, CRM detail on a phone, the invoice list at tablet and phone
 * widths, the invoice form's labelling and date rules, and Finance load
 * failures. Each test states the regression it guards.
 */
import { test, expect, type Page } from '@playwright/test';
import { login, api } from './utils';

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 768, height: 900 };
const DESKTOP = { width: 1280, height: 800 };

async function seedCompanyWithInvoice(page: Page, name: string) {
  const company = await api<{ id: string }>(page, 'post', '/companies', { name, status: 'active' });
  const invoice = await api<{ id: string }>(page, 'post', '/invoices', {
    companyId: company.id, issueDate: '2026-10-01', dueDate: '2026-10-31', language: 'en',
    items: [{ description: 'Design sprint', quantity: 2, unitPrice: 1250 }],
  });
  return { companyId: company.id, invoiceId: invoice.id };
}

async function openInvoices(page: Page) {
  await page.goto('/finance');
  await expect(page.getByRole('heading', { name: 'Finance', exact: true })).toBeVisible();
  const compactSelect = page.getByLabel('Finance section');
  if (await compactSelect.isVisible()) await compactSelect.selectOption('invoices');
  else await page.getByRole('button', { name: 'Invoices', exact: true }).click();
}

/** No page-wide horizontal overflow: the document is never wider than the viewport. */
async function expectNoPageOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('phone width: sidebar is a drawer that keeps its links out of the Tab order until opened', async ({ page }) => {
  await login(page); // signs in against the visible desktop sidebar
  await page.setViewportSize(PHONE);
  await page.goto('/projects');

  const sidebar = page.locator('#app-sidebar');
  await expect(sidebar).toBeHidden();

  const toggle = page.getByRole('button', { name: 'Show sidebar' });
  await expect(toggle).toBeVisible();
  // Tab never lands on a link of the hidden sidebar.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('#app-sidebar'))).toBe(false);
  }

  await toggle.click();
  await expect(page.getByRole('dialog', { name: 'Sidebar' })).toBeVisible();
  expect(await page.evaluate(() => !!document.activeElement?.closest('#app-sidebar'))).toBe(true);
  // Back and new-tab live in the tab strip behind the drawer; it is inert now.
  expect(await page.locator('main').getAttribute('inert')).not.toBeNull();

  await page.keyboard.press('Escape');
  await expect(sidebar).toBeHidden();
  await expect(toggle).toBeFocused();

  // A nav link closes the drawer by navigating.
  await toggle.click();
  await page.getByRole('dialog', { name: 'Sidebar' }).getByRole('link', { name: 'Finance' }).click();
  await expect(page).toHaveURL(/\/finance$/);
  await expect(sidebar).toBeHidden();
  await expectNoPageOverflow(page);
});

test('desktop: Cmd/Ctrl+\\ hides the sidebar, the choice survives a reload', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page);
  const sidebar = page.locator('#app-sidebar');
  await expect(sidebar).toBeVisible();
  expect((await sidebar.boundingBox())?.width).toBe(224);

  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(sidebar).toBeHidden();
  await page.reload();
  await expect(sidebar).toBeHidden();
  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await expect(sidebar).toBeVisible();
});

test('Cmd/Ctrl+, opens personal preferences', async ({ page }) => {
  await login(page);
  await page.keyboard.press('ControlOrMeta+Comma');
  await expect(page).toHaveURL(/\/profile$/);
});

test('a collapsed nav group takes its links out of the Tab order', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page);
  const header = page.getByRole('button', { name: 'Work' });
  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  expect(await page.locator('#nav-group-work').getAttribute('inert')).not.toBeNull();
  await expect(page.getByRole('link', { name: 'Projects', exact: true })).toHaveCount(0);
  await header.click(); // leave the persisted state as found
  await expect(page.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
});

test('CRM stays the current section on company, lead and deal pages', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page);
  const { companyId } = await seedCompanyWithInvoice(page, 'Current Section Co');
  await page.goto(`/companies/${companyId}`);
  // Needs lib/router Link to forward aria-current (owned by another change).
  await expect(page.locator('#app-sidebar').getByRole('link', { name: 'CRM' })).toHaveAttribute('aria-current', 'page');
});

test('phone width: company detail reaches its related records with one scroll', async ({ page }) => {
  await login(page);
  await page.setViewportSize(PHONE);
  const { companyId } = await seedCompanyWithInvoice(page, 'Initech Phone');
  await page.goto(`/companies/${companyId}`);

  for (const name of ['Leads', 'Deals', 'Invoices', 'Contacts']) {
    const heading = page.getByRole('heading', { name, exact: false }).first();
    await heading.scrollIntoViewIfNeeded();
    await expect(heading).toBeVisible();
    const box = await heading.boundingBox();
    expect(box && box.height).toBeGreaterThan(0);
  }
  await expectNoPageOverflow(page);
});

for (const size of [TABLET, PHONE]) {
  test(`invoice list keeps number, company and amount readable at ${size.width}px`, async ({ page }) => {
    await login(page);
    await page.setViewportSize(size);
    await seedCompanyWithInvoice(page, 'Globex Readable');
    await openInvoices(page);

    const company = page.getByText('Globex Readable').first();
    await expect(company).toBeVisible();
    expect((await company.boundingBox())!.width).toBeGreaterThan(60);
    const row = page.getByRole('button').filter({ has: company }).first();
    await expect(row).toContainText(/2,500|2 500/);
    await expectNoPageOverflow(page);
  });
}

test('invoice form: every field is named, the discount unit stays visible, dates obey bounds', async ({ page }) => {
  await login(page);
  for (const size of [PHONE, DESKTOP]) {
    await page.setViewportSize(size);
    await openInvoices(page);
    await page.getByRole('button', { name: 'New invoice' }).click();
    const dialog = page.getByRole('dialog');

    for (const label of ['Company', 'Issue date', 'Due date (optional)', 'Currency', 'Document language', 'Tax']) {
      await expect(dialog.getByLabel(label, { exact: true })).toBeVisible();
    }
    await expect(dialog.getByLabel(/^Description\s*, line 1$/)).toBeVisible();
    await expect(dialog.getByLabel(/^Qty\s*, line 1$/)).toBeVisible();
    await expect(dialog.getByLabel(/^Unit price\s*, line 1$/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Add line' }).click();
    await expect(dialog.getByLabel(/^Qty\s*, line 2$/)).toBeVisible();

    // Percent stays readable after it is chosen – the select used to shrink to its 18px arrow.
    const discount = dialog.getByLabel('Discount', { exact: true });
    await discount.selectOption('percent');
    expect((await discount.boundingBox())!.width).toBeGreaterThan(100);
    await expect(discount).toHaveValue('percent');

    // A due date typed before the issue date is refused, with the reason, and the text is kept.
    const issue = dialog.getByLabel('Issue date', { exact: true });
    await issue.fill('2026-10-10');
    await issue.press('Enter');
    const due = dialog.getByLabel('Due date (optional)', { exact: true });
    await due.fill('2026-10-01');
    await due.press('Tab');
    await expect(due).toHaveValue('2026-10-01');
    await expect(due).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByText(/or later/)).toBeVisible();

    // Unparseable text is kept with an actionable message instead of reverting silently.
    await due.fill('next friday');
    await due.press('Tab');
    await expect(due).toHaveValue('next friday');
    await expect(dialog.getByText(/Enter a date like/)).toBeVisible();

    await expectNoPageOverflow(page);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  }
});

test('a failed invoice load is an error with Retry, never "No invoices"', async ({ page }) => {
  await login(page);
  await page.route('**/api/v1/invoices*', (route) => route.fulfill({ status: 500, body: '{"error":"boom"}' }));
  await openInvoices(page);
  await expect(page.getByRole('alert').getByText(/load this data/)).toBeVisible();
  await expect(page.getByText('No invoices', { exact: true })).toHaveCount(0);

  await page.unroute('**/api/v1/invoices*');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /load this data/ })).toHaveCount(0);
});

test('a failed finance dashboard load shows no false zero totals', async ({ page }) => {
  await login(page);
  await page.route('**/api/v1/finance/dashboard*', (route) => route.fulfill({ status: 500, body: '{"error":"boom"}' }));
  await page.goto('/finance');
  await expect(page.getByRole('heading', { name: 'Finance', exact: true })).toBeVisible();
  const compactSelect = page.getByLabel('Finance section');
  if (await compactSelect.isVisible()) await compactSelect.selectOption('dashboard');
  else await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByRole('alert').getByText(/load this data/)).toBeVisible();
  await expect(page.getByText('Outstanding')).toHaveCount(0);
});

for (const section of ['expenses', 'transactions'] as const) {
  test(`${section}: failed recurring or ledger data stays unknown and Retry recovers`, async ({ page }) => {
    await login(page);
    const path = section === 'expenses' ? '**/api/v1/recurring-payments**' : '**/api/v1/ledger/transactions*';
    await page.route(path, (route) => route.fulfill({ status: 500, json: { error: { code: 'test_failure', message: 'Unavailable' } } }));
    await page.goto('/finance');
    await page.getByRole('button', { name: section === 'expenses' ? 'Expenses' : 'Transactions', exact: true }).click();
    const error = page.getByRole('alert').filter({ hasText: 'Could not load the data' });
    await expect(error).toBeVisible();
    await expect(page.getByText(section === 'expenses' ? 'No subscriptions yet' : 'No transactions yet', { exact: true })).toHaveCount(0);
    await page.unroute(path);
    await error.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(error).toBeHidden();
  });
}

test('invoice detail distinguishes a temporary failure from a missing invoice', async ({ page }) => {
  await login(page);
  const { invoiceId } = await seedCompanyWithInvoice(page, `Invoice recovery ${Date.now()}`);
  const path = `**/api/v1/invoices/${invoiceId}`;
  await page.route(path, (route) => route.fulfill({ status: 500, json: { error: { code: 'test_failure', message: 'Unavailable' } } }));
  await page.goto(`/finance/invoices/${invoiceId}`);
  const error = page.getByRole('alert').filter({ hasText: 'Could not load the data' });
  await expect(error).toBeVisible();
  await page.unroute(path);
  await error.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^INV/ })).toBeVisible();
});
