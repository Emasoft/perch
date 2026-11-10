/**
 * The local model perch falls back to when the endpoint refuses a run: Base Labs' elephant-1, served by mlx-decision on this
 * machine. The server speaks the System One format perch already uses, so nothing is translated here — this module only finds a
 * server already running, starts one when there is none, waits until the model is loaded, and stops only what it started.
 *
 * One server per machine, because the model it holds is several gigabytes. A machine that already serves elephant-1 is reused
 * rather than handed a second copy, which is what a fallback would otherwise do once per process, and once per test worker.
 *
 * It is a fallback and never a default. A run that ends here read less of each method than one that did not, because the model
 * holds 16k tokens where the Decisions API holds 250k, so the report says which model answered instead of leaving the two runs
 * looking the same.
 */
import { execFile, spawn as spawnChild } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The model, as the server names it in its answers, and as mlx-decision names it on the Hub. */
export const LOCAL_MODEL = 'elephant-1';
export const LOCAL_MODEL_REPO = 'baselabs/elephant-1';

/** The request format is System One, which perch already speaks; this is the route the server serves it on. */
export const LOCAL_ROUTE = '/v1/systemone';

/** Where the server says what it is serving: the one route that answers without the key a server may have been started with. */
export const HEALTH_ROUTE = '/health';

/** How long a cold start may take. The first run downloads several gigabytes of weights, so this is minutes and not seconds. */
export const START_TIMEOUT_MS = 900_000;

/**
 * Where a server perch did not start is looked for, when no port is named: the port a shared one runs on here, then the default
 * mlx-decision serves on. PERCH_LOCAL_URL, or PERCH_LOCAL_PORT, replaces this list rather than extending it.
 */
export const SHARED_PORTS = [8123, 8000];

/** How long the process already holding the port has to answer before perch reports it. It is loaded already, or it is not ours. */
export const ADOPT_TIMEOUT_MS = 60_000;

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

/** The endpoint a server on this port answers System One requests on, which is what the client is given. */
const endpointAt = port => `http://127.0.0.1:${port}${LOCAL_ROUTE}`;

/** The health of a server, from whatever url the client posts to. Absolute, so a named endpoint's own path is not appended to. */
const healthAt = baseUrl => new URL(HEALTH_ROUTE, baseUrl).href;

/**
 * Whether a url names this machine.
 *
 * Adopting a server means posting repository code to whatever answers there. Only a loopback address is a server on the machine
 * the user is sitting at; anywhere else would be their code sent off it with no key and no decision made about it.
 */
export function isLoopback(baseUrl) {
  try { return ['127.0.0.1', '[::1]', '::1', 'localhost'].includes(new URL(baseUrl).hostname); } catch { return false; }
}

/**
 * The ports a running mlx-decision named on its own command line, which is how a server on an unexpected port is found. A
 * command line with no `--port` is not a miss: mlx-decision then serves on its own default, which SHARED_PORTS already covers.
 */
async function portsFromProcesses(ps) {
  const table = await ps().catch(() => '');
  const ports = [];
  for (const line of String(table).split('\n')) {
    if (!/mlx[-_]decision/.test(line)) continue;
    const named = /--port[= ](\d+)/.exec(line);
    if (named) ports.push(Number(named[1]));
  }
  return ports;
}

/** The whole process table, as `ps` prints it; the one call in this module that is not a request. */
const defaultPs = () => new Promise((resolve, reject) => {
  execFile('ps', ['-eo', 'pid=,command='], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

/**
 * Whether the server at a url reports the model asked for.
 *
 * Read from `/health` rather than `/v1/models`, because a server started with `--api-key` refuses the latter and a server perch
 * did not start may well have been. The answer has to name the model: answering at all is not enough when a different model,
 * or something else entirely, is what answers.
 */
export async function serving(baseUrl, model, fetchImpl = globalThis.fetch, probeMs = 3000) {
  try {
    const response = await fetchImpl(healthAt(baseUrl), { signal: AbortSignal.timeout(probeMs) });
    if (!response.ok) return false;
    const health = await response.json();
    return health?.model === model || (Array.isArray(health?.loaded) && health.loaded.includes(model));
  } catch { return false; }
}

/**
 * A server already serving the model, so that a fallback reuses the one this machine has instead of loading a second copy.
 *
 * PERCH_LOCAL_URL names one outright and is then the only place looked at. Otherwise the ports found on a running mlx-decision's
 * command line, then PERCH_LOCAL_PORT, then SHARED_PORTS. Returns null when nothing answers.
 */
export async function sharedServer({ env = {}, model = LOCAL_MODEL, fetchImpl = globalThis.fetch, ps = defaultPs, probeMs = 3000 } = {}) {
  const candidates = env.PERCH_LOCAL_URL
    ? [env.PERCH_LOCAL_URL]
    : [...new Set([...(await portsFromProcesses(ps)), ...(env.PERCH_LOCAL_PORT ? [Number(env.PERCH_LOCAL_PORT)] : []), ...SHARED_PORTS])].map(endpointAt);
  for (const baseUrl of candidates) if (await serving(baseUrl, model, fetchImpl, probeMs)) return { baseUrl };
  return null;
}

/**
 * The port perch starts a server on: PERCH_LOCAL_PORT, else the first of SHARED_PORTS.
 *
 * A fixed port rather than a free one, because the port is the exclusion. Two processes choosing separate free ports each get a
 * server and the machine holds the model twice; two choosing the same port get one, and the loser adopts it. The first shared
 * port, not the last: it is the one a shared server on this machine is most likely already holding, so the bind fails into the
 * adopt path rather than silently succeeding on a free port beside a running one.
 */
function startPort(env) {
  const named = env.PERCH_LOCAL_PORT;
  if (named === undefined || named === '') return SHARED_PORTS[0];
  const port = Number(named);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(`PERCH_LOCAL_PORT must be a port number, not ${named}`);
  return port;
}

/**
 * Poll until something is true, and say why not when it never is.
 *
 * A child that dies is reported with its own last line rather than as a timeout, which is the difference between "port taken"
 * and "no model". `describe` builds that sentence, since only the caller knows which process is being waited on.
 */
function waitUntil({ ready, timeoutMs, child, describe }) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    let settled = false;
    const settle = outcome => { if (!settled) { settled = true; clearInterval(timer); resolve(outcome); } };
    const exit = code => settle({ ok: false, died: true, why: describe(code) });
    child?.once('exit', exit);
    const timer = setInterval(async () => {
      if (!(await ready())) { if (Date.now() > deadline) settle({ ok: false, why: describe(null) }); return; }
      settle({ ok: true });
    }, 250);
    timer.unref?.();
  });
}

