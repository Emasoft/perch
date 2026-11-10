import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
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
    const client = await configuredSystemOne({ env: { CODEX_HOME: await codexHome(true) }, probe: false, fetchImpl: async url => {
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
    const client = await configuredSystemOne({ env: { CODEX_HOME: await codexHome(true) }, probe: false, fetchImpl: async (url, options) => {
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
    const client = await configuredSystemOne({ env, probe: false, fetchImpl: async (_, options) => {
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
      probe: false,
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

describe('falling back to the local model', () => {
  const signedIn = async () => ({ CODEX_HOME: await codexHome(true) });
  const quota = () => new Response(JSON.stringify({ error: { message: 'Codex usage limit reached.', type: 'usage_limit_reached' } }), { status: 429 });
  const rejected = () => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 });
  const down = () => { throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }); };
  /** An executable standing in for the installed binary, so no test runs whatever mlx-decision this machine happens to have. */
  const binary = async () => {
    const file = join(await codexHome(false), 'mlx-decision');
    await writeFile(file, '#!/bin/sh\n', { mode: 0o755 });
    return file;
  };
  /** A server process that reports the port it is serving on, as mlx-decision does. */
  const fakeServer = port => {
    const child = new EventEmitter();
    child.pid = 4242; child.exitCode = null; child.signalCode = null;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.killed = []; child.kill = signal => { child.killed.push(signal); child.signalCode = signal; child.emit('exit', null, signal); return true; };
    setImmediate(() => child.stderr.emit('data', `INFO:     Uvicorn running on http://127.0.0.1:${port} (Press CTRL+C to quit)\n`));
    return child;
  };
  const oneQuestion = { a: { type: 'noul', criteria: { true: 'yes', false: 'no' } } };

  it('sends exactly one extra request to find out whether the endpoint answers', async () => {
    let requests = 0;
    const client = await configuredSystemOne({ env: await signedIn(), fetchImpl: async () => {
      requests++;
      return reply({ model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'probe', probability: 0.5 }] });
    } });
    expect(requests).toBe(1);
    // What comes back is the endpoint's own client, not a local one: the probe said yes.
    expect(client.id).toBe('gpt-6-luna');
  });

  it('reads with the local model when the subscription window is spent, and says so on stdout', async () => {
    // The case the fallback exists for, so the body is the one [OI] actually sends. stdout rather than the log, because
    // `perch check` hands the log its debug channel and would otherwise switch models in silence.
    const said = [], logged = [];
    const client = await configuredSystemOne({
      env: { ...(await signedIn()), MLX_DECISION_BIN: await binary() }, stdout: line => said.push(line), log: line => logged.push(line), tty: false,
      fetchImpl: async url => (String(url).includes('127.0.0.1') ? reply({ model: 'elephant-1', answers: { a: { noul: 0.2 } } }) : quota()),
      spawn: () => fakeServer(5100),
    });
    expect(client.id).toBe('elephant-1');
    expect(said.join('\n')).toContain('Reading with elephant-1 on this machine instead');
    expect(logged.join('\n')).toContain('falling back to elephant-1');
  });

  it('uses the server this machine is already running, and spawns nothing', async () => {
    // One server holds the whole model, so a fallback that starts a second beside a running one doubles the memory of a
    // machine that already answered. Nothing is started, nothing is stopped at exit: the server is not perch's.
    const started = [];
    const client = await configuredSystemOne({
      env: await signedIn(), tty: false,
      fetchImpl: async url => (String(url).endsWith('/health')
        ? new Response(JSON.stringify({ status: 'ok', model: 'elephant-1', loaded: ['elephant-1'] }))
        : String(url).includes('127.0.0.1') ? reply({ model: 'elephant-1', answers: { a: { noul: 0.2 } } }) : quota()),
      spawn: (...argv) => { started.push(argv); return fakeServer(5100); },
    });
    expect(client.id).toBe('elephant-1');
    expect(started).toEqual([]);
  });

  it('does not fall back when the key is rejected, which is a five-second fix the user has to see', async () => {
    // 401 is not an endpoint that cannot answer; it is a key that does not work. Demoting every later scan to a local model
    // instead would hide the message and the fix with it.
    await expect(configuredSystemOne({ env: await signedIn(), fetchImpl: async () => rejected(), tty: false })).rejects.toThrow('HTTP 401');
  });

  it('does not fall back when the request is the wrong size, since a smaller model is a smaller budget', async () => {
    // The endpoint said the reading is too large, so it is rebuilt smaller and asked again. A local model with a sixteenth of the
    // budget is smaller still, and switching would turn one oversized method into a run that reads nothing at all.
    const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'context_length_exceeded: input is too long' } }), { status: 400 });
    await expect(configuredSystemOne({ env: await signedIn(), fetchImpl, tty: false })).rejects.toThrow('Check incomplete: server rejected the request size');
  });

  it('never offers another endpoint a model it did not choose', async () => {
    // PERCH_BASE_URL naming TypeSafe is a decision, and a local model is not the thing they decided on. There is no probe either:
    // the fallback cannot run here, so a request spent finding out whether the endpoint is up would buy nothing.
    const client = await configuredSystemOne({ env: { PERCH_BASE_URL: SYSTEM_ONE, PERCH_API_KEY: 'k' }, fetchImpl: async () => rejected(), tty: false });
    await expect(client.ask({ code: 'a' }, oneQuestion)).rejects.toThrow('HTTP 401');
  });

  it('is off when PERCH_LOCAL_MODEL is off, and the endpoint error is the one that comes back', async () => {
    const client = await configuredSystemOne({ env: { ...(await signedIn()), PERCH_LOCAL_MODEL: 'off' }, fetchImpl: async () => quota(), tty: false });
    await expect(client.ask({ code: 'a' }, oneQuestion)).rejects.toThrow('Codex usage limit reached');
  });

  it('names both failures when the fallback itself cannot start', async () => {
    // The endpoint's failure is why the fallback ran; the local one is why it did not work. Reporting only one leaves the user
    // chasing the wrong half of a two-part problem.
    await expect(configuredSystemOne({ env: { ...(await signedIn()), MLX_DECISION_BIN: '/nowhere/mlx-decision' }, fetchImpl: down, tty: false }))
      .rejects.toThrow('fetch failed. mlx-decision is not installed');
  });

  it('refuses a PERCH_LOCAL_URL that names another machine, rather than sending code to it', async () => {
    // Adopting a server means posting repository code to whatever answers there. Only this machine is one the user decided
    // to serve that on; anywhere else is a request perch was never asked to make.
    await expect(configuredSystemOne({
      env: { ...(await signedIn()), PERCH_LOCAL_URL: 'http://10.0.0.5:8123/v1/systemone' }, fetchImpl: down, tty: false,
    })).rejects.toThrow('PERCH_LOCAL_URL must name this machine');
  });

  it('will not install a model on a machine nobody is sitting at', async () => {
    // A CI runner reaching this branch would download gigabytes onto hardware whose owner never asked, and the run has already
    // failed visibly by then. Nothing is found: the PATH is empty and the home it would fall back to is a fresh directory, so this
    // cannot pick up whatever mlx-decision the machine running the suite happens to have.
    const started = [];
    await expect(configuredSystemOne({ env: { CODEX_HOME: await codexHome(true), HOME: await codexHome(false), PATH: '' }, fetchImpl: down, tty: false,
      spawn: (...argv) => started.push(argv) })).rejects.toThrow('Install it with: uv tool install mlx-decision');
    expect(started).toEqual([]);
  });
});
