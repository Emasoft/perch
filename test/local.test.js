import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installArgs, isLoopback, LOCAL_MODEL, localModelName, LOCKF, mlxDecisionPath, sharedServer, SHARED_PORTS, startLocalModel } from '../src/local.js';

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

/** A machine with no lockf and no LaunchAgent, whatever the one running the tests is: a real HOME would decide these tests. */
const plain = async () => ({ env: { HOME: await home() }, platform: 'linux' });

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
      bin: '/fake/mlx-decision', timeoutMs: 2000, ...await plain(),
      spawn: (command, args) => { seen.push([command, ...args]); return fakeChild({ print: ['INFO:     Uvicorn running on http://127.0.0.1:8123'] }); },
      fetchImpl: async () => healthy(),
    });
    expect(seen[0]).toEqual(['/fake/mlx-decision', 'server', '-m', 'baselabs/elephant-1', '--default-model', 'elephant-1', '--host', '127.0.0.1', '--port', '8123']);
    expect(server.baseUrl).toBe('http://127.0.0.1:8123/v1/systemone');
    expect(server.model).toBe('elephant-1');
  });

  it('reports a child that died, with its own last line, instead of waiting out the timeout', async () => {
    await expect(startLocalModel({
      bin: '/fake/mlx-decision', timeoutMs: 2000, ...await plain(),
      spawn: () => fakeChild({ print: ['Traceback: no such model'], exit: 3 }), fetchImpl: async () => ({ ok: false }),
    })).rejects.toThrow('exited with 3: Traceback: no such model');
  });

  it('adopts the server that took the port, rather than starting a second on another one', async () => {
    // The port is the exclusion: a sibling perch, or any mlx-decision started on that port, is the one server this machine
    // gets. The loser waits for it to answer and then uses it, and never spawns again.
    const busy = { print: ['ERROR:    [Errno 48] error while attempting to bind on address'] };
    const started = [];
    const server = await startLocalModel({
      bin: '/fake/mlx-decision', timeoutMs: 2000, adoptTimeoutMs: 500, ...await plain(),
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
      bin: '/fake/mlx-decision', timeoutMs: 2000, adoptTimeoutMs: 300, ...await plain(),
      spawn: () => { spawns.push(true); return fakeChild({ ...busy, exit: 3 }); }, fetchImpl: async () => ({ ok: false }),
    })).rejects.toThrow('port 8123 is held by something that is not serving elephant-1');
    expect(spawns).toHaveLength(1);
  });
  /** A macOS home: a lockf that exists, and a LaunchAgent plist of the given name when one is asked for. */
  async function mac(agent = null) {
    const dir = await home({ lockf: '#!/bin/sh\n' });
    if (agent) {
      await mkdir(join(dir, 'Library', 'LaunchAgents'), { recursive: true });
      await writeFile(join(dir, 'Library', 'LaunchAgents', agent), '<plist/>');
    }
    return { dir, machine: { env: { HOME: dir }, platform: 'darwin', lockf: join(dir, 'lockf') } };
  }

  it('starts through the lockf lock the LaunchAgent uses on macOS, so a second process fails before it loads any weights', async () => {
    // mlx-decision loads the whole model before it binds the port, so the port alone makes the second process load the weights
    // too. The lock is taken by lockf before mlx-decision runs at all, and the lock file is the one the LaunchAgent's lockf uses.
    const { dir, machine } = await mac();
    const seen = [];
    await startLocalModel({
      bin: '/fake/mlx-decision', timeoutMs: 2000, ...machine,
      spawn: (command, args) => { seen.push([command, ...args]); return fakeChild({ print: ['Uvicorn running on http://127.0.0.1:8123'] }); },
      fetchImpl: async () => healthy(),
    });
    expect(seen[0]).toEqual([machine.lockf, '-t', '0', join(dir, 'Library', 'Caches', 'mlx-decision', 'server.lock'), '/fake/mlx-decision',
      'server', '-m', 'baselabs/elephant-1', '--default-model', 'elephant-1', '--host', '127.0.0.1', '--port', '8123']);
    expect((await stat(join(dir, 'Library', 'Caches', 'mlx-decision'))).isDirectory()).toBe(true);
  });

  it('adopts the server when lockf cannot take the lock, instead of reporting a failed start', async () => {
    // lockf -t 0 exits 75 at once when another process holds the lock: a server is already here, which is the adopt path.
    const { machine } = await mac();
    const started = [];
    const server = await startLocalModel({
      bin: '/fake/mlx-decision', timeoutMs: 2000, adoptTimeoutMs: 500, ...machine,
      spawn: () => { started.push(true); return fakeChild({ print: ['lockf: lock is held'], exit: 75 }); },
      fetchImpl: async () => healthy(),
    });
    expect(started).toHaveLength(1);
    expect(server.adopted).toBe(true);
    expect(server.baseUrl).toBe('http://127.0.0.1:8123/v1/systemone');
  });

  it('never spawns when a LaunchAgent for mlx-decision is installed, and adopts what it serves', async () => {
    // The agent owns the server and restarts it; a second one started beside it loads the model twice.
    const { machine } = await mac('com.example.mlx-decision.plist');
    const server = await startLocalModel({
      bin: '/fake/mlx-decision', timeoutMs: 2000, adoptTimeoutMs: 500, ...machine,
      spawn: () => { throw new Error('must not spawn'); }, fetchImpl: async () => healthy(),
    });
    expect(server.adopted).toBe(true);
    expect(server.stop).toBeUndefined();
  });

  it('says so, and still does not spawn, when the LaunchAgent is installed but nothing answers', async () => {
    const { machine } = await mac('com.example.mlx-decision.plist');
    await expect(startLocalModel({
      bin: '/fake/mlx-decision', timeoutMs: 2000, adoptTimeoutMs: 300, ...machine,
      spawn: () => { throw new Error('must not spawn'); }, fetchImpl: async () => ({ ok: false }),
    })).rejects.toThrow('com.example.mlx-decision.plist in ~/Library/LaunchAgents manages mlx-decision');
  });

  it('is not stopped by a LaunchAgent that is not for mlx-decision', async () => {
    const { machine } = await mac('com.example.other.plist');
    const started = [];
    await startLocalModel({
      bin: '/fake/mlx-decision', timeoutMs: 2000, ...machine,
      spawn: () => { started.push(true); return fakeChild({ print: ['Uvicorn running on http://127.0.0.1:8123'] }); },
      fetchImpl: async () => healthy(),
    });
    expect(started).toHaveLength(1);
  });
  it('says the lock is held, not that the port is, when lockf cannot take it and nothing is serving yet', async () => {
    const { machine } = await mac();
    await expect(startLocalModel({
      bin: '/fake/mlx-decision', timeoutMs: 2000, adoptTimeoutMs: 300, ...machine,
      spawn: () => fakeChild({ exit: 75 }), fetchImpl: async () => ({ ok: false }),
    })).rejects.toThrow('another mlx-decision holds the server lock');
  });

  it.runIf(process.platform === 'darwin')('stops the server itself under lockf, so the lock is released and no server is left running', async () => {
    // Real lockf, real child: lockf dies on SIGTERM without passing it on, so signalling lockf alone orphans the server with the
    // model loaded and the lock held. A fake child cannot show that, so this one starts a real process under the real lockf.
    const dir = await home({ 'fake-server': '#!/bin/sh\nexec sleep 60\n' });
    const lock = join(dir, 'Library', 'Caches', 'mlx-decision', 'server.lock');
    const tryLock = () => spawnSync(LOCKF, ['-t', '0', lock, 'true']).status;
    const server = await startLocalModel({ bin: join(dir, 'fake-server'), env: { HOME: dir }, timeoutMs: 5000, fetchImpl: async () => healthy() });
    expect(tryLock()).toBe(75);
    server.stop();
    let status = null;
    for (let tries = 0; tries < 40 && status !== 0; tries++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      status = tryLock();
    }
    expect(status).toBe(0);
  });
  it('stops the server it started, and does not stop one already gone', async () => {
    const child = fakeChild({ print: ['Uvicorn running on http://127.0.0.1:8123'] });
    const server = await startLocalModel({ bin: '/fake/mlx-decision', timeoutMs: 2000, ...await plain(),
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
    expect(await sharedServer({ model: 'elephant-1', fetchImpl: nothing, ps: async () => '', retryMs: 1 })).toBeNull();
  });

  it('probes a candidate up to three times before giving up on it, since one missed answer does not mean no server', async () => {
    const url = 'http://127.0.0.1:9000/v1/systemone';
    let calls = 0;
    const flaky = async asked => { calls += 1; if (calls === 1) return nothing(); return up('elephant-1')(asked); };
    const found = await sharedServer({ env: { PERCH_LOCAL_URL: url }, model: 'elephant-1', fetchImpl: flaky, ps: async () => '', retryMs: 1 });
    expect(found).toEqual({ baseUrl: url });
    expect(calls).toBe(2);
    calls = 0;
    const dead = async () => { calls += 1; return nothing(); };
    expect(await sharedServer({ env: { PERCH_LOCAL_URL: url }, model: 'elephant-1', fetchImpl: dead, ps: async () => '', retryMs: 1 })).toBeNull();
    expect(calls).toBe(3);
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
