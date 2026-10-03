import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const resultsDirectory = join(root, '.test-results');
const reportPath = join(resultsDirectory, 'report.html');
const resultsPath = join(resultsDirectory, 'results.json');
const vitestPath = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const records = [];
let incomplete = false;
let failed = false;

function addRecord(name, status, summary, output = '') {
  records.push({
    name,
    status,
    summary,
    output: redact(output),
    durationMs: 0,
  });
}

function redact(value) {
  let output = value.replace(/\u001B\[[0-9;]*m/g, '');
  const password = process.env.POSTGRES_PASSWORD;
  if (password) {
    output = output.replaceAll(password, '[REDACTED]');
  }
  return output.replace(
    /(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi,
    '$1[REDACTED]@',
  );
}

function run(name, command, args, options = {}) {
  return new Promise((resolveRun) => {
    const startedAt = Date.now();
    let output = '';
    const environment = { ...process.env, ...options.env };
    for (const key of options.unsetEnv ?? []) {
      delete environment[key];
    }
    const child = spawn(command, args, {
      cwd: root,
      env: environment,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
      windowsHide: true,
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', (error) => {
      output += `${error.name}: ${error.message}\n`;
    });
    child.on('close', (code) => {
      const status =
        code === 0 ? 'PASS' : options.notRunOnFailure ? 'NOT RUN' : 'FAIL';
      records.push({
        name,
        status,
        summary:
          summarizeVitest(output) ??
          (code === 0
            ? 'Command completed successfully.'
            : `Exit code ${code ?? 'unknown'}.`),
        output: redact(output),
        durationMs: Date.now() - startedAt,
      });
      if (status === 'FAIL') {
        failed = true;
      } else if (status === 'NOT RUN') {
        incomplete = true;
      }
      resolveRun(code === 0);
    });
  });
}

function summarizeVitest(output) {
  const testSummary = [...output.matchAll(/^\s*Tests\s+([^\r\n]+)/gm)].at(-1);
  const fileSummary = [...output.matchAll(/^\s*Test Files\s+([^\r\n]+)/gm)].at(-1);
  if (!testSummary && !fileSummary) {
    return undefined;
  }
  return [fileSummary?.[1].trim(), testSummary?.[1].trim()]
    .filter(Boolean)
    .join('; ');
}

function markNotRun(name, summary) {
  incomplete = true;
  addRecord(name, 'NOT RUN', summary);
}

function validateDatabaseName(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error('TEST_DATABASE_NAME must contain only letters, digits, and underscores.');
  }
  return name;
}

function databaseUrl(username, password, host, port, databaseName) {
  return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${databaseName}`;
}

async function ensureReportDirectory() {
  await mkdir(resultsDirectory, { recursive: true });
}

async function initializeDockerIntegration() {
  const user = process.env.POSTGRES_USER ?? 'root';
  const password = process.env.POSTGRES_PASSWORD ?? 'rootpassword';
  const queueSuffix = randomUUID().slice(0, 8);
  const databaseName = validateDatabaseName(
    process.env.TEST_DATABASE_NAME ?? `backend_challenge_test_${queueSuffix}`,
  );
  const accountId = process.env.AWS_ACCOUNT_ID ?? '000000000000';
  const projectName = process.env.TEST_COMPOSE_PROJECT_NAME ?? 'backend-challenge-tests';
  if (!/^[A-Za-z0-9_-]+$/.test(projectName)) {
    throw new Error('TEST_COMPOSE_PROJECT_NAME contains unsupported characters.');
  }
  const postgresPort = process.env.TEST_COMPOSE_POSTGRES_PORT ?? '15432';
  const miniStackPort = process.env.TEST_COMPOSE_MINISTACK_PORT ?? '14566';
  const appPort = process.env.TEST_COMPOSE_APP_PORT ?? '13000';
  const composeEnvironment = {
    POSTGRES_PORT: postgresPort,
    MINISTACK_PORT: miniStackPort,
    APP_PORT: appPort,
  };
  const awsRegion = process.env.AWS_REGION ?? 'us-east-1';
  const testQueue =
    process.env.TEST_SQS_QUEUE_NAME ??
    `wager-transactions-test-${queueSuffix}.fifo`;
  const testDlq =
    process.env.TEST_SQS_DLQ_NAME ??
    `wager-transactions-test-dlq-${queueSuffix}.fifo`;
  const testEventsQueue =
    process.env.TEST_SQS_EVENTS_QUEUE_NAME ??
    `wager-events-test-${queueSuffix}.fifo`;
  const internalDatabaseUrl = databaseUrl(user, password, 'postgres', '5432', databaseName);
  const hostDatabaseUrl =
    process.env.TEST_DATABASE_URL ??
    databaseUrl(user, password, 'localhost', postgresPort, databaseName);
  const testEndpoint = process.env.TEST_SQS_ENDPOINT_URL ?? `http://localhost:${miniStackPort}`;
  const internalSqsEndpoint = `http://ministack:4566`;

  const composeArgs = (...args) => [
    'compose',
    '--project-name',
    projectName,
    ...args,
  ];
  const prerequisite = (name, args) =>
    run(name, 'docker', composeArgs(...args), {
      env: composeEnvironment,
      notRunOnFailure: true,
    });
  if (!(await prerequisite('Start isolated Docker Compose test project', ['up', '--build', '--force-recreate', '--detach', '--wait', '--wait-timeout', '180']))) {
    return undefined;
  }

  const databaseExists = await prerequisite(
    'Check isolated PostgreSQL test database',
    [
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      user,
      '-d',
      'postgres',
      '-tAc',
      `SELECT 1 FROM pg_database WHERE datname = '${databaseName}'`,
    ],
  );
  if (!databaseExists) {
    return undefined;
  }
  const databaseIsPresent = records
    .at(-1)
    ?.output.split(/\r?\n/)
    .map((line) => line.trim())
    .includes('1');
  if (!databaseIsPresent) {
    if (!(await prerequisite(
      'Create isolated PostgreSQL test database',
      ['exec', '-T', 'postgres', 'createdb', '-U', user, databaseName],
    ))) {
      return undefined;
    }
  } else {
    addRecord('Create isolated PostgreSQL test database', 'PASS', `Database ${databaseName} already exists; it was preserved.`);
  }

  if (!(await prerequisite(
    'Initialize test database schema and migrations',
    [
      'run',
      '--rm',
      '--no-deps',
      '-e',
      `DATABASE_URL=${internalDatabaseUrl}`,
      'app',
      'npm',
      'run',
      'db:initialize',
    ],
  ))) {
    return undefined;
  }

  if (!(await prerequisite(
    'Create isolated MiniStack test queues',
    [
      'run',
      '--rm',
      '--no-deps',
      '-e',
      `SQS_ENDPOINT_URL=${internalSqsEndpoint}`,
      '-e',
      `AWS_REGION=${awsRegion}`,
      '-e',
      `AWS_ACCOUNT_ID=${accountId}`,
      '-e',
      `SQS_QUEUE_NAME=${testQueue}`,
      '-e',
      `SQS_DLQ_NAME=${testDlq}`,
      '-e',
      `SQS_EVENTS_QUEUE_NAME=${testEventsQueue}`,
      '-e',
      'SQS_MAX_ATTEMPTS=3',
      '-e',
      'SQS_VISIBILITY_TIMEOUT_SECONDS=5',
      '-e',
      'SQS_WAIT_TIME_SECONDS=1',
      'app',
      'npm',
      'run',
      'sqs:initialize',
    ],
  ))) {
    return undefined;
  }

  return {
    TEST_DATABASE_URL: hostDatabaseUrl,
    TEST_SQS_ENDPOINT_URL: testEndpoint,
    TEST_SQS_QUEUE_URL: `${testEndpoint}/${accountId}/${testQueue}`,
    TEST_SQS_DLQ_URL: `${testEndpoint}/${accountId}/${testDlq}`,
    TEST_SQS_EVENTS_QUEUE_URL: `${testEndpoint}/${accountId}/${testEventsQueue}`,
    AWS_REGION: awsRegion,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  };
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderReport() {
  const passed = records.filter((record) => record.status === 'PASS').length;
  const failures = records.filter((record) => record.status === 'FAIL').length;
  const notRun = records.filter((record) => record.status === 'NOT RUN').length;
  const overall = failures > 0 ? 'FAILED' : notRun > 0 ? 'INCOMPLETE' : 'PASSED';
  const evidenceStatus = (name) =>
    records.find((record) => record.name === name)?.status ?? 'NOT RUN';
  const statusForEvidence = (name) => {
    const status = evidenceStatus(name);
    return status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'NOT RUN';
  };
  const rows = records
    .map(
      (record) => `<tr>
        <td>${escapeHtml(record.name)}</td>
        <td><span class="status ${record.status.toLowerCase().replaceAll(' ', '-')}">${record.status}</span></td>
        <td>${escapeHtml(record.summary)}</td>
        <td>${(record.durationMs / 1000).toFixed(1)}s</td>
        <td><details><summary>Output</summary><pre>${escapeHtml(record.output || 'No output.')}</pre></details></td>
      </tr>`,
    )
    .join('\n');
  const eliminatoryRows = [
    ['Using number for money', statusForEvidence('Unit tests and structural guards'), 'Money is represented by decimal-string inputs and bigint minor units; source/schema regression guards ran in this report.'],
    ['Negative balance under race', statusForEvidence('PostgreSQL and multi-process integration'), 'PostgreSQL concurrent balance-dispute test is only evidence when the real integration stage passes.'],
    ['Duplicate debit/credit', statusForEvidence('PostgreSQL and multi-process integration'), 'Real PostgreSQL 50-way replay and ledger assertions are only evidence when integration passes.'],
    ['Idempotency only in memory', statusForEvidence('PostgreSQL and multi-process integration'), 'Persistence and three separate Node processes are covered by the real PostgreSQL integration stage.'],
    ['Correctness only with one instance', evidenceStatus('PostgreSQL and multi-process integration') === 'PASS' ? 'PARTIAL' : statusForEvidence('PostgreSQL and multi-process integration'), 'Three independent processes/pools are tested; three separate application containers are not yet tested.'],
    ['Event published before commit', statusForEvidence('PostgreSQL and MiniStack integration'), 'Integration verifies committed financial state and outbox publication through MiniStack; it does not simulate a crash during an uncommitted insert.'],
    ['Missing auditable ledger', statusForEvidence('PostgreSQL and MiniStack integration'), 'The integration suite reconstructs the stored balance from persisted ledger rows.'],
    ['PostgreSQL/SQS replaced by mocks', statusForEvidence('PostgreSQL and MiniStack integration'), 'A passing integration stage uses the actual Compose PostgreSQL and MiniStack services.'],
  ]
    .map(([name, status, explanation]) => `<tr><td>${escapeHtml(name)}</td><td><span class="status ${status.toLowerCase().replaceAll(' ', '-')}">${status}</span></td><td>${escapeHtml(explanation)}</td></tr>`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Automated test report - ${overall}</title>
  <style>
    :root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; }
    body { max-width: 1200px; margin: 2rem auto; padding: 0 1rem; }
    h1, h2 { line-height: 1.2; }
    .summary { padding: 1rem; border-radius: .5rem; background: #222; }
    .status { font-weight: 700; }
    .pass { color: #17803d; } .fail { color: #c62828; }
    .not-run { color: #a36b00; } .partial { color: #a36b00; }
    table { width: 100%; border-collapse: collapse; margin: 1rem 0 2rem; }
    th, td { padding: .65rem; text-align: left; vertical-align: top; border-bottom: 1px solid #8886; }
    pre { max-height: 22rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
    details { min-width: 8rem; }
    @media (prefers-color-scheme: light) { .summary { background: #f1f3f5; } }
  </style>
</head>
<body>
  <h1>Automated test report</h1>
  <section class="summary">
    <strong class="status ${overall.toLowerCase()}">${overall}</strong>
    <span> ${passed} passed · ${failures} failed · ${notRun} not run</span>
    <p>Generated ${new Date().toISOString()}. A skipped or unavailable real-service test is never counted as passing.</p>
  </section>
  <h2>Execution</h2>
  <table><thead><tr><th>Stage</th><th>Status</th><th>Summary</th><th>Duration</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table>
  <h2>Eliminatory failure checks</h2>
  <table><thead><tr><th>Risk</th><th>Evidence</th><th>Scope / limitation</th></tr></thead><tbody>${eliminatoryRows}</tbody></table>
</body>
</html>`;
}

async function main() {
  await ensureReportDirectory();
  const inheritedTestVariables = Object.keys(process.env).filter((key) =>
    key.startsWith('TEST_'),
  );
  const unitPassed = await run(
    'Unit tests and structural guards',
    process.execPath,
    [vitestPath, 'run', '--config', 'vitest.config.ts'],
    { unsetEnv: inheritedTestVariables },
  );
  const e2ePassed = await run(
    'HTTP and Swagger tests',
    process.execPath,
    [vitestPath, 'run', '--config', 'vitest.config.e2e.ts'],
    { unsetEnv: inheritedTestVariables },
  );

  const integrationEnvironment = await initializeDockerIntegration();
  if (integrationEnvironment) {
    const integrationPassed = await run(
      'PostgreSQL and multi-process integration',
      process.execPath,
      [
        vitestPath,
        'run',
        'src/infrastructure/database/mikro-orm/repositories/wager-transaction-concurrency.integration.spec.ts',
      ],
      { env: integrationEnvironment },
    );
    const sqsPassed = await run(
      'PostgreSQL and MiniStack integration',
      process.execPath,
      [vitestPath, 'run', 'test/sqs-postgres.integration.spec.ts'],
      { env: integrationEnvironment },
    );
    if (!integrationPassed || !sqsPassed) {
      failed = true;
    }
  } else {
    markNotRun(
      'PostgreSQL and multi-process integration',
      'Docker Compose, the isolated test database, or the test queues could not be prepared.',
    );
    markNotRun(
      'PostgreSQL and MiniStack integration',
      'Docker Compose, the isolated test database, or the test queues could not be prepared.',
    );
  }

  if (!unitPassed || !e2ePassed) {
    failed = true;
  }
  const report = renderReport();
  await writeFile(reportPath, report, 'utf8');
  await writeFile(
    resultsPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        status: failed ? 'FAILED' : incomplete ? 'INCOMPLETE' : 'PASSED',
        records,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`HTML report: ${reportPath}`);
  console.log(`JSON results: ${resultsPath}`);
  process.exitCode = failed ? 1 : incomplete ? 2 : 0;
}

main().catch(async (error) => {
  failed = true;
  addRecord(
    'Test report runner',
    'FAIL',
    error instanceof Error ? error.message : 'Unknown runner failure.',
  );
  await ensureReportDirectory();
  await writeFile(reportPath, renderReport(), 'utf8');
  await writeFile(resultsPath, JSON.stringify({ status: 'FAILED', records }, null, 2), 'utf8');
  console.error(error);
  console.error(`HTML report: ${reportPath}`);
  process.exitCode = 1;
});
