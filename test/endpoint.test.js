import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredSystemOne, endpointKey, FIRST_QUESTIONS, limitsFrom } from '../src/endpoint.js';

const DECISIONS = 'https://api.openai.com/v1/decisions';
const SYSTEM_ONE = 'https://api.typesafe.ai/v1/systemone';
const reply = data => new Response(JSON.stringify(data));

// A machine Codex signed in to, or one it did not, which is what tells the two credential paths apart. Every test that reaches
// a client names its own, so the suite does not depend on whether the machine running it happens to be signed in.
const homes = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function codexHome(signedIn) {
  const home = await mkdtemp(join(tmpdir(), 'perch-codex-'));
  homes.push(home);
  if (signedIn) await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'codex-token', account_id: 'acct-codex' } }));
  return home;
}

describe('the variable holding the endpoint key', () => {
  it('is PERCH_API_KEY when it is set, whichever endpoint PERCH_BASE_URL names', () => {
    for (const url of [DECISIONS, SYSTEM_ONE, 'http://localhost:8123/infer', undefined]) {
      expect(endpointKey({ PERCH_API_KEY: 'k', PERCH_BASE_URL: url })).toBe('PERCH_API_KEY');
    }
  });

  it('is OPENAI_API_KEY for the Decisions API and TYPESAFE_API_KEY for any other endpoint', () => {
    expect(endpointKey({ PERCH_BASE_URL: DECISIONS })).toBe('OPENAI_API_KEY');
    // A trailing slash, a query or a fragment does not stop the URL being the Decisions API.
    for (const url of [`${DECISIONS}/`, `${DECISIONS}?v=2`, `${DECISIONS}#top`]) expect(endpointKey({ PERCH_BASE_URL: url })).toBe('OPENAI_API_KEY');
    expect(endpointKey({ PERCH_BASE_URL: SYSTEM_ONE })).toBe('TYPESAFE_API_KEY');
    expect(endpointKey({ PERCH_BASE_URL: 'http://localhost:8123/infer' })).toBe('TYPESAFE_API_KEY');
  });

  it('reads an exported but empty PERCH_API_KEY as unset rather than as the key', () => {
    // The shell says nothing with an empty variable, and taking it would fail a scan whose key is under the endpoint's own name.
    expect(endpointKey({ PERCH_API_KEY: '', PERCH_BASE_URL: DECISIONS })).toBe('OPENAI_API_KEY');
    expect(endpointKey({ PERCH_API_KEY: '', PERCH_BASE_URL: SYSTEM_ONE })).toBe('TYPESAFE_API_KEY');
  });
});

describe('limitsFrom', () => {
  it('sets only the limits that are given, so an endpoint that reports its own keeps them', () => {
    expect(limitsFrom({})).toEqual({});
    expect(limitsFrom({ PERCH_MAX_QUESTIONS: '', PERCH_MAX_OPTIONS: '', PERCH_CONTEXT_LENGTH: '' })).toEqual({});
  });

  it('reads PERCH_MAX_QUESTIONS and PERCH_MAX_OPTIONS as the whole numbers they name', () => {
    expect(limitsFrom({ PERCH_MAX_QUESTIONS: '10', PERCH_MAX_OPTIONS: '16' })).toEqual({ questions: 10, options: 16 });
  });

  it('turns PERCH_CONTEXT_LENGTH into the budgets one request is divided between', () => {
    expect(limitsFrom({ PERCH_CONTEXT_LENGTH: '250000' })).toEqual({ state: 200000, single: 240000, request: 250000 });
  });

  it('refuses a value it cannot read, since a scan sent in batches the model refuses reads nothing', () => {
    expect(() => limitsFrom({ PERCH_MAX_QUESTIONS: 'lots' })).toThrow('PERCH_MAX_QUESTIONS must be a whole number of at least 1, not lots');
    expect(() => limitsFrom({ PERCH_MAX_QUESTIONS: '0' })).toThrow('PERCH_MAX_QUESTIONS must be a whole number of at least 1, not 0');
    expect(() => limitsFrom({ PERCH_MAX_OPTIONS: '1' })).toThrow('PERCH_MAX_OPTIONS must be a whole number of at least 2, not 1');
    expect(() => limitsFrom({ PERCH_MAX_OPTIONS: '2.5' })).toThrow('PERCH_MAX_OPTIONS must be a whole number of at least 2, not 2.5');
    expect(() => limitsFrom({ PERCH_CONTEXT_LENGTH: '255' })).toThrow('PERCH_CONTEXT_LENGTH must be a whole number of at least 256, not 255');
  });
});

describe('configuredSystemOne', () => {
  it('opens with a first request small enough for a model that has not said what it takes', () => {
    // The endpoint has not reported its limits yet, so the first request has to fit the smallest model perch knows of.
    expect(FIRST_QUESTIONS).toBe(8);
  });

  it('asks the Decisions API when PERCH_BASE_URL says nothing, which is where gpt-6-luna is', async () => {
    const sent = [];
    const client = await configuredSystemOne({ env: { CODEX_HOME: await codexHome(true) }, fetchImpl: async url => {
      sent.push(String(url));
      return reply({ model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'a', probability: 0.2 }] });
    } });
    await client.ask({ code: 'a' }, { a: { type: 'noul', criteria: { true: 'yes', false: 'no' } } });
    expect(sent).toEqual([DECISIONS]);
  });

  it('names the variable the key belongs in, which depends on the endpoint', async () => {
    const signedOut = { CODEX_HOME: await codexHome(false) };
    const nothingSent = async () => { throw new Error('unexpected request'); };
    await expect(configuredSystemOne({ env: { ...signedOut, PERCH_BASE_URL: DECISIONS }, fetchImpl: nothingSent }))
      .rejects.toThrow("Set OPENAI_API_KEY to that endpoint's key");
    await expect(configuredSystemOne({ env: { ...signedOut, PERCH_BASE_URL: SYSTEM_ONE }, fetchImpl: nothingSent }))
      .rejects.toThrow("Set TYPESAFE_API_KEY to that endpoint's key");
  });

  it('spends the Codex sign-in on the Decisions API, and says whose plan it spends', async () => {
    // A subscription is an [OI] credential like any other, so a machine signed in to Codex needs no API key of its own. The
    // account travels as chatgpt-account-id, the header Codex sends.
    const sent = [];
    const client = await configuredSystemOne({ env: { CODEX_HOME: await codexHome(true) }, fetchImpl: async (url, options) => {
      sent.push({ url: String(url), auth: options.headers.authorization, account: options.headers['chatgpt-account-id'] });
      return reply({ model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'a', probability: 0.2 }] });
    } });
    await client.ask({ code: 'a' }, { a: { type: 'noul', criteria: { true: 'yes', false: 'no' } } });
    expect(sent).toEqual([{ url: DECISIONS, auth: 'Bearer codex-token', account: 'acct-codex' }]);
  });

  it('keeps the sign-in to [OI], since a token no other endpoint issued is not offered to it', async () => {
    const nothingSent = async () => { throw new Error('unexpected request'); };
    const env = { CODEX_HOME: await codexHome(true), PERCH_BASE_URL: SYSTEM_ONE };
    await expect(configuredSystemOne({ env, fetchImpl: nothingSent })).rejects.toThrow('Set TYPESAFE_API_KEY');
  });

  it('prefers a key in the variable the endpoint names, which was set for this shell on purpose', async () => {
    const sent = [];
    const env = { CODEX_HOME: await codexHome(true), OPENAI_API_KEY: 'sk-key' };
    const client = await configuredSystemOne({ env, fetchImpl: async (_, options) => {
      sent.push({ auth: options.headers.authorization, account: options.headers['chatgpt-account-id'] });
      return reply({ model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'a', probability: 0.2 }] });
    } });
    await client.ask({ code: 'a' }, { a: { type: 'noul', criteria: { true: 'yes', false: 'no' } } });
    // A key is not scoped to an account, so there is none to name.
    expect(sent).toEqual([{ auth: 'Bearer sk-key', account: undefined }]);
  });

  it('sends its questions to PERCH_BASE_URL and nowhere else, so another endpoint is a setting rather than a build', async () => {
    // With PERCH_BASE_URL set, nothing goes anywhere else, and there is no
    // scan to report, because no service behind that endpoint takes one.
    const requests = [];
    const client = await configuredSystemOne({
      env: { PERCH_BASE_URL: 'https://api.example.com/v1/systemone', PERCH_API_KEY: 'key', PERCH_MODEL_ID: 'jev/semif' },
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), auth: options.headers.authorization, model: JSON.parse(options.body).model });
        return reply({ model: 'jev/semif', answers: { a: { noul: 0.9 } }, usage: null });
      },
    });
    const reading = await client.ask({ code: 'a' }, { a: { type: 'noul', criteria: { true: 'yes', false: 'no' } } });
    expect(reading.answers).toEqual({ a: { noul: 0.9 } });
    expect(requests).toEqual([{ url: 'https://api.example.com/v1/systemone', auth: 'Bearer key', model: 'jev/semif' }]);
    expect(client.startScan).toBeUndefined();
    expect(client.report).toBeUndefined();
  });
});
