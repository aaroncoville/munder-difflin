'use strict';
// The heavy-job classifier for Gradle, Maven, Playwright and end-to-end scripts, through the
// same classifyCommand the lock uses. Nothing here inspects the real machine.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { classifyCommand, classifyHeavy } = loadTs('src/main/heavyJob.ts');

const SUITES = [
  './gradlew test', 'gradle test', 'gradle check', './gradlew build', 'cd api && ./gradlew test -q > ../api.log 2>&1',
  './gradlew test --rerun', './gradlew :api:test', 'gradlew.bat test',
  './gradlew -p api clean test', './gradlew --console=plain check',
  'mvn test', 'mvn -q verify', 'mvn clean package', './mvnw install', 'mvnw.cmd verify', 'mvn -pl core -am test', 'mvn surefire:test',
  'npx playwright test', 'playwright test e2e/auth', 'npx playwright test --project=chromium',
  'bash scripts/e2e.sh', 'scripts/e2e.sh --reporter=line', 'E2E_PORT=18190 scripts/e2e.sh web/e2e/vehicles', 'sh ./run-e2e.sh',
  './test_e2e_script.sh', 'bash -lc "./gradlew test"', 'zsh -c "npx playwright test"',
];

const NOT_SUITES = [
  'gradle --version', './gradlew --version', './gradlew tasks', './gradlew help --task test', './gradlew dependencies',
  './gradlew test-fixtures-report', './gradlew -p test assemble', './gradlew build-env-info',
  'mvn --version', 'mvn -v', 'mvn dependency:tree', 'mvn -f test/pom.xml compile', 'mvn help:describe -Dcmd=test',
  'npx playwright install', 'npx playwright install --with-deps chromium', 'playwright show-report', 'npx playwright codegen',
  'cat e2e-notes.md', 'vim docs/e2e-notes.md', 'cat scripts/e2e.sh', 'grep -n e2e scripts/e2e.sh', 'ls web/e2e',
  'echo ./gradlew test', 'git commit -m "run ./gradlew test and scripts/e2e.sh"', 'free2e.sh',
];

test('Gradle, Maven, Playwright and e2e scripts are suites', () => {
  for (const cmd of SUITES) {
    const c = classifyCommand(cmd);
    assert.equal(c.heavy, true, cmd);
    assert.equal(c.kind, 'suite', cmd);
  }
});

test('near misses stay light: versions, task lists, installs, reading a script or a note', () => {
  for (const cmd of NOT_SUITES) assert.equal(classifyCommand(cmd).heavy, false, cmd);
});

test('the reason names the task that made it heavy', () => {
  assert.equal(classifyCommand('./gradlew -p api clean test').why, 'gradle test');
  assert.equal(classifyCommand('./gradlew :api:check').why, 'gradle check');
  assert.equal(classifyCommand('mvn clean verify').why, 'mvn verify');
  assert.equal(classifyCommand('npx playwright test').why, 'playwright test');
  assert.equal(classifyCommand('bash scripts/e2e.sh').why, 'e2e.sh');
});

test('a tool call carrying one of these commands is heavy; one it cannot read is not', () => {
  assert.equal(classifyHeavy('Bash', { command: 'cd api && ./gradlew test' }).heavy, true);
  assert.equal(classifyHeavy('Bash', { command: 'scripts/e2e.sh' }).heavy, true);
  assert.equal(classifyHeavy('Bash', { cmd: 42 }).heavy, false);
  assert.equal(classifyHeavy('Bash', null).heavy, false);
  assert.equal(classifyCommand('some-unknown-tool --run everything').heavy, false);
});
