import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const runner = path.join(scriptDir, 'verify-ui-row-actions.mjs');
const versionFiles = [
  runner,
  path.join(scriptDir, 'check-ui-row-actions.py'),
  path.join(repoRoot, '.ui-acceptance.json'),
  path.join(scriptDir, 'runtime.mjs'),
  path.join(scriptDir, 'native-workspace.mjs'),
];
const cases = [
  { name: 'healthy', expected: 0 },
  { name: 'legal-color-only', expected: 0, mutate: legalColorOnly },
  { name: 'vertical-offset', expected: 1, failedCheck: 'button-vertical-center', mutate: verticalOffset },
  { name: 'icon-offset', expected: 1, failedCheck: 'icon-vertical-center', mutate: iconOffset },
  { name: 'unequal-size', expected: 1, failedCheck: 'button-target', mutate: unequalSize },
  { name: 'always-visible', expected: 1, failedCheck: 'idle-hidden', mutate: alwaysVisible },
  { name: 'missing-focus', expected: 1, failedCheck: 'keyboard-visible', mutate: missingFocus },
  { name: 'wrong-record', expected: 1, failedCheck: 'menu-record', mutate: wrongRecord },
];

const options = parseArgs(process.argv.slice(2));
const sourceExtension = path.resolve(options.extension ?? path.join(repoRoot, 'extension'));
const browserPath = options.browser ?? process.env.HISTORY_SWEEP_CHROMIUM;
if (!browserPath) fail('Provide --browser <path> or set HISTORY_SWEEP_CHROMIUM.');
const outputParent = path.resolve(options.output ?? path.join(repoRoot, 'test-results', 'ui-row-actions-regression'));
const outputRelativeToSource = path.relative(sourceExtension, outputParent);
if (outputRelativeToSource === '' || (!outputRelativeToSource.startsWith(`..${path.sep}`) && outputRelativeToSource !== '..' && !path.isAbsolute(outputRelativeToSource))) {
  fail('--output must be outside the source extension directory.');
}
await mkdir(outputParent, { recursive: true });
const invocationOutput = await mkdtemp(path.join(outputParent, 'regression-'));

