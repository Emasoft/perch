import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installArgs, isLoopback, LOCAL_MODEL, localModelName, mlxDecisionPath, sharedServer, SHARED_PORTS, startLocalModel } from '../src/local.js';

const homes = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function home(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'perch-local-'));
  homes.push(dir);
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body, { mode: 0o755 });
  return dir;
}

/** A child process that prints what a real one prints, at the moment the test says. */
function fakeChild({ print = [], exit = null } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = [];
  child.kill = signal => { child.killed.push(signal); child.signalCode = signal; child.emit('exit', null, signal); return true; };
  child.print = () => { for (const line of print) child.stderr.emit('data', `${line}\n`); };
  child.fail = code => { child.exitCode = code; child.emit('exit', code, null); };
  // Whatever it printed, then how it ended: a child that dies still printed the reason it died.
  setImmediate(() => { child.print(); if (exit !== null) child.fail(exit); });
  return child;
}

/** A /health response naming the model, as the server's own does. */
const healthy = () => ({ ok: true, json: async () => ({ status: 'ok', model: 'elephant-1', loaded: ['elephant-1'] }) });

describe('which model the fallback uses', () => {
  it('is elephant-1 unless PERCH_LOCAL_MODEL says otherwise', () => {
    expect(localModelName({})).toEqual({ name: LOCAL_MODEL, repo: 'baselabs/elephant-1' });
    expect(localModelName({ PERCH_LOCAL_MODEL: 'other-model' })).toEqual({ name: 'other-model', repo: 'baselabs/elephant-1' });
  });

  it('is off for the one spelling of off, and never for an empty variable', () => {
    // One spelling, because perch has no other boolean-valued setting and a second one is a second thing to get wrong.
    expect(localModelName({ PERCH_LOCAL_MODEL: 'off' })).toBeNull();
    expect(localModelName({ PERCH_LOCAL_MODEL: '' })).toEqual({ name: LOCAL_MODEL, repo: 'baselabs/elephant-1' });
  });
});

describe('finding mlx-decision', () => {
  it('takes MLX_DECISION_BIN when it names an executable', async () => {
    const dir = await home({ tool: '#!/bin/sh\n' });
    expect(await mlxDecisionPath({ MLX_DECISION_BIN: join(dir, 'tool') }, async () => null)).toBe(join(dir, 'tool'));
  });

  it('is nothing when the named binary is not there, rather than falling through to another one', async () => {
    // A path set on purpose is the answer, even when it is the wrong answer: silently running a different binary is worse.
    expect(await mlxDecisionPath({ MLX_DECISION_BIN: '/nowhere/mlx-decision' }, async () => '/usr/bin/mlx-decision')).toBeNull();
  });

  it('finds it on the PATH before looking in ~/.local/bin', async () => {
    const dir = await home({ 'mlx-decision': '#!/bin/sh\n' });
    expect(await mlxDecisionPath({ HOME: dir }, async () => '/opt/homebrew/bin/mlx-decision')).toBe('/opt/homebrew/bin/mlx-decision');
  });

  it('finds it in ~/.local/bin, which is where uv tool install puts it', async () => {
    const dir = await home();
    const local = join(dir, '.local', 'bin');
    await mkdir(local, { recursive: true });
    await writeFile(join(local, 'mlx-decision'), '#!/bin/sh\n', { mode: 0o755 });
    expect(await mlxDecisionPath({ HOME: dir }, async () => null)).toBe(join(local, 'mlx-decision'));
  });

  it('is nothing on a machine that has neither', async () => {
    expect(await mlxDecisionPath({ HOME: await home() }, async () => null)).toBeNull();
  });
});

describe('installing mlx-decision', () => {
  it('prefers uv, falls back to pipx, and says so when neither is there', () => {
    expect(installArgs({ uv: 'uv', pipx: 'pipx' })).toEqual(['uv', 'tool', 'install', 'mlx-decision']);
    expect(installArgs({ pipx: 'pipx' })).toEqual(['pipx', 'install', 'mlx-decision']);
    expect(installArgs({})).toBeNull();
  });
});

