/**
 * Where questions go, and with which credential. The endpoint is PERCH_BASE_URL, and [OI]'s Decisions API when that is not set;
 * the credential is the key its own variable holds, or the ChatGPT subscription `codex login` signed this machine into.
 */
import { createSystemOne, speaksDecisions } from './systemone.js';
import { codexCredential } from './codex-auth.js';
import { contextLimits } from './tokens.js';
import { installArgs, localModelName, mlxDecisionPath, startLocalModel, trackForExit } from './local.js';

/** [OI]'s Decisions API: where a scan goes when nothing says otherwise, and gpt-6-luna is the model perch was measured on. */
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1/decisions';

/** The endpoint a command sends its questions to. Naming another one is opting out of the default, not configuring it. */
export const baseUrlFrom = env => env.PERCH_BASE_URL || DEFAULT_BASE_URL;

/** The variable holding the key for PERCH_BASE_URL: PERCH_API_KEY, else OPENAI_API_KEY for the Decisions API and TYPESAFE_API_KEY for any other. */
export const endpointKey = (env, baseUrl = baseUrlFrom(env)) => (env.PERCH_API_KEY ? 'PERCH_API_KEY' : speaksDecisions(baseUrl) ? 'OPENAI_API_KEY' : 'TYPESAFE_API_KEY');

/**
 * What a scan sends with: the key in the variable its endpoint names, or, for the Decisions API, the sign-in Codex wrote.
 *
 * A ChatGPT subscription is an [OI] credential like any other, and the Decisions API takes it as a bearer token carrying the
 * account it spends, so a machine signed in to Codex is signed in to perch and needs no API key. Any other endpoint is not
 * [OI]'s, and a token it never issued is not offered to it.
 */
export async function endpointCredential(env, baseUrl = baseUrlFrom(env)) {
  const name = endpointKey(env, baseUrl);
  if (env[name]) return { key: env[name], from: name };
  if (!speaksDecisions(baseUrl)) return null;
  const codex = await codexCredential(env);
  return codex ? { key: codex.token, from: 'the Codex sign-in', accountId: codex.accountId } : null;
}

/**
 * What a model takes in one request, when it does not say. PERCH_MAX_QUESTIONS and PERCH_MAX_OPTIONS set the limits for an
 * endpoint that reports nothing in `_meta`; one that does report can only lower them. PERCH_CONTEXT_LENGTH sets the tokens one
 * request may hold over the model's own (tokens.js), and the smaller budgets follow from it (contextLimits). A value that is not
 * a whole number above zero is an error rather than no limit, since a scan sent in batches the model refuses reads nothing.
 */
export function limitsFrom(env) {
  const limits = {};
  for (const [name, key, least] of [['PERCH_MAX_QUESTIONS', 'questions', 1], ['PERCH_MAX_OPTIONS', 'options', 2], ['PERCH_CONTEXT_LENGTH', 'request', 256]]) {
    if (env[name] === undefined || env[name] === '') continue;
    const value = Number(env[name]);
    if (!Number.isSafeInteger(value) || value < least) throw new Error(`${name} must be a whole number of at least ${least}, not ${env[name]}`);
    if (key === 'request') Object.assign(limits, contextLimits(value)); else limits[key] = value;
  }
  return limits;
}

/** The first request to an endpoint that has not said what it takes. Small enough for any model we know of; its answer says the rest. */
export const FIRST_QUESTIONS = 8;

/**
 * Failures a local model can answer in place of the endpoint, and failures it cannot.
 *
 * A spent subscription window, a service that is down and a connection that never opened are all "not now": asking the same
 * endpoint again will not help, and a smaller model can still read the code. A rejected key, a refused request and a key that
 * does not belong to the account are "not like this": they are five-second fixes, and falling back would hide the one message
 * the user needs while quietly demoting every later scan to a model that reads a fraction as much.
 */
const FALLBACK_STATUSES = new Set([408, 429, 502, 503, 504]);
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET']);

export function worthFallingBack(error) {
  if (error?.name === 'ContextLimitError') return false;
  if (error?.name === 'AuthenticationError') {
    const detail = String(error.detail ?? '');
    // Out of credit is terminal and expected; a bad or revoked key is terminal and the user's to fix.
    if (error.status === 402) return true;
    if (FALLBACK_STATUSES.has(error.status)) return /\b(?:insufficient_quota|usage_limit_reached|rate_limit_exceeded)\b|usage limit reached|quota exceeded/i.test(detail);
    return false;
  }
  return NETWORK_CODES.has(error?.code) || NETWORK_CODES.has(error?.cause?.code) || /fetch failed|socket hang up/i.test(String(error?.message ?? ''));
}

/** The one noul a probe asks: no state, one question, so the cheapest possible check of whether the endpoint answers at all. */
const PROBE = { probe: { type: 'noul', instructions: 'Is this a question?', criteria: { true: 'yes', false: 'no' } } };

/**
 * Whether the endpoint answers, before a run spends a repository's worth of requests finding out.
 *
 * The client it is given is built to ask once. The run's own ladder sleeps up to fourteen seconds before giving up on a 429, and
 * a probe that waited through it would turn a fallback that takes a second into something that looks like a hang.
 */
export async function probeEndpoint(client) {
  try { await client.ask({}, PROBE); return { ok: true }; }
  catch (error) { return { ok: false, error }; }
}

