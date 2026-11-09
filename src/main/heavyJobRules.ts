/**
 * Heavy-job rules for tools outside the Node toolchain: Gradle, Maven, Playwright and
 * end-to-end scripts. Each answers only for its own tool; a command none of the rules
 * recognise stays not heavy, so the lock still fails open.
 */
import type { HeavyClass } from './heavyJob';

/** A script whose name says it runs the end-to-end suite: e2e.sh, run-e2e.sh, test_e2e_all.bash. */
export const E2E_SCRIPT = /(^|[-_.])e2e([-_.][^/]*)?\.(sh|bash)$/i;

/** Gradle tasks that compile and run the tests. A qualified task (:api:test) counts by its last part. */
const GRADLE_SUITE_TASKS = new Set(['test', 'check', 'build']);
/** Gradle flags that take their value as the next argument, so that value is not a task. */
const GRADLE_VALUE_FLAGS = new Set([
  '-p', '--project-dir', '-b', '--build-file', '-c', '--settings-file', '-g', '--gradle-user-home',
  '-I', '--init-script', '-x', '--exclude-task', '--tests', '--task', '--console', '--max-workers', '--warning-mode', '-D', '-P'
]);

export function classifyGradle(args: string[]): HeavyClass {
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
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) { if (MAVEN_VALUE_FLAGS.has(a)) i++; continue; }
    // A plugin goal (surefire:test) counts by its goal; dependency:tree and the like do not match.
    const phase = a.split(':').pop()!;
    if (MAVEN_SUITE_PHASES.has(phase)) return { heavy: true, kind: 'suite', why: `mvn ${phase}` };
  }
  return { heavy: false };
}

/** `playwright test` runs the browser suite; install, codegen, show-report and the rest do not. */
export function classifyPlaywright(args: string[]): HeavyClass {
  const sub = args.find((a) => !a.startsWith('-'));
  return sub === 'test' ? { heavy: true, kind: 'suite', why: 'playwright test' } : { heavy: false };
}
