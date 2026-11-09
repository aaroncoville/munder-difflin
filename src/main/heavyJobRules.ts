/**
 * Heavy-job rules for tools outside the Node toolchain: Gradle, Maven, Playwright and
 * end-to-end scripts. Each answers only for its own tool; a command none of the rules
 * recognise stays not heavy, so the lock still fails open.
 */
import type { HeavyClass, HeavyLimit } from './heavyJob';

/** A script whose name says it runs the end-to-end suite: e2e.sh, run-e2e.sh, test_e2e_all.bash.
 *  A helper named after the suite (e2e-down.sh, e2e-setup.sh) only starts or stops its stack. */
export const E2E_SCRIPT = /(^|[-_.])e2e(?![-_.](down|up|stop|start|teardown|setup|clean|logs|reset)\.)([-_.][^/]*)?\.(sh|bash)$/i;

/** How many test suites may hold the heavy-job lock at once, whatever its overall limit: two suites
 *  side by side load a machine enough to fail each other. An integer 1..16, or 'off' for no suite
 *  limit beyond the overall one; anything else means the default of 1. */
export const SUITE_DEFAULT_LIMIT = 1;
export function suiteJobLimit(v: unknown): HeavyLimit {
  if (v === 'off') return 'off';
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 16 ? v : SUITE_DEFAULT_LIMIT;
}

/** Prefixes that run the rest of the line unchanged: `time`, `nohup`, `caffeinate -i`. */
export const RUN_PREFIXES = new Set(['time', 'nohup', 'caffeinate']);

/** A subshell or group, `(cd api && ./gradlew test)` or `{ npm test; }`, runs its words as they are. */
export function unwrapGroup(ws: string[]): string[] {
  const out = ws.filter((w) => w !== '(' && w !== ')' && w !== '{' && w !== '}');
  if (out.length && out[0].startsWith('(')) out[0] = out[0].replace(/^\(+/, '');
  const last = out.length - 1;
  if (last >= 0 && out[last].endsWith(')')) out[last] = out[last].replace(/\)+$/, '');
  return out.filter(Boolean);
}

/** Gradle tasks that compile and run the tests. A qualified task (:api:test) counts by its last part. */
const GRADLE_SUITE_TASKS = new Set(['test', 'check', 'build']);
/** Gradle flags that take their value as the next argument, so that value is not a task. */
const GRADLE_VALUE_FLAGS = new Set([
  '-p', '--project-dir', '-b', '--build-file', '-c', '--settings-file', '-g', '--gradle-user-home',
  '-I', '--init-script', '-x', '--exclude-task', '--tests', '--task', '--console', '--max-workers', '--warning-mode', '-D', '-P'
]);

export function classifyGradle(args: string[]): HeavyClass {
  if (narrowed(args, '--tests')) return { heavy: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) { if (GRADLE_VALUE_FLAGS.has(a)) i++; continue; }
    const task = a.split(':').pop()!;
    if (GRADLE_SUITE_TASKS.has(task)) return { heavy: true, kind: 'suite', why: `gradle ${task}` };
  }
  return { heavy: false };
}

/** Maven lifecycle phases that run the tests on the way (every phase from test onwards). */
const MAVEN_SUITE_PHASES = new Set(['test', 'package', 'integration-test', 'verify', 'install', 'deploy']);
/** Maven flags that take their value as the next argument, so that value is not a phase. */
const MAVEN_VALUE_FLAGS = new Set([
  '-f', '--file', '-s', '--settings', '-gs', '--global-settings', '-pl', '--projects', '-rf', '--resume-from',
  '-T', '--threads', '-P', '--activate-profiles', '-l', '--log-file', '-D', '--define', '-t', '--toolchains'
]);