describe('starting the server', () => {
  it('starts on the shared port and does not pick a free one, since the port is the only thing keeping two processes from two servers', async () => {
    // mlx-decision builds the Host headers it answers from the port it was told to use, so --port 0 serves on a port while
    // refusing every request that names it. The port also has to be the same one every perch process would choose, which is
    // why it is fixed rather than free: two free ports are two servers and the model held twice. The first shared port, not
    // the last: it is the one a server on this machine is most likely already holding, so the bind fails into adoption
    // rather than silently succeeding on a free port beside a running one.
    const seen = [];
    const server = await startLocalModel({
      bin: '/fake/mlx-decision', timeoutMs: 2000,
      spawn: (command, args) => { seen.push([command, ...args]); return fakeChild({ print: ['INFO:     Uvicorn running on http://127.0.0.1:8123'] }); },
      fetchImpl: async () => healthy(),
    });
    expect(seen[0]).toEqual(['/fake/mlx-decision', 'server', '-m', 'baselabs/elephant-1', '--default-model', 'elephant-1', '--host', '127.0.0.1', '--port', '8123']);
    expect(server.baseUrl).toBe('http://127.0.0.1:8123/v1/systemone');
    expect(server.model).toBe('elephant-1');
  });

  it('reports a child that died, with its own last line, instead of waiting out the timeout', async () => {
    await expect(startLocalModel({
      bin: '/fake/mlx-decision', timeoutMs: 2000,
      spawn: () => fakeChild({ print: ['Traceback: no such model'], exit: 3 }), fetchImpl: async () => ({ ok: false }),
    })).rejects.toThrow('exited with 3: Traceback: no such model');
  });

  it('adopts the server that took the port, rather than starting a second on another one', async () => {
    // The port is the exclusion: a sibling perch, or any mlx-decision started on that port, is the one server this machine
    // gets. The loser waits for it to answer and then uses it, and never spawns again.
    const busy = { print: ['ERROR:    [Errno 48] error while attempting to bind on address'] };
    const started = [];
    const server = await startLocalModel({
      bin: '/fake/mlx-decision', timeoutMs: 2000, adoptTimeoutMs: 500,
      spawn: () => { started.push(true); return fakeChild({ ...busy, exit: 3 }); },
      fetchImpl: async () => healthy(),
    });
    expect(started).toHaveLength(1);
    expect(server.baseUrl).toBe('http://127.0.0.1:8123/v1/systemone');
    expect(server.adopted).toBe(true);
    expect(server.stop).toBeUndefined();
  });

  it('does not adopt something on the port that is not serving the model, and does not start beside it either', async () => {
    // Whatever holds the shared port and never serves elephant-1 is not perch's to replace, and starting a second server
    // beside it is the one thing this module exists to prevent. The error names the two ways out.
    const busy = { print: ['ERROR:    [Errno 48] error while attempting to bind on address'] };
    const spawns = [];
    await expect(startLocalModel({
      bin: '/fake/mlx-decision', timeoutMs: 2000, adoptTimeoutMs: 300,
      spawn: () => { spawns.push(true); return fakeChild({ ...busy, exit: 3 }); }, fetchImpl: async () => ({ ok: false }),
    })).rejects.toThrow('port 8123 is held by something that is not serving elephant-1');
    expect(spawns).toHaveLength(1);
  });
  it('stops the server it started, and does not stop one already gone', async () => {
    const child = fakeChild({ print: ['Uvicorn running on http://127.0.0.1:8123'] });
    const server = await startLocalModel({ bin: '/fake/mlx-decision', timeoutMs: 2000,
      spawn: () => child, fetchImpl: async () => healthy() });
    server.stop();
    expect(child.killed).toEqual(['SIGTERM']);
  });
});

describe('a server this machine is already serving', () => {
  /** A /health body from a server that is up, saying what it serves. */
  const up = model => async url => {
    if (!String(url).endsWith('/health')) return { ok: false };
    return { ok: true, json: async () => ({ status: 'ok', model, loaded: [model] }) };
  };
  const nothing = async () => { throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }); };

  it('is found on the port a running mlx-decision named on its own command line', async () => {
    // The shared server on this machine was started by hand on 8123, so finding it cannot depend on a port perch chose.
    const found = await sharedServer({ model: 'elephant-1', fetchImpl: up('elephant-1'),
      ps: async () => ['41469 /usr/local/bin/mlx-decision server -m baselabs/elephant-1 --host 127.0.0.1 --port 8123'].join('\n') });
    expect(found).toEqual({ baseUrl: 'http://127.0.0.1:8123/v1/systemone' });
  });

  it('is found through PERCH_LOCAL_URL, without reading the process table at all', async () => {
    let asked = null;
    const found = await sharedServer({ env: { PERCH_LOCAL_URL: 'http://127.0.0.1:9000/v1/systemone' }, model: 'elephant-1',
      fetchImpl: async url => { asked = String(url); return up('elephant-1')(url); }, ps: async () => { throw new Error('must not run'); } });
    expect(found).toEqual({ baseUrl: 'http://127.0.0.1:9000/v1/systemone' });
    expect(asked).toBe('http://127.0.0.1:9000/health');
  });

  it('is not one serving another model, which is left alone rather than doubled', async () => {
    // A different model on the port is a server doing something else; starting elephant-1 beside it is the second server
    // this module exists to prevent, so the mismatch is reported as not found and the caller decides.
    const found = await sharedServer({ model: 'elephant-1', fetchImpl: up('other-model'), ps: async () => '' });
    expect(found).toBeNull();
  });

  it('is looked for on the shared ports when nothing names one, and nowhere else', async () => {
    const asked = [];
    const found = await sharedServer({ model: 'elephant-1',
      fetchImpl: async url => { asked.push(String(url)); return up('elephant-1')(url); }, ps: async () => '' });
    expect(found).toEqual({ baseUrl: `http://127.0.0.1:${SHARED_PORTS[0]}/v1/systemone` });
    expect(asked).toEqual([`http://127.0.0.1:${SHARED_PORTS[0]}/health`]);
  });

  it('is nowhere when nothing answers, which is the case that starts one', async () => {
    expect(await sharedServer({ model: 'elephant-1', fetchImpl: nothing, ps: async () => '' })).toBeNull();
  });

  it('has a loopback check that admits this machine and refuses everywhere else', () => {
    expect(isLoopback('http://127.0.0.1:8123/v1/systemone')).toBe(true);
    expect(isLoopback('http://localhost:8123/v1/systemone')).toBe(true);
    expect(isLoopback('http://[::1]:8123/v1/systemone')).toBe(true);
    expect(isLoopback('http://10.0.0.5:8123/v1/systemone')).toBe(false);
    expect(isLoopback('http://127.0.0.1:8123@evil.example.com/v1/systemone')).toBe(false);
    expect(isLoopback('not a url')).toBe(false);
  });
});