/** Run a command, for the install a missing binary needs. Nothing about it is inferred: the argv is the whole of what runs. */
async function run(argv, { spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const hold = chunk => { tail = (tail + chunk).slice(-2000); };
    child.stdout?.on('data', hold);
    child.stderr?.on('data', hold);
    child.once('error', reject);
    child.once('exit', code => (code === 0 ? resolve(tail) : reject(new Error(`${argv.join(' ')} exited with ${code}${tail ? `: ${tail.trim().split('\n').at(-1)}` : ''}`))));
  });
}

/**
 * The local client a run falls back to, or null when the fallback is off or this is not a machine that can serve it.
 *
 * Installing is a separate act from scanning, and it is refused when nobody is there to answer for it: a CI runner that reached
 * this branch would download a model onto a machine whose owner never asked, and the run has already failed visibly by then.
 */
export async function localClient({ env, log = () => {}, spawn, fetchImpl, tty = Boolean(process.stdin.isTTY) }) {
  const asked = localModelName(env);
  if (!asked) return null;
  // mlx-decision runs on Apple silicon. Somewhere else there is no local model to fall back to, and saying so is better than a
  // stack trace from a spawn that could never have worked.
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error(`there is no local ${asked.name} on ${process.platform}/${process.arch}; mlx-decision runs on Apple silicon`);
  let bin = await mlxDecisionPath(env);
  if (!bin) {
    const argv = installArgs({ uv: env.PERCH_UV_BIN || 'uv', pipx: env.PERCH_PIPX_BIN || 'pipx' });
    if (!argv || !tty) throw new Error(`mlx-decision is not installed. Install it with: uv tool install mlx-decision`);
    log(`mlx-decision is not installed; running ${argv.join(' ')}`);
    try { await run(argv, { spawn }); } catch (error) { throw new Error(`could not install mlx-decision: ${error.message}`, { cause: error }); }
    bin = await mlxDecisionPath(env);
    if (!bin) throw new Error(`mlx-decision was installed but is not on the PATH; set MLX_DECISION_BIN to it`);
  }
  const server = await startLocalModel({ bin, model: asked.name, repo: asked.repo, log, spawn, fetchImpl });
  trackForExit(server);
  // The server perch started keeps no key, since only this process can reach its port; the client still wants a string where the
  // authorization header goes, and it goes unread on the other side.
  return createSystemOne({ apiKey: 'local', baseUrl: server.baseUrl, model: asked.name, log, fetchImpl });
}

/**
 * The client scan, coverage and check ask their questions over. The endpoint is PERCH_BASE_URL, or the Decisions API when it is
 * not set, and the credential is the one endpointCredential finds, so a scan that names its endpoint can be repeated by naming
 * the same one.
 *
 * The credential is checked here, before anything is read, because the alternative is a scan that parses a repository and then
 * has nowhere to send the result. The endpoint is then probed, once, for the same reason: a run that is going to fall back
 * should say so before it starts printing progress, not halfway through a file.
 */
export async function configuredSystemOne({ env, log = () => {}, stdout = () => {}, fetchImpl = globalThis.fetch, spawn, probe = true, tty }) {
  const baseUrl = baseUrlFrom(env);
  const credential = await endpointCredential(env, baseUrl);
  const limits = limitsFrom(env);
  const primary = credential && createSystemOne({ apiKey: credential.key, accountId: credential.accountId, baseUrl, model: env.PERCH_MODEL_ID, log, fetchImpl,
    limits, firstQuestions: limits.questions ?? FIRST_QUESTIONS });
  // Only [OI]'s API has a local stand-in. Another endpoint is a choice the user made, and a model they did not choose is not a
  // substitute for the one they did.
  const mayFallBack = speaksDecisions(baseUrl) && localModelName(env) !== null && process.platform === 'darwin' && process.arch === 'arm64';
  // No credential is not an endpoint that refused a run, it is a setting nobody made, and the fix is one line in a shell. Reading
  // the repository with a local model instead would hide that line behind a result that looks like every other result.
  let answer = credential ? { ok: true } : { ok: false, error: new Error(`Perch has no key for ${baseUrl}. Set ${endpointKey(env, baseUrl)} to that endpoint's key, or run codex login to spend a ChatGPT subscription on the Decisions API.`) };
  // Asked once and with one question: the point is whether the endpoint is there, and every retry spent finding out is a second
  // the run spends looking hung.
  if (answer.ok && probe && mayFallBack) answer = await probeEndpoint(createSystemOne({ apiKey: credential.key, accountId: credential.accountId, baseUrl,
    model: env.PERCH_MODEL_ID, log, fetchImpl, limits, firstQuestions: 1, attempts: 1 }));
  if (answer.ok) return primary;
  if (!mayFallBack || !worthFallingBack(answer.error)) throw answer.error;
  // Said on stdout, not in the log: `perch check` passes the log its debug channel, so a switch announced there would be invisible
  // in the one command people run while fixing the thing the scan reported.
  log(`${answer.error.message}; falling back to ${localModelName(env).name}`);
  stdout(`perch: ${answer.error.message}. Reading with ${localModelName(env).name} on this machine instead.`);
  try { return await localClient({ env, log, spawn, fetchImpl, tty }); }
  // Both messages, because the endpoint's failure is why the fallback ran and the local one is why it did not work.
  catch (error) { throw new Error(`${answer.error.message}. ${error.message}`, { cause: error }); }
}
