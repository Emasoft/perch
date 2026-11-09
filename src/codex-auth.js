/**
 * The ChatGPT subscription perch can spend in place of an API key: the sign-in `codex login` wrote, which [OI]'s Decisions API
 * takes as a bearer token. The token is read from disk when a client is built and never copied into perch's own settings, so a
 * machine signed in to Codex is signed in to perch, and signing in again in one place is enough.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The claim an access token carries the subscription's account ID in, which Codex sends as chatgpt-account-id. */
const ACCOUNT_CLAIM = 'https://api.openai.com/auth';

/** $CODEX_HOME/auth.json, as Codex resolves its own credentials, and ~/.codex/auth.json when it is not set. */
export const codexAuthPath = env => join(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'), 'auth.json');

/**
 * The account ID inside an access token, or '' for anything that is not a JWT carrying that claim. The header it fills is
 * optional, so a token perch cannot read is still a token perch can send.
 */
export function accountIdFromToken(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return '';
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))?.[ACCOUNT_CLAIM]?.chatgpt_account_id ?? ''; }
  catch { return ''; }
}

/**
 * What `codex login` wrote, or null when nobody has signed in on this machine. A file that is there and cannot be read is an
 * error rather than the second answer: it is the file perch would spend, and the fix, `codex login` again, is worth naming.
 */
export async function codexCredential(env) {
  const path = codexAuthPath(env);
  let content;
  try { content = await readFile(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Could not read ${path}: ${error.message}`, { cause: error });
  }
  let auth;
  try { auth = JSON.parse(content); }
  catch (error) { throw new Error(`${path} is not the file codex login writes: ${error.message}`, { cause: error }); }
  const token = auth?.tokens?.access_token;
  if (!token) return null;
  // Codex stores the account ID beside the token, and the token carries it too. The stored one is what Codex itself sends.
  return { token, accountId: auth?.tokens?.account_id || accountIdFromToken(token) };
}