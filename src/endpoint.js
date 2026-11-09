/** Where questions go, and with which credential: PERCH_BASE_URL and the key named in this file's environment. */
import { createSystemOne, speaksDecisions } from './systemone.js';
import { contextLimits } from './tokens.js';

/** The variable holding the key for PERCH_BASE_URL: PERCH_API_KEY, else OPENAI_API_KEY for the Decisions API and TYPESAFE_API_KEY for any other. */
export const endpointKey = env => (env.PERCH_API_KEY ? 'PERCH_API_KEY' : speaksDecisions(env.PERCH_BASE_URL) ? 'OPENAI_API_KEY' : 'TYPESAFE_API_KEY');

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
 * The client scan, coverage and check ask their questions over. The endpoint is PERCH_BASE_URL and its key is the variable for it
 * that endpointKey names, so a scan that says which endpoint it read can be repeated by naming the same two.
 *
 * Both are checked here, before anything is read, because the alternative is a scan that parses a repository and then has nowhere
 * to send the result.
 */
export async function configuredSystemOne({ env, log, fetchImpl = globalThis.fetch }) {
  if (!env.PERCH_BASE_URL) throw new Error('Perch has no endpoint. Set PERCH_BASE_URL to the URL its questions go to — [OI]\'s Decisions API is https://api.openai.com/v1/decisions — and PERCH_API_KEY to that endpoint\'s key.');
  const key = endpointKey(env);
  if (!env[key]) throw new Error(`${key} is not set. It holds the key for ${env.PERCH_BASE_URL}.`);
  const limits = limitsFrom(env);
  return createSystemOne({ apiKey: env[key], baseUrl: env.PERCH_BASE_URL, model: env.PERCH_MODEL_ID, log, fetchImpl,
    limits, firstQuestions: limits.questions ?? FIRST_QUESTIONS });
}