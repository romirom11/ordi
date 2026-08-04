/**
 * Password reset (PRD §6): the self-serve "forgot password" flow and the admin
 * one for the person whose reset email never arrives.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, anon, json } from './helpers';
import { verifyPassword, sha256 } from '../lib/crypto';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;

beforeEach(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
});

/** The raw token only exists inside the emailed link, so tests read it there. */
function tokenOf(resetUrl: string): string {
  return new URL(resetUrl).searchParams.get('token')!;
}

/** What the self-serve flow left behind for an address, if anything. */
async function storedGrantFor(email: string) {
  const { db } = getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  const [row] = await db.select().from(schema.passwordResets).where(eq(schema.passwordResets.userId, user!.id));
  return row;
}

describe('forgot password', () => {
  it('answers the same for a known and an unknown address', async () => {
    const known = await anon().post('/auth/forgot-password', { email: 'owner@test.local' });
    const unknown = await anon().post('/auth/forgot-password', { email: 'nobody@test.local' });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await json(known)).toEqual(await json(unknown));

    const { db } = getDb();
    const rows = await db.select().from(schema.passwordResets);
    expect(rows).toHaveLength(1); // only the real account got a grant
  });

  it('stores the token hashed, never in the clear', async () => {
    expect((await anon().post('/auth/forgot-password', { email: 'owner@test.local' })).status).toBe(200);
    const grant = await storedGrantFor('owner@test.local');
    expect(grant!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(grant!.requestedBy).toBe('self');
  });
});

describe('admin-issued reset', () => {
  it('hands back a link that sets a new password and kills old sessions', async () => {
    const target = users.member!;
    const issued = await json(reqAs(users.owner!.cookie).post(`/users/${target.userId}/reset-password`, {}));
    expect(issued.resetUrl).toContain('/reset-password?token=');

    const token = tokenOf(issued.resetUrl);
    // The link identifies the account before anything is typed into it.
    const preview = await json(anon().get(`/auth/reset-password/${token}`));
    expect(preview.email).toBe('member@test.local');

    const res = await anon().post('/auth/reset-password', { token, password: 'brand-new-password' });
    expect(res.status).toBe(200);

    const { db } = getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, target.userId));
    expect(verifyPassword('brand-new-password', user!.passwordHash)).toBe(true);
    // Sessions opened with the old password are gone – that is the point.
    const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, target.userId));
    expect(sessions).toHaveLength(0);
    expect((await reqAs(target.cookie).get('/me')).status).toBe(401);

    const login = await anon().post('/auth/login', { email: 'member@test.local', password: 'brand-new-password' });
    expect(login.status).toBe(200);
  });

  it('is single use', async () => {
    const issued = await json(reqAs(users.owner!.cookie).post(`/users/${users.member!.userId}/reset-password`, {}));
    const token = tokenOf(issued.resetUrl);
    expect((await anon().post('/auth/reset-password', { token, password: 'first-password-1' })).status).toBe(200);

    const second = await anon().post('/auth/reset-password', { token, password: 'second-password-2' });
    expect(second.status).toBe(404);
    expect((await anon().get(`/auth/reset-password/${token}`)).status).toBe(404);
  });

  it('retires the previous link when a new one is issued', async () => {
    const first = await json(reqAs(users.owner!.cookie).post(`/users/${users.member!.userId}/reset-password`, {}));
    const second = await json(reqAs(users.owner!.cookie).post(`/users/${users.member!.userId}/reset-password`, {}));

    expect((await anon().get(`/auth/reset-password/${tokenOf(first.resetUrl)}`)).status).toBe(404);
    expect((await anon().get(`/auth/reset-password/${tokenOf(second.resetUrl)}`)).status).toBe(200);
  });

  it('rejects an expired link', async () => {
    const issued = await json(reqAs(users.owner!.cookie).post(`/users/${users.member!.userId}/reset-password`, {}));
    const token = tokenOf(issued.resetUrl);
    const { db } = getDb();
    await db.update(schema.passwordResets).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.passwordResets.tokenHash, sha256(token)));

    expect((await anon().post('/auth/reset-password', { token, password: 'too-late-password' })).status).toBe(404);
  });

  it('clears a lockout so the account is usable again', async () => {
    const { db } = getDb();
    await db.update(schema.users)
      .set({ failedLogins: 20, lockedUntil: new Date(Date.now() + 15 * 60_000) })
      .where(eq(schema.users.id, users.member!.userId));

    const issued = await json(reqAs(users.owner!.cookie).post(`/users/${users.member!.userId}/reset-password`, {}));
    await anon().post('/auth/reset-password', { token: tokenOf(issued.resetUrl), password: 'unlocked-password' });

    const login = await anon().post('/auth/login', { email: 'member@test.local', password: 'unlocked-password' });
    expect(login.status).toBe(200);
  });

  it('needs users.manage', async () => {
    const res = await reqAs(users.member!.cookie).post(`/users/${users.owner!.userId}/reset-password`, {});
    expect(res.status).toBe(403);
    expect((await anon().post(`/users/${users.owner!.userId}/reset-password`, {})).status).toBe(401);
  });

  it('refuses deactivated users and agents', async () => {
    const { db } = getDb();
    await db.update(schema.users).set({ isActive: false }).where(eq(schema.users.id, users.member!.userId));
    expect((await reqAs(users.owner!.cookie).post(`/users/${users.member!.userId}/reset-password`, {})).status).toBe(422);

    const [role] = await db.select().from(schema.roles).where(eq(schema.roles.key, 'member'));
    const agentId = ulid();
    await db.insert(schema.users).values({
      id: agentId, email: 'agent@test.local', name: 'Agent', roleId: role!.id, actorType: 'agent',
    });
    expect((await reqAs(users.owner!.cookie).post(`/users/${agentId}/reset-password`, {})).status).toBe(422);
  });
});