const originalHashes = await hashTree(sourceExtension);
const frozenExtension = path.join(invocationOutput, 'baseline-extension');
await copyTree(sourceExtension, frozenExtension);
const frozenHashes = await hashTree(frozenExtension);
const initialFrozenSourceStable = sameMap(originalHashes, frozenHashes);
const initialVersionHashes = await hashFiles(versionFiles);
const sourceHashesPath = path.join(invocationOutput, 'source-hashes.json');
const hashLog = { original: Object.fromEntries(originalHashes), frozen: Object.fromEntries(frozenHashes), versionBefore: Object.fromEntries(initialVersionHashes) };
await writeFile(sourceHashesPath, `${JSON.stringify(hashLog, null, 2)}\n`);
let allMatched = true;
const results = [];
let incompleteReason = initialFrozenSourceStable ? null : 'frozen extension baseline did not match the original source';
if (incompleteReason) allMatched = false;
caseLoop: for (let repeat = 1; repeat <= options.repeats; repeat++) {
  for (const testCase of cases) {
    if (incompleteReason) break caseLoop;
    const workRoot = await mkdtemp(path.join(os.tmpdir(), 'history-sweep-row-actions-'));
    const extensionCopy = path.join(workRoot, 'extension');
    const caseOutput = await mkdtemp(path.join(invocationOutput, `run-${String(repeat).padStart(2, '0')}-${testCase.name}-`));
    try {
      await copyTree(frozenExtension, extensionCopy);
      if (testCase.mutate) await testCase.mutate(extensionCopy);
      const commandArgs = [runner, '--extension', extensionCopy, '--output', caseOutput];
      if (browserPath) commandArgs.push('--browser', browserPath);
      const command = [process.execPath, ...commandArgs].map(shellQuote).join(' ');
      const child = await runChild(process.execPath, commandArgs, browserPath);
      const resultPaths = await findResults(caseOutput);
      const resultPath = resultPaths.length === 1 ? resultPaths[0] : null;
      const result = resultPath ? await readResult(resultPath) : null;
      const sourceUnchanged = sameMap(originalHashes, await hashTree(sourceExtension));
      const caseFrozenStable = sameMap(frozenHashes, await hashTree(frozenExtension));
      const caseVersionHashes = await hashFiles(versionFiles);
      const caseVersionStable = sameMap(initialVersionHashes, caseVersionHashes);
      const matched = child.signal === null
        && child.exitCode === testCase.expected
        && resultPath !== null
        && isExpectedResult(result, testCase)
        && sourceUnchanged;
      allMatched &&= matched;
      const failedChecks = result?.checks?.filter(check => check.passed === false).map(({ id, label }) => ({ id, label })) ?? [];
      const summaryItem = {
        name: testCase.name,
        repeat,
        command,
        exitCode: child.exitCode,
        expectedExitCode: testCase.expected,
        resultPath,
        resultFiles: resultPaths.length,
        matched,
        checksCount: result?.checks?.length ?? 0,
        failedChecks,
        sourceUnchanged,
        frozenSourceStable: caseFrozenStable,
        versionStable: caseVersionStable,
        sourceHashCollectionsPresent: Boolean(isHashCollection(result?.sourceSnapshot?.before) && isHashCollection(result?.sourceSnapshot?.after)),
      };
      results.push(summaryItem);
      await writeFile(path.join(caseOutput, 'command.json'), `${JSON.stringify({ ...summaryItem, signal: child.signal, stdout: child.stdout, stderr: child.stderr }, null, 2)}\n`);
      console.log(`${testCase.name} repeat=${repeat}`);
      console.log(`  command: ${command}`);
      console.log(`  exit: ${child.exitCode}; expected: ${testCase.expected}; result files: ${resultPaths.length}; matched: ${matched}`);
      if (resultPath) console.log(`  result: ${resultPath}`);
      if (result) printResultSummary(result);
      if (!sourceUnchanged) incompleteReason = 'source extension changed during the batch';
      else if (!caseFrozenStable) incompleteReason = 'frozen extension baseline changed during the batch';
      else if (!caseVersionStable) incompleteReason = 'runner or contract files changed during the batch';
      if (incompleteReason) {
        allMatched = false;
        console.error(`Stopping remaining cases: ${incompleteReason}.`);
        break caseLoop;
      }
    } catch (error) {
      allMatched = false;
      console.error(`${testCase.name} repeat=${repeat}: ERROR: ${error.message}`);
      results.push({ name: testCase.name, repeat, command: null, exitCode: null, expectedExitCode: testCase.expected, resultPath: null, resultFiles: 0, matched: false, checksCount: 0, failedChecks: [], sourceUnchanged: false, frozenSourceStable: false, versionStable: false, sourceHashCollectionsPresent: false, error: error.message });
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  }
}

const finalHashes = await hashTree(sourceExtension);
const sourceUnchanged = sameMap(originalHashes, finalHashes);
const finalFrozenHashes = await hashTree(frozenExtension);
const frozenSourceStable = initialFrozenSourceStable && sameMap(frozenHashes, finalFrozenHashes);
const finalVersionHashes = await hashFiles(versionFiles);
const versionStable = sameMap(initialVersionHashes, finalVersionHashes);
hashLog.originalAfter = Object.fromEntries(finalHashes);
hashLog.frozenAfter = Object.fromEntries(finalFrozenHashes);
hashLog.versionAfter = Object.fromEntries(finalVersionHashes);
await writeFile(sourceHashesPath, `${JSON.stringify(hashLog, null, 2)}\n`);
if (!sourceUnchanged) {
  console.error('Source extension changed during regression run.');
  allMatched = false;
  incompleteReason ??= 'source extension changed during the batch';
  for (const result of results) result.matched = false;
} else {
  console.log('Source extension SHA-256 snapshot unchanged.');
}
if (!frozenSourceStable) {
  allMatched = false;
  incompleteReason ??= 'frozen extension baseline changed during the batch';
}
if (!versionStable) {
  allMatched = false;
  incompleteReason ??= 'runner or contract files changed during the batch';
}
const summaryPath = path.join(invocationOutput, 'summary.json');
await writeFile(summaryPath, `${JSON.stringify({ sourceRoot: sourceExtension, repeats: options.repeats, total: results.length, matched: results.filter(result => result.matched).length, sourceUnchanged, versionStable, frozenSourceStable, incompleteReason, results }, null, 2)}\n`);
console.log(`Summary: ${summaryPath}`);
process.exitCode = allMatched ? 0 : 1;

function parseArgs(args) {
  const result = { repeats: 1 };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    // --extension selects the source tree to freeze and audit; it defaults to this repository's extension directory.
    if (flag === '--browser' || flag === '--output' || flag === '--repeats' || flag === '--extension') {
      const value = args[++index];
      if (!value || value.startsWith('--')) fail(`${flag} requires a value.`);
      if (flag === '--repeats') {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 5) fail('--repeats must be an integer from 1 to 5.');
        result.repeats = Number(value);
      } else result[flag.slice(2)] = value;
    } else fail(`Unknown option: ${flag}`);
  }
  return result;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

async function copyTree(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await writeFile(to, await readFile(from));
  }
}

