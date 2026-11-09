import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountIdFromToken, codexAuthPath, codexCredential } from '../src/codex-auth.js';

const CLAIM = 'https://api.openai.com/auth';
/** A token shaped as codex writes one: three dot-separated parts, the middle one the claims. */
const token = claims => ['header', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.');

const homes = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function codexHome(auth) {
  const home = await mkdtemp(join(tmpdir(), 'perch-codex-'));
  homes.push(home);
  if (auth !== undefined) await writeFile(join(home, 'auth.json'), typeof auth === 'string' ? auth : JSON.stringify(auth));
  return home;
}

describe('the file codex login writes', () => {
  it('is $CODEX_HOME/auth.json, and ~/.codex/auth.json when CODEX_HOME is unset', () => {
    expect(codexAuthPath({ CODEX_HOME: '/codex' })).toBe('/codex/auth.json');
    expect(codexAuthPath({ HOME: '/home/someone' })).toBe('/home/someone/.codex/auth.json');
  });
});

describe('the account a ChatGPT token belongs to', () => {
  it('is read from the claim the token carries it in', () => {
    expect(accountIdFromToken(token({ [CLAIM]: { chatgpt_account_id: 'acct-1' } }))).toBe('acct-1');
  });

  it('is nothing at all for anything that is not a JWT carrying that claim, which only costs an optional header', () => {
    for (const value of ['', 'sk-key', 'a.b', `${token({})}.extra`, 'a.!!!not-base64!!!.c']) expect(accountIdFromToken(value)).toBe('');
    expect(accountIdFromToken(token({ [CLAIM]: { chatgpt_plan_type: 'pro' } }))).toBe('');
  });
});

describe('the credential codex login leaves', () => {
  it('is nothing when nobody has signed in, so another source still gets its turn', async () => {
    expect(await codexCredential({ CODEX_HOME: await codexHome() })).toBeNull();
  });

  it('is the access token and the account stored beside it', async () => {
    const access = token({ [CLAIM]: { chatgpt_account_id: 'acct-1' } });
    const home = await codexHome({ tokens: { access_token: access, account_id: 'acct-2', refresh_token: 'r' } });
    expect(await codexCredential({ CODEX_HOME: home })).toEqual({ token: access, accountId: 'acct-2' });
  });

  it('takes the account from the token when the file does not store one', async () => {
    const access = token({ [CLAIM]: { chatgpt_account_id: 'acct-3' } });
    const home = await codexHome({ tokens: { access_token: access } });
    expect(await codexCredential({ CODEX_HOME: home })).toEqual({ token: access, accountId: 'acct-3' });
  });

  it('refuses a file it cannot read rather than reporting nobody signed in, since that file is what perch would spend', async () => {
    const home = await codexHome('not json at all');
    await expect(codexCredential({ CODEX_HOME: home })).rejects.toThrow('is not the file codex login writes');
  });
});
