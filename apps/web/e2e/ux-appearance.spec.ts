import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { api, login } from './utils';

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: system appearance, contrast and compact layouts`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await login(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const companies = await api<{ data: { id: string; name: string }[] }>(page, 'get', '/companies');
    const client = companies.data[0]!;
    const invoices = await api<{ data: { companyId: string }[] }>(page, 'get', '/invoices');
    const invoiceClient = companies.data.find((company) => company.id === invoices.data[0]?.companyId);
    expect(invoiceClient, 'the seeded invoice company is present in the CRM list').toBeDefined();
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/companies/${client.id}`);
      const contacts = page.getByRole('heading', { name: /^Contacts(?: \d+)?$/ });
      await contacts.scrollIntoViewIfNeeded();
      await expect(contacts).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: info.outputPath(`crm-${theme}-${width}.png`) });
      await page.goto('/finance');
      if (width < 768) await page.getByRole('combobox', { name: 'Finance section', exact: true }).selectOption('invoices');
      else await page.getByRole('button', { name: 'Invoices', exact: true }).click();
      await expect(page.getByRole('button', { name: new RegExp(invoiceClient!.name) }).first()).toBeVisible();
      await page.screenshot({ path: info.outputPath(`invoices-${theme}-${width}.png`) });
      await page.getByRole('button', { name: 'New invoice', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'New invoice', exact: true });
      await dialog.getByRole('combobox', { name: 'Company', exact: true }).selectOption(client.id);
      await dialog.getByRole('textbox', { name: /^Description\s*, line 1$/ }).fill('Readable line item');
      await dialog.getByRole('spinbutton', { name: /^Unit price\s*, line 1$/ }).fill('100');
      const discount = dialog.getByRole('combobox', { name: 'Discount', exact: true });
      await discount.selectOption('percent');
      expect((await discount.boundingBox())!.width).toBeGreaterThanOrEqual(136);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      const create = dialog.getByRole('button', { name: 'Create draft', exact: true });
      await expect(create).toBeEnabled();
      await create.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`invoice-form-${theme}-${width}.png`) });
      await page.keyboard.press('Escape');
    }
    const ratios = await page.evaluate(() => {
      const ctx = document.createElement('canvas').getContext('2d')!;
      const css = getComputedStyle(document.documentElement);
      const rgb = (color: string) => {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
      };
      const token = (name: string) => rgb(`hsl(${css.getPropertyValue(`--${name}`)})`);
      const luminance = (channels: number[]) => {
        const linear = channels.map((n) => {
          const v = n / 255;
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
        return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
      };
      const contrast = (a: number[], b: number[]) => {
        const x = luminance(a), y = luminance(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      };
      const ratio = (a: string, b: string) => contrast(token(a), token(b));
      const ratios: Record<string, number> = Object.fromEntries([
        ...['background', 'surface', 'card', 'elevated', 'muted', 'accent'].flatMap((bg) => ['faint', 'muted-foreground'].map((fg) => [`${fg}/${bg}`, ratio(fg, bg)])),
        ['button', ratio('primary-foreground', 'action')], ['button-hover', ratio('primary-foreground', 'action-hover')],
        ['destructive-button', ratio('destructive-foreground', 'destructive-action')],
        ['destructive-button-hover', ratio('destructive-foreground', 'destructive-action-hover')],
        ['focus', ratio('ring', 'elevated')],
      ]);
      for (const tone of ['primary', 'destructive', 'success', 'warning']) {
        const probe = document.createElement('span');
        probe.className = `text-${tone}`;
        document.body.append(probe);
        const ink = rgb(getComputedStyle(probe).color);
        probe.remove();
        for (const bg of ['background', 'surface', 'card', 'elevated', 'muted', 'accent']) {
          ratios[`${tone}/${bg}`] = contrast(ink, token(bg));
          const tint = token(tone).map((v, i) => v * 0.2 + token(bg)[i]! * 0.8);
          ratios[`${tone}/${bg}-tint20`] = contrast(ink, tint);
        }
      }
      return ratios;
    });
    await writeFile(info.outputPath(`contrast-${theme}.json`), JSON.stringify(ratios, null, 2));
    for (const [pair, value] of Object.entries(ratios)) expect(value, pair).toBeGreaterThanOrEqual(pair === 'focus' ? 3 : 4.5);
    expect(errors).toEqual([]);
  });
}

test('Ukrainian interface declares its language and translates dialog controls', async ({ page }) => {
  await login(page);
  try {
    await api(page, 'patch', '/me', { locale: 'uk' });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'uk');
    await page.goto('/finance');
    await page.getByRole('button', { name: 'Рахунки', exact: true }).click();
    await page.getByRole('button', { name: 'Новий рахунок', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Скасувати', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Закрити', exact: true })).toBeVisible();
  } finally { await api(page, 'patch', '/me', { locale: 'en' }); }
});
