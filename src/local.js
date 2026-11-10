/**
 * The local model perch falls back to when the endpoint refuses a run: Base Labs' elephant-1, served by mlx-decision on this
 * machine. The server speaks the System One format perch already uses, so nothing is translated here — this module only finds
 * the binary, starts it, waits until the model is loaded, and stops it again.
 *
 * It is a fallback and never a default. A run that ends here read less of each method than one that did not, because the model
 * holds 16k tokens where the Decisions API holds 250k, so the report says which model answered instead of leaving the two runs
 * looking the same.
 */
import { spawn as spawnChild } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

/** The model, as the server names it in its answers, and as mlx-decision names it on the Hub. */
export const LOCAL_MODEL = 'elephant-1';
export const LOCAL_MODEL_REPO = 'baselabs/elephant-1';

/** The request format is System One, which perch already speaks; this is the route the server serves it on. */
export const LOCAL_ROUTE = '/v1/systemone';

/** How long a cold start may take. The first run downloads several gigabytes of weights, so this is minutes and not seconds. */
export const START_TIMEOUT_MS = 900_000;

/**
 * The model to fall back to, or null when the fallback is off. `off` is the one spelling that turns it off — perch has no other
 * boolean-valued setting, and a second spelling is a second thing to document and to get wrong. Unset means elephant-1.
 */
export function localModelName(env = {}) {
  const asked = env.PERCH_LOCAL_MODEL;
  if (asked === 'off') return null;
  return { name: asked || LOCAL_MODEL, repo: LOCAL_MODEL_REPO };
}

/** Where mlx-decision is: MLX_DECISION_BIN, else the PATH entry, else the place `uv tool install` puts it. */
export async function mlxDecisionPath(env = {}, which) {
  const named = env.MLX_DECISION_BIN;
  if (named) return (await found(named)) ? named : null;
  const onPath = await (which ?? defaultWhich)(env);
  if (onPath) return onPath;
  const fallback = join(env.HOME || homedir(), '.local', 'bin', 'mlx-decision');
  return (await found(fallback)) ? fallback : null;
}

const found = async file => access(file, constants.X_OK).then(() => true).catch(() => false);

/** A PATH lookup, without a shell: `command -v` is not something a node process can ask for portably. */
async function defaultWhich(env) {
  for (const dir of String(env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, 'mlx-decision');
    if (await found(candidate)) return candidate;
  }
  return null;
}

/**
 * How to install it, as the argv of a command that does. `uv tool install` is preferred because uv manages the tool's own
 * environment; pipx is the same idea under another name. Both put the binary on the PATH in the place mlxDecisionPath checks.
 */
export function installArgs(available) {
  if (available.uv) return ['uv', 'tool', 'install', 'mlx-decision'];
  if (available.pipx) return ['pipx', 'install', 'mlx-decision'];
  return null;
}

/**
 * A port nothing is listening on, chosen by binding and closing one.
 *
 * mlx-decision cannot choose the port itself: it builds the set of `Host` headers it answers from the port it was told to serve
 * on, so `--port 0` serves on whatever the operating system picked while still refusing every request that names it. The port
 * therefore has to be decided here, and binding-then-closing is the one portable way to ask for a free one. Another process can
 * take it in the gap, which is why a start that fails to bind is retried on a fresh port rather than reported.
 */
async function freePort(createServerImpl) {
  const server = createServerImpl();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

/**
 * Start the server and wait for it to answer on `/health`.
 *
 * The model loads at startup, and the first run on a machine downloads several gigabytes of weights first, so this waits as long
 * as START_TIMEOUT_MS and says what the server last printed if it runs out. A child that dies is reported with its own last line
 * rather than a timeout, which is the difference between "port taken" and "no model".
 */
export async function startLocalModel({ bin, model = LOCAL_MODEL, repo = LOCAL_MODEL_REPO, log = () => {}, spawn = spawnChild, fetchImpl = globalThis.fetch, timeoutMs = START_TIMEOUT_MS, freePortImpl = () => freePort(createServer), attempts = 5 }) {
  for (let attempt = 0; ; attempt++) {
    const port = await freePortImpl();
    const child = spawn(bin, ['server', '-m', repo, '--default-model', model, '--host', '127.0.0.1', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    // Enough of the tail to say why a start failed; a run of download progress is not worth holding.
    let tail = '';
    const hold = chunk => { tail = (tail + chunk).slice(-4000); };
    child.stdout?.on('data', hold);
    child.stderr?.on('data', hold);
    const last = () => (tail ? `: ${tail.trim().split('\n').at(-1)}` : '');
    const baseUrl = `http://127.0.0.1:${port}${LOCAL_ROUTE}`;
    const healthy = () => fetchImpl(`http://127.0.0.1:${port}/health`).then(response => response.ok, () => false);
    const started = await new Promise(resolve => {
      const deadline = Date.now() + timeoutMs;
      let settled = false;
      const settle = outcome => { if (!settled) { settled = true; clearInterval(poll); resolve(outcome); } };
      child.once('exit', code => settle({ ok: false, died: true, why: `${bin} exited with ${code}${last()}` }));
      const poll = setInterval(async () => {
        if (!(await healthy())) { if (Date.now() > deadline) settle({ ok: false, why: `${bin} did not answer on /health within ${Math.round(timeoutMs / 1000)} seconds${last()}` }); return; }
        settle({ ok: true });
      }, 250);
    });
    if (started.ok) {
      log(`mlx-decision is serving ${model} at ${baseUrl}`);
      return { baseUrl, model, pid: child.pid, stop: () => stopChild(child) };
    }
    // A port that was taken after it was closed is the one failure worth another try; anything else is what the user has to see.
    const taken = started.died && /address already in use|errno 48/i.test(tail);
    if (!taken || attempt >= attempts - 1) throw new Error(`could not start ${model} locally; ${started.why}`);
    log(`${started.why}; trying another port`);
  }
}
/**
 * Stop the server, politely first: the model is loaded into memory and mlx-decision exits cleanly on SIGTERM. SIGKILL follows if
 * it does not, so a wedged server cannot outlive the run that started it.
 */
const live = new Set();
let installed = false;
function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
  kill.unref?.();
  child.once('exit', () => clearTimeout(kill));
}

/**
 * Stop every server this process started when the process ends. Registered once for the process rather than once per client: a
 * process that builds two clients would otherwise leave a listener behind for each, and `process` warns past ten.
 */
export function trackForExit(server) {
  live.add(server);
  if (installed) return;
  installed = true;
  process.once('exit', () => { for (const each of live) each.stop(); live.clear(); });
}