export function classifyMaven(args: string[]): HeavyClass {
  // -Dtest=FooTest runs one class, as a single test file does elsewhere; a pattern or list does not.
  const only = args.find((a) => a.startsWith('-Dtest='));
  if (only && !/[*,]/.test(only)) return { heavy: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) { if (MAVEN_VALUE_FLAGS.has(a)) i++; continue; }
    // A plugin goal (surefire:test) counts by its goal; dependency:tree and the like do not match.
    const phase = a.split(':').pop()!;
    if (MAVEN_SUITE_PHASES.has(phase)) return { heavy: true, kind: 'suite', why: `mvn ${phase}` };
  }
  return { heavy: false };
}

/** Gradle's --tests with one class or method narrows the run to it, as a single test file does elsewhere. */
function narrowed(args: string[], flag: string): boolean {
  const at = args.indexOf(flag);
  return at >= 0 && at + 1 < args.length && !/[*?]/.test(args[at + 1]);
}

const PLAYWRIGHT_VALUE_FLAGS = new Set([
  '-c', '--config', '-g', '--grep', '--grep-invert', '--project', '--reporter', '-j', '--workers', '--shard', '--retries',
  '--timeout', '--output', '--max-failures', '--repeat-each', '--global-timeout', '--trace'
]);

/** `playwright test` runs the browser suite; install, codegen, show-report and the rest do not.
 *  Listing the tests, or naming only spec files, is light, as a single test file is elsewhere. */
export function classifyPlaywright(args: string[]): HeavyClass {
  const at = args.findIndex((a) => !a.startsWith('-'));
  if (at < 0 || args[at] !== 'test' || args.includes('--list')) return { heavy: false };
  const files: string[] = [];
  for (let i = at + 1; i < args.length; i++) {
    if (args[i].startsWith('-')) { if (PLAYWRIGHT_VALUE_FLAGS.has(args[i])) i++; continue; }
    files.push(args[i]);
  }
  if (files.length && files.every((f) => /\.[cm]?[jt]sx?(:\d+)?$/.test(f) && !/[*?]/.test(f))) return { heavy: false };
  return { heavy: true, kind: 'suite', why: 'playwright test' };
}

/** A suite's worker process, as a process listing shows it once the wrapper has handed over:
 *  `java … org.gradle.wrapper.GradleWrapperMain test`, `node …/.bin/playwright test`. */
export function classifyWorker(bin: string, args: string[]): HeavyClass | null {
  if (bin === 'java') {
    const at = args.findIndex((a) => a === 'org.gradle.wrapper.GradleWrapperMain' || a === 'org.gradle.launcher.GradleMain');
    return at < 0 ? null : classifyGradle(args.slice(at + 1));
  }
  if (bin === 'node') {
    const at = args.findIndex((a) => !a.startsWith('-'));
    if (at >= 0 && /(^|[\\/])(playwright|playwright[\\/]cli\.js|@playwright[\\/]test[\\/]cli\.js)$/.test(args[at])) return classifyPlaywright(args.slice(at + 1));
  }
  return null;
}

/** npm, pnpm and yarn forms the core rules do not read: `exec`/`dlx` of a tool, a bare `playwright`
 *  under yarn or pnpm, and a package script named for the end-to-end suite (e2e, e2e:ci, test-e2e).
 *  `recurse` classifies the tool line that `exec` runs. */
export function classifyPackageExtras(bin: string, args: string[], recurse: (ws: string[]) => HeavyClass): HeavyClass | null {
  const at = args.findIndex((a) => !a.startsWith('-'));
  if (at < 0) return null;
  const sub = args[at];
  if (sub === 'exec' || sub === 'dlx' || (bin !== 'npm' && sub === 'playwright')) {
    const rest = args.slice(sub === 'playwright' ? at : at + 1);
    const tool = rest.findIndex((a) => !a.startsWith('-'));
    return tool < 0 ? null : recurse(rest.slice(tool));
  }
  const script = sub === 'run' || sub === 'run-script' ? args.slice(at + 1).find((a) => !a.startsWith('-')) ?? '' : bin === 'npm' ? '' : sub;
  if (/^(e2e|test[-_]e2e)([-:_].*)?$/.test(script)) return { heavy: true, kind: 'suite', why: `${bin} ${script}` };
  return null;
}
