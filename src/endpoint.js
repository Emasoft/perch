/**
 * Where questions go, and with which credential. The endpoint is PERCH_BASE_URL, and [OI]'s Decisions API when that is not set;
 * the credential is the key its own variable holds, or the ChatGPT subscription `codex login` signed this machine into.
 */
import { createSystemOne, speaksDecisions } from './systemone.js';
import { codexCredential } from './codex-auth.js';
import { contextLimits } from './tokens.js';

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
 * The client scan, coverage and check ask their questions over. The endpoint is PERCH_BASE_URL, or the Decisions API when it is
 * not set, and the credential is the one endpointCredential finds, so a scan that names its endpoint can be repeated by naming
 * the same one.
 *
 * The credential is checked here, before anything is read, because the alternative is a scan that parses a repository and then
 * has nowhere to send the result.
 */
export async function configuredSystemOne({ env, log, fetchImpl = globalThis.fetch }) {
  const baseUrl = baseUrlFrom(env);
  const credential = await endpointCredential(env, baseUrl);
  if (!credential) throw new Error(`Perch has no key for ${baseUrl}. Set ${endpointKey(env, baseUrl)} to that endpoint's key, or run codex login to spend a ChatGPT subscription on the Decisions API.`);
  const limits = limitsFrom(env);
  return createSystemOne({ apiKey: credential.key, accountId: credential.accountId, baseUrl, model: env.PERCH_MODEL_ID, log, fetchImpl,
    limits, firstQuestions: limits.questions ?? FIRST_QUESTIONS });
}
