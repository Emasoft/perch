/**
 * Whether perch can run here at all.
 *
 * This is the half of `perch doctor` that has to work when nothing else does. A report about the last run is no use to someone
 * whose key is missing or whose git is not on the path: they have no last run, and the thing they need to be told is the one
 * sentence saying why. So every check is a question with a yes or no, what it found, and what to do when the answer is no.
 *
 * Nothing here calls the model or reads your code. It is the environment, the tools and the files perch needs, and it is safe to
 * run on a machine where everything is broken.
 */
import { access, constants, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseQuestions } from './ask.js';
import { baseUrlFrom, endpointCredential, endpointKey } from './endpoint.js';
import { isLoopback, localModelName, mlxDecisionPath, sharedServer } from './local.js';
import { speaksDecisions } from './systemone.js';
import { git } from './git.js';
import { RULES_FILE } from './units.js';

/** Node has to be new enough for what the parser and the client use. package.json says so; this is the same number. */
export const NEEDS_NODE = 22;

const ok = (name, found) => ({ name, ok: true, found });
const bad = (name, found, fix) => ({ name, ok: false, found, fix });

/**
 * Every check, in the order they stop mattering. An endpoint you have not configured makes the rest moot, so it comes first; a rule file that
 * does not parse only matters once perch can run at all.
 */
export async function runChecks({ root, out, env, versions, fetchImpl, ps }) {
  const checks = [];

  const major = Number(String(versions.node).replace(/^v/, '').split('.')[0]);
  checks.push(major >= NEEDS_NODE
    ? ok('node', versions.node)
    : bad('node', versions.node, `perch needs node ${NEEDS_NODE} or newer`));

  // Which credential scans will use, and never its value. A machine signed in to Codex has one without a key of its own.
  const baseUrl = baseUrlFrom(env);
  let credential = null, credentialError = null;
  try { credential = await endpointCredential(env); } catch (error) { credentialError = error; }
  checks.push(credentialError ? bad('key', credentialError.message, 'run codex login again, or set PERCH_API_KEY')
    : credential?.from === 'the Codex sign-in' ? ok('key', `the Codex sign-in, for ${baseUrl}`)
      : credential ? ok('key', `${credential.from}, ${credential.key.length} characters, for ${baseUrl}`)
        : bad('key', `no key for ${baseUrl}`, `set ${endpointKey(env)} to that endpoint's key, or run codex login`));

  // Where a run goes after the endpoint refuses one. Always ok: perch runs without a fallback, and a machine where the local
  // model was never installed can still read a repository. What it is not is silent, since a spent subscription window is the
  // ordinary way to arrive here.
  checks.push(await fallbackCheck({ env, baseUrl, platform: versions.platform, fetchImpl, ps }));

  const version = await git(['--version'], root).then(text => text.trim()).catch(error => error);
  checks.push(typeof version === 'string'
    ? ok('git', version)
    : bad('git', version.message.split('\n')[0], 'perch reads code out of git, so git has to be on the path'));

  const inside = await git(['rev-parse', '--show-toplevel'], root).then(text => text.trim()).catch(() => null);
  checks.push(inside
    ? ok('repository', relativeTo(root, inside))
    : bad('repository', `${root} is not in a git repository`, 'perch reads a commit, so it needs one; git init and commit something'));

  const head = inside ? await git(['rev-parse', '--short', 'HEAD'], root).then(text => text.trim()).catch(error => error) : null;
  if (inside) checks.push(typeof head === 'string'
    ? ok('commit', head)
    : bad('commit', 'the repository has no commits', 'perch reads a commit, so commit something first'));

  const writable = await access(out, constants.W_OK).then(() => true).catch(() => null)
    ?? await access(join(out, '..'), constants.W_OK).then(() => true).catch(() => false);
  checks.push(writable
    ? ok('results', out)
    : bad('results', `${out} cannot be written`, 'point --out somewhere writable'));

  // A rule file perch cannot read stops every command, so it is worth saying which line before you find out mid-scan.
  const rules = await readFile(join(root, RULES_FILE), 'utf8').catch(() => null);
  if (rules === null) checks.push(ok('rules', `no ${RULES_FILE}, so perch asks only its own questions`));
  else {
    try {
      const parsed = parseQuestions(rules, RULES_FILE, 'rule');
      checks.push(ok('rules', `${parsed.length} in ${RULES_FILE}`));
    } catch (error) {
      checks.push(bad('rules', error.message, `fix ${RULES_FILE}; every command reads it`));
    }
  }
  return checks;
}

const relativeTo = (root, inside) => (root === inside ? inside : `${inside} (you are in ${root})`);

/**
 * Where a run goes once the endpoint has refused one: the same model this machine serves, when the default endpoint is the one
 * that refused and there is somewhere to serve it from.
 *
 * It is only ever reported, never run, so doctor stays a check rather than a several-gigabyte download. Not installed is a ✗
 * with the command that installs it, because the fallback is on by default and a machine that cannot complete one should say so
 * before a spent subscription window is the way anyone finds out.
 */
async function fallbackCheck({ env, baseUrl, platform, fetchImpl, ps }) {
  const asked = localModelName(env);
  if (!asked) return ok('fallback', 'off, so a run the endpoint refuses stops there');
  if (!speaksDecisions(baseUrl)) return ok('fallback', `not for ${baseUrl}; the Decisions API is the endpoint that falls back`);
  if (platform !== 'darwin arm64') return ok('fallback', `none: mlx-decision runs on Apple silicon, and this is ${platform}`);
  // What a run connects to: a server already answering, when there is one, rather than a binary that would start a second. The
  // probe is the same one a run makes, so doctor cannot say one thing and a scan do another.
  if (env.PERCH_LOCAL_URL && !isLoopback(env.PERCH_LOCAL_URL)) return bad('fallback', `PERCH_LOCAL_URL names another machine`, 'set PERCH_LOCAL_URL to this machine, or unset it');
  const running = await sharedServer({ env, model: asked.name, fetchImpl, ps });
  if (running) return ok('fallback', `${asked.name} already serving at ${running.baseUrl}`);
  const bin = await mlxDecisionPath(env);
  return bin
    ? ok('fallback', `${asked.name} from ${bin}, starting one only if nothing is already serving`)
    : bad('fallback', `${asked.name} is not installed`, 'uv tool install mlx-decision, or set PERCH_LOCAL_MODEL=off to do without it');
}

