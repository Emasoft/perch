import { describe, expect, it } from 'vitest';
import { configuredSystemOne, endpointKey, FIRST_QUESTIONS, limitsFrom } from '../src/endpoint.js';

const DECISIONS = 'https://api.openai.com/v1/decisions';
const SYSTEM_ONE = 'https://api.typesafe.ai/v1/systemone';
const reply = data => new Response(JSON.stringify(data));

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

  it('says there is no endpoint before anything is read, rather than after a repository is parsed', async () => {
    const nothingSent = async () => { throw new Error('unexpected request'); };
    await expect(configuredSystemOne({ env: {}, fetchImpl: nothingSent })).rejects.toThrow('Perch has no endpoint. Set PERCH_BASE_URL');
    await expect(configuredSystemOne({ env: { PERCH_BASE_URL: '' }, fetchImpl: nothingSent })).rejects.toThrow('Perch has no endpoint');
  });

  it('names the variable the key belongs in, which depends on the endpoint', async () => {
    const nothingSent = async () => { throw new Error('unexpected request'); };
    await expect(configuredSystemOne({ env: { PERCH_BASE_URL: DECISIONS }, fetchImpl: nothingSent }))
      .rejects.toThrow(`OPENAI_API_KEY is not set. It holds the key for ${DECISIONS}.`);
    await expect(configuredSystemOne({ env: { PERCH_BASE_URL: SYSTEM_ONE }, fetchImpl: nothingSent }))
      .rejects.toThrow(`TYPESAFE_API_KEY is not set. It holds the key for ${SYSTEM_ONE}.`);
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
