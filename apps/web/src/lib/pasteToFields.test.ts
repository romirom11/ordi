import { describe, it, expect } from 'vitest';
import { pasteToFields, fieldKeyFor } from './pasteToFields';

const labels = { login: 'Login', password: 'Password', url: 'URL', apiKey: 'API key', note: 'Note' };

describe('pasteToFields', () => {
  it('reads label: value lines', () => {
    expect(pasteToFields('Login: admin@acme.com\nPassword: Hunter2!\nAdmin panel: https://acme.com/admin', labels)).toEqual([
      { key: 'login', label: 'Login', type: 'text', value: 'admin@acme.com' },
      { key: 'password', label: 'Password', type: 'password', value: 'Hunter2!' },
      { key: 'admin_panel', label: 'Admin panel', type: 'url', value: 'https://acme.com/admin' },
    ]);
  });

  it('reads bare lines: a link, an email, a key-looking token, a short secret', () => {
    expect(pasteToFields('https://dashboard.stripe.com\nops@acme.com\nsk_test_51NnAbCdEfGhIjKlMn\nqwerty12', labels).map((f) => [f.type, f.key])).toEqual([
      ['url', 'url'], ['text', 'login'], ['api_key', 'api_key'], ['password', 'password'],
    ]);
  });

  it('understands Ukrainian labels and keeps an ascii key', () => {
    const [login, pass] = pasteToFields('Логін: manager\nПароль: секрет123', labels);
    expect(login).toMatchObject({ type: 'text', key: 'login', label: 'Логін' });
    expect(pass).toMatchObject({ type: 'password', key: 'password' });
  });

  it('does not split a URL at its scheme, and makes repeated keys unique', () => {
    const fields = pasteToFields('https://a.example.com\nhttps://b.example.com', labels);
    expect(fields.map((f) => f.key)).toEqual(['url', 'url_2']);
    expect(fields[0]!.value).toBe('https://a.example.com');
  });

  it('treats an unknown single-word value as a password, never as visible text', () => {
    expect(pasteToFields('Code: 8f2k9x', labels)[0]).toMatchObject({ type: 'password' });
    expect(pasteToFields('API token = ghp_abc', labels)[0]).toMatchObject({ type: 'api_key', key: 'api_token' });
  });

  it('builds keys from labels', () => {
    expect(fieldKeyFor('Webhook Secret', 'password')).toBe('webhook_secret');
    expect(fieldKeyFor('1st code', 'password')).toBe('password');
  });
});
