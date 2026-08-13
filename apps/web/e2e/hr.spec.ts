/**
 * The HR module end to end: the renamed section with its tabs, the team
 * calendar fed by real leave/holiday/birthday data, the extended employee
 * card, and the field-group questionnaire round-trip between the profile
 * and the card.
 */
import { test, expect } from '@playwright/test';
import { login, api } from './utils';

const ym = () => {
  const d = new Date();
  return { y: d.getFullYear(), m: String(d.getMonth() + 1).padStart(2, '0') };
};

test('People became HR and the calendar shows absences, holidays and birthdays', async ({ page }) => {
  await login(page);

  const { y, m } = ym();
  const me = await api<{ user: { id: string } }>(page, 'get', '/me');
  const emp = await api<{ id: string }>(page, 'post', '/employees', {
    firstName: 'Calla', lastName: 'Ndlela', userId: me.user.id,
    birthday: `1993-${m}-27`, telegram: '@calla', email: 'calla@personal.test',
    phone: '+380631234567', joinDate: '2024-05-01',
  });
  const lt = await api<{ id: string }>(page, 'post', '/leave-types', { name: 'Vacation' });
  const lr = await api<{ id: string }>(page, 'post', '/leave-requests', {
    employeeId: emp.id, leaveTypeId: lt.id, fromDate: `${y}-${m}-08`, toDate: `${y}-${m}-09`, reason: 'e2e',
  });
  await api(page, 'post', `/leave-requests/${lr.id}/approve`);
  const cal = await api<{ id: string }>(page, 'post', '/holiday-calendars', { name: 'E2E holidays' });
  await api(page, 'post', '/holidays', { calendarId: cal.id, date: `${y}-${m}-15`, name: 'Company day' });

  // The sidebar says HR now.
  await expect(page.getByRole('link', { name: 'HR' })).toBeVisible();
  await page.goto('/people');
  for (const tab of ['Employees', 'Leave', 'Calendar']) {
    await expect(page.getByText(tab, { exact: true }).first()).toBeVisible();
  }

  await page.getByText('Calendar', { exact: true }).first().click();
  await expect(page.getByText('Approved absence')).toBeVisible(); // legend
  await expect(page.getByText('Calla Ndlela').first()).toBeVisible(); // absence entry
  await expect(page.getByText('Company day').first()).toBeVisible(); // holiday
  await expect(page.getByText('Calla N.').first()).toBeVisible(); // birthday chip

  // The chosen tab survives navigating away and back (view-state persistence).
  await page.goto('/projects');
  await page.goto('/people');
  await expect(page.getByText('Approved absence')).toBeVisible();
});

test('the employee card carries contacts, telegram, documents and the questionnaire', async ({ page }) => {
  await login(page);

  const stamp = Date.now();
  const me = await api<{ user: { id: string } }>(page, 'get', '/me');
  // The owner may already be linked to an employee from the previous test –
  // reuse it instead of colliding.
  const employees = await api<{ data: { id: string; userId?: string | null }[] }>(page, 'get', '/employees');
  let empId = employees.data.find((e) => e.userId === me.user.id)?.id;
  if (!empId) {
    empId = (await api<{ id: string }>(page, 'post', '/employees', {
      firstName: 'Owner', lastName: 'Person', userId: me.user.id,
      telegram: '@owner_person', email: 'owner.personal@test.local', birthday: '1990-01-15',
    })).id;
  }

  // A questionnaire group with a select field, self-writable.
  const group = await api<{ id: string }>(page, 'post', '/custom-field-groups', {
    entityType: 'employees', name: `Анкета ${stamp}`,
  });
  await api(page, 'post', '/custom-fields', {
    entityType: 'employees', key: `tshirt_${stamp}`, label: 'T-shirt size', type: 'select', groupId: group.id,
    options: [{ value: 's', label: 'S' }, { value: 'm', label: 'M' }, { value: 'l', label: 'L' }],
  });
  await api(page, 'put', `/custom-field-groups/${group.id}/grants`, {
    grants: [{ principal: 'self', level: 'write' }],
  });

  // Fill it in on the profile page.
  await page.goto('/profile');
  await expect(page.getByText('HR questionnaire')).toBeVisible();
  await page.getByText('T-shirt size', { exact: true }).locator('..').getByRole('button').first().click();
  await page.getByRole('menuitem', { name: 'M', exact: true }).click();
  await expect(page.getByText(/Filled in|Partially filled/)).toBeVisible();

  // The card mirrors the answer inside the group's section.
  await page.goto(`/people/${empId}`);
  await expect(page.getByText(`Анкета ${stamp}`)).toBeVisible();
  await expect(page.getByText('T-shirt size', { exact: true })).toBeVisible();
  await expect(page.getByText('M', { exact: true }).first()).toBeVisible();

  // Contact rows.
  await expect(page.getByText('Work email')).toBeVisible();
  await expect(page.getByText('Personal email')).toBeVisible();
  await expect(page.getByText('Telegram')).toBeVisible();

  // Documents: attach via API (upload rides the same pipeline the UI uses),
  // then the section lists it and opens the preview dialog.
  const upload = await page.request.post('/api/v1/attachments', {
    multipart: {
      file: { name: `contract-${stamp}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF') },
    },
  });
  expect(upload.status()).toBe(201);
  const att = await upload.json();
  await api(page, 'post', `/employees/${empId}/documents`, { attachmentId: att.id });
  await page.reload();
  await expect(page.getByText('Documents', { exact: true })).toBeVisible();
  await expect(page.getByText(`contract-${stamp}.pdf`)).toBeVisible();
});
