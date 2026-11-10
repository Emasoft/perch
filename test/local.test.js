import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installArgs, LOCAL_MODEL, localModelName, mlxDecisionPath, startLocalModel } from '../src/local.js';

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
  it('waits for the port the operating system gives, and does not pass one of its own', async () => {
    // mlx-decision builds the Host headers it answers from the port it was told to use, so --port 0 serves on a port while
    // refusing every request that names it. The port has to be chosen here, which is why this asserts the flags.
    const seen = [];
    const server = await startLocalModel({
      bin: '/fake/mlx-decision', freePortImpl: async () => 4123, timeoutMs: 2000,
      spawn: (command, args) => { seen.push([command, ...args]); return fakeChild({ print: ['INFO:     Uvicorn running on http://127.0.0.1:4123'] }); },
      fetchImpl: async () => ({ ok: true }),
    });
    expect(seen[0]).toEqual(['/fake/mlx-decision', 'server', '-m', 'baselabs/elephant-1', '--default-model', 'elephant-1', '--host', '127.0.0.1', '--port', '4123']);
    expect(server.baseUrl).toBe('http://127.0.0.1:4123/v1/systemone');
    expect(server.model).toBe('elephant-1');
  });

  it('reports a child that died, with its own last line, instead of waiting out the timeout', async () => {
    await expect(startLocalModel({
      bin: '/fake/mlx-decision', freePortImpl: async () => 4123, timeoutMs: 10_000,
      spawn: () => fakeChild({ print: ['Traceback: no such model'], exit: 3 }), fetchImpl: async () => ({ ok: false }),
    })).rejects.toThrow('exited with 3: Traceback: no such model');
  });

  it('tries another port when the one it took was taken first, and gives up after a few', async () => {
    let ports = 0;
    const busy = { print: ['ERROR:    [Errno 48] error while attempting to bind on address'] };
    await expect(startLocalModel({
      bin: '/fake/mlx-decision', freePortImpl: async () => ++ports, timeoutMs: 10_000, attempts: 2,
      spawn: () => fakeChild({ ...busy, exit: 3 }), fetchImpl: async () => ({ ok: false }),
    })).rejects.toThrow('could not start elephant-1 locally');
    expect(ports).toBe(2);
  });

  it('stops the server it started, and does not stop one already gone', async () => {
    const child = fakeChild({ print: ['Uvicorn running on http://127.0.0.1:4123'] });
    const server = await startLocalModel({ bin: '/fake/mlx-decision', freePortImpl: async () => 4123, timeoutMs: 2000,
      spawn: () => child, fetchImpl: async () => ({ ok: true }) });
    server.stop();
    expect(child.killed).toEqual(['SIGTERM']);
    server.stop();
    expect(child.killed).toEqual(['SIGTERM']);
  });
});