/**
 * Start the server on a fixed port and wait for it to answer on `/health`.
 *
 * The model loads at startup, and the first run on a machine downloads several gigabytes of weights first, so this waits as long
 * as START_TIMEOUT_MS and says what the server last printed if it runs out.
 *
 * A port already in use is not a reason to try another one: the process holding it is the server this machine gets, and starting
 * a second would load the model twice. So it is adopted once it answers, waiting ADOPT_TIMEOUT_MS for a sibling perch that is
 * still loading, and reported if it never does.
 */
export async function startLocalModel({ bin, env = {}, model = LOCAL_MODEL, repo = LOCAL_MODEL_REPO, log = () => {}, spawn = spawnChild,
  fetchImpl = globalThis.fetch, timeoutMs = START_TIMEOUT_MS, adoptTimeoutMs = ADOPT_TIMEOUT_MS }) {
  const port = startPort(env);
  const child = spawn(bin, ['server', '-m', repo, '--default-model', model, '--host', '127.0.0.1', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  // Enough of the tail to say why a start failed; a run of download progress is not worth holding.
  let tail = '';
  const hold = chunk => { tail = (tail + chunk).slice(-4000); };
  child.stdout?.on('data', hold);
  child.stderr?.on('data', hold);
  const last = () => (tail ? `: ${tail.trim().split('\n').at(-1)}` : '');
  const baseUrl = endpointAt(port);
  const ready = () => serving(baseUrl, model, fetchImpl, 2000);
  const describe = code => (code === null
    ? `${bin} did not answer on /health within ${Math.round(timeoutMs / 1000)} seconds${last()}`
    : `${bin} exited with ${code}${last()}`);
  const started = await waitUntil({ ready, timeoutMs, child, describe });
  if (started.ok) {
    log(`mlx-decision is serving ${model} at ${baseUrl}`);
    return { baseUrl, model, pid: child.pid, stop: () => stopChild(child) };
  }
  // Whatever holds the port is the one server this machine gets, so it is adopted rather than raced. A process that is not
  // mlx-decision, or is mlx-decision serving another model, is neither adopted nor replaced: starting beside it is the one thing
  // this module exists to prevent.
  const taken = started.died && /address already in use|errno 48/i.test(tail);
  if (!taken) throw new Error(`could not start ${model} locally; ${started.why}`);
  stopChild(child);
  const adopted = await waitUntil({ ready, timeoutMs: adoptTimeoutMs, describe: () => `nothing serving ${model} on port ${port} after ${Math.round(adoptTimeoutMs / 1000)} seconds` });
  if (adopted.ok) {
    log(`port ${port} is already held by a server for ${model}; using it`);
    return { baseUrl, model, adopted: true };
  }
  throw new Error(`port ${port} is held by something that is not serving ${model}; start mlx-decision, set PERCH_LOCAL_PORT to a free port, or set PERCH_LOCAL_MODEL=off`);
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
 *
 * Only a server perch started is ever passed here. One it adopted belongs to the machine, and stopping it would take the shared
 * model away from whatever else is using it.
 */
export function trackForExit(server) {
  if (!server?.stop || server.adopted) return;
  live.add(server);
  if (installed) return;
  installed = true;
  process.once('exit', () => { for (const each of live) each.stop(); live.clear(); });
}