async function hashTree(root) {
  const hashes = new Map();
  for (const file of await listFiles(root)) {
    hashes.set(path.relative(root, file), createHash('sha256').update(await readFile(file)).digest('hex'));
  }
  return hashes;
}

async function hashFiles(files) {
  const hashes = new Map();
  for (const file of files) hashes.set(file, createHash('sha256').update(await readFile(file)).digest('hex'));
  return hashes;
}

async function listFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files.sort();
}

function sameMap(left, right) {
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

async function legalColorOnly(extension) {
  const css = path.join(extension, 'workspace.css');
  await writeFile(css, `${await readFile(css, 'utf8')}\n.wt-row-more { color: rgb(23,122,103); }\n`);
}

async function verticalOffset(extension) {
  await appendCss(extension, '.wt-row-more { position: relative; top: 5.84375px !important; }');
}

async function iconOffset(extension) {
  await appendCss(extension, '.wt-row-more .ui-icon { transform: translateY(3px) !important; }');
}

async function unequalSize(extension) {
  await appendCss(extension, '.wt-row-more { width: 22px !important; }');
}

async function alwaysVisible(extension) {
  await appendCss(extension, '.history-row .wt-row-more, .history-row .row-delete { opacity: 1 !important; pointer-events: auto !important; }');
}

async function missingFocus(extension) {
  await appendCss(extension, '@media (hover: hover) and (pointer: fine) { .history-row:focus-within:not(:hover) .wt-row-more, .history-row:focus-within:not(:hover) .row-delete { opacity: 0 !important; pointer-events: none !important; } }');
}

async function wrongRecord(extension) {
  const file = path.join(extension, 'workspace-page.mjs');
  const source = await readFile(file, 'utf8');
  const target = "node('p', { className: 'wt-url', textContent: item.url }, root);";
  const occurrences = source.split(target).length - 1;
  if (occurrences !== 1) throw new Error(`Expected one exact wrong-record mutation target; found ${occurrences}.`);
  await writeFile(file, source.replace(target, "node('p', { className: 'wt-url', textContent: 'https://reading.example/article/wrong' }, root);"));
}

async function appendCss(extension, rule) {
  const css = path.join(extension, 'workspace.css');
  await writeFile(css, `${await readFile(css, 'utf8')}\n${rule}\n`);
}

function runChild(executable, args, browser) {
  return new Promise(resolve => {
    const env = {
      PATH: process.env.PATH ?? '',
      ...(browser ? { HISTORY_SWEEP_CHROMIUM: browser } : {}),
      ...(process.env.HISTORY_SWEEP_NODE_MODULES ? { HISTORY_SWEEP_NODE_MODULES: process.env.HISTORY_SWEEP_NODE_MODULES } : {}),
    };
    const child = spawn(executable, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ exitCode: null, signal: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
  });
}

async function findResults(directory) {
  const matches = [];
  for (const file of await listFiles(directory)) if (path.basename(file) === 'result.json') matches.push(file);
  return matches;
}

async function readResult(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { console.error(`Could not parse ${file}: ${error.message}`); return null; }
}

function printResultSummary(result) {
  console.log(`  status: ${formatValue(result.status)}; contract: ${formatValue(result.contract)}`);
  const failedChecks = result.checks?.filter(check => check.passed === false).map(({ id, label }) => ({ id, label })) ?? [];
  console.log(`  checks: ${result.checks?.length ?? 0}; failed: ${JSON.stringify(failedChecks)}`);
  console.log(`  source hash collections present: ${Boolean(isHashCollection(result.sourceSnapshot?.before) && isHashCollection(result.sourceSnapshot?.after))}`);
}

function isExpectedResult(result, testCase) {
  if (!result
    || result.contract !== 'history-row-actions-v1'
    || !['passed', 'failed'].includes(result.status)
    || !Array.isArray(result.checks)
    || !result.checks.every(check => typeof check.id === 'string' && typeof check.label === 'string' && typeof check.passed === 'boolean' && Object.hasOwn(check, 'observed'))
    || !isHashCollection(result.sourceSnapshot?.before)
    || !isHashCollection(result.sourceSnapshot?.after)) return false;
  if (testCase.expected === 0) return result.status === 'passed' && result.error === null;
  return result.status === 'failed'
    && (result.error === null || (typeof result.error?.message === 'string' && result.error.message.length > 0))
    && result.checks.some(check => check.id === testCase.failedCheck && check.passed === false);
}

function isHashCollection(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length > 0
    && Object.values(value).every(hash => typeof hash === 'string' && /^[a-f\d]{64}$/i.test(hash)));
}

function formatValue(value) {
  return value === undefined ? '(not present)' : JSON.stringify(value);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
