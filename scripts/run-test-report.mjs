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
let multiInstanceConfig;

function positiveInteger(name, defaultValue, minimum = 1) {
  const rawValue = process.env[name];
  if (rawValue === undefined) {
    return defaultValue;
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(
      `${name} must be an integer greater than or equal to ${minimum}.`,
    );
  }
  return value;
}

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
  const fileSummary = [...output.matchAll(/^\s*Test Files\s+([^\r\n]+)/gm)].at(
    -1,
  );
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
    throw new Error(
      'TEST_DATABASE_NAME must contain only letters, digits, and underscores.',
    );
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
  const projectName =
    process.env.TEST_COMPOSE_PROJECT_NAME ?? 'backend-challenge-tests';
  if (!/^[A-Za-z0-9_-]+$/.test(projectName)) {
    throw new Error(
      'TEST_COMPOSE_PROJECT_NAME contains unsupported characters.',
    );
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
  const internalDatabaseUrl = databaseUrl(
    user,
    password,
    'postgres',
    '5432',
    databaseName,
  );
  const hostDatabaseUrl =
    process.env.TEST_DATABASE_URL ??
    databaseUrl(user, password, 'localhost', postgresPort, databaseName);
  const testEndpoint =
    process.env.TEST_SQS_ENDPOINT_URL ?? `http://localhost:${miniStackPort}`;
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
  if (
    !(await prerequisite('Start isolated Docker Compose test project', [
      'up',
      '--build',
      '--force-recreate',
      '--detach',
      '--wait',
      '--wait-timeout',
      '180',
    ]))
  ) {
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
    if (
      !(await prerequisite('Create isolated PostgreSQL test database', [
        'exec',
        '-T',
        'postgres',
        'createdb',
        '-U',
        user,
        databaseName,
      ]))
    ) {
      return undefined;
    }
  } else {
    addRecord(
      'Create isolated PostgreSQL test database',
      'PASS',
      `Database ${databaseName} already exists; it was preserved.`,
    );
  }

  if (
    !(await prerequisite('Initialize test database schema and migrations', [
      'run',
      '--rm',
      '--no-deps',
      '-e',
      `DATABASE_URL=${internalDatabaseUrl}`,
      'app',
      'npm',
      'run',
      'db:initialize',
    ]))
  ) {
    return undefined;
  }

  if (
    !(await prerequisite('Create isolated MiniStack test queues', [
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
    ]))
  ) {
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

const stageLabels = {
  'Unit tests and structural guards':
    'Testes unitários e verificações estruturais',
  'HTTP and Swagger tests': 'Testes da API HTTP e do Swagger',
  'Start isolated Docker Compose test project':
    'Inicialização do ambiente isolado de testes',
  'Check isolated PostgreSQL test database':
    'Verificação do banco PostgreSQL de testes',
  'Create isolated PostgreSQL test database':
    'Criação do banco PostgreSQL de testes',
  'Initialize test database schema and migrations':
    'Aplicação do esquema e das migrações',
  'Create isolated MiniStack test queues':
    'Criação das filas de teste no MiniStack',
  'PostgreSQL and multi-process integration':
    'Integração PostgreSQL com múltiplas instâncias',
  'PostgreSQL and MiniStack integration': 'Integração PostgreSQL e MiniStack',
  'Test report runner': 'Execução do gerador de relatório',
};

const statusLabels = {
  PASS: 'APROVADO',
  FAIL: 'REPROVADO',
  'NOT RUN': 'NÃO EXECUTADO',
  PARTIAL: 'PARCIAL',
  PASSED: 'APROVADO',
  FAILED: 'REPROVADO',
  INCOMPLETE: 'INCOMPLETO',
};

function translateSummary(summary) {
  if (summary === 'Command completed successfully.') {
    return 'Comando concluído com sucesso.';
  }
  if (summary.startsWith('Exit code ')) {
    return summary.replace('Exit code ', 'Código de saída ');
  }
  return summary
    .replaceAll('Test Files', 'Arquivos de teste')
    .replaceAll('Tests', 'Testes')
    .replaceAll('passed', 'aprovados')
    .replaceAll('failed', 'reprovados')
    .replaceAll('skipped', 'ignorados');
}

function renderReport() {
  const passed = records.filter((record) => record.status === 'PASS').length;
  const failures = records.filter((record) => record.status === 'FAIL').length;
  const notRun = records.filter((record) => record.status === 'NOT RUN').length;
  const evidenceStatus = (name) =>
    records.find((record) => record.name === name)?.status ?? 'NOT RUN';
  const statusForEvidence = (name) => {
    const status = evidenceStatus(name);
    return status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'NOT RUN';
  };
  const testedRequestCount = multiInstanceConfig?.requests ?? 50;
  const testedInstanceCount = multiInstanceConfig?.applicationInstances ?? 3;
  const rows = records
    .map(
      (record) => `<tr>
        <td class="stage">${escapeHtml(stageLabels[record.name] ?? record.name)}</td>
        <td><span class="status ${record.status.toLowerCase().replaceAll(' ', '-')}">${statusLabels[record.status] ?? record.status}</span></td>
        <td>${escapeHtml(translateSummary(record.summary))}</td>
        <td>${(record.durationMs / 1000).toFixed(1)} s</td>
        <td><details><summary>Ver saída detalhada</summary><pre>${escapeHtml(record.output || 'Sem saída adicional.')}</pre></details></td>
      </tr>`,
    )
    .join('\n');
  const eliminatoryChecks = [
    [
      'Uso de number para valores monetários',
      statusForEvidence('Unit tests and structural guards'),
      'Os valores monetários usam decimais em texto e unidades menores bigint; as verificações estruturais também são executadas nesta etapa.',
    ],
    [
      'Saldo negativo em condição de corrida',
      statusForEvidence('PostgreSQL and multi-process integration'),
      'O teste concorrente com PostgreSQL real comprova o saldo após operações simultâneas.',
    ],
    [
      'Débito ou crédito duplicado',
      statusForEvidence('PostgreSQL and multi-process integration'),
      `${testedRequestCount} requisições HTTP concorrentes com a mesma chave verificam que ocorre apenas um débito e um lançamento no ledger.`,
    ],
    [
      'Idempotência apenas em memória',
      statusForEvidence('PostgreSQL and multi-process integration'),
      'A persistência é verificada no PostgreSQL, inclusive por testes com três processos Node concorrentes.',
    ],
    [
      'Correção limitada a uma instância',
      statusForEvidence('PostgreSQL and multi-process integration'),
      `${testedRequestCount} requisições HTTP são distribuídas entre ${testedInstanceCount} instâncias Nest independentes, com conexões próprias ao mesmo PostgreSQL.`,
    ],
    [
      'Evento publicado antes do commit',
      statusForEvidence('PostgreSQL and MiniStack integration'),
      'A integração valida o estado confirmado antes do ack e a publicação pela outbox; não simula falha durante uma transação ainda não confirmada.',
    ],
    [
      'Ausência de ledger auditável',
      statusForEvidence('PostgreSQL and MiniStack integration'),
      'A integração confere o saldo e os lançamentos financeiros persistidos.',
    ],
    [
      'PostgreSQL/SQS substituídos por mocks',
      statusForEvidence('PostgreSQL and MiniStack integration'),
      'A etapa de integração usa os serviços PostgreSQL e MiniStack reais iniciados pelo Compose.',
    ],
  ];
  const partial = eliminatoryChecks.filter(
    ([, status]) => status === 'PARTIAL',
  ).length;
  const eliminatoryRows = eliminatoryChecks
    .map(
      ([name, status, explanation]) => `<tr>
      <td class="stage">${escapeHtml(name)}</td>
      <td><span class="status ${status.toLowerCase().replaceAll(' ', '-')}">${statusLabels[status] ?? status}</span></td>
      <td>${escapeHtml(explanation)}</td>
    </tr>`,
    )
    .join('\n');
  const overall =
    failures > 0
      ? 'FAILED'
      : notRun > 0 || partial > 0
        ? 'INCOMPLETE'
        : 'PASSED';
  const generatedAt = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'long',
    timeStyle: 'medium',
  }).format(new Date());
  const loadSummary = multiInstanceConfig
    ? `Cenário HTTP multi-instância: ${multiInstanceConfig.requests} requisições simultâneas distribuídas por ${multiInstanceConfig.applicationInstances} instâncias da aplicação, com pool PostgreSQL de até ${multiInstanceConfig.databasePoolMax} conexões por instância.`
    : 'Os parâmetros do cenário HTTP multi-instância ainda não foram validados.';

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#101827">
  <title>Relatório de testes - ${statusLabels[overall]}</title>
  <style>
    :root { color-scheme: light; font: 15px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #172033; background: #f3f6fb; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { max-width: 1440px; margin: 0 auto; padding: 42px 28px 64px; }
    h1, h2, p { margin-top: 0; }
    h1 { margin-bottom: 8px; font-size: clamp(1.8rem, 3vw, 2.55rem); letter-spacing: -.04em; }
    h2 { margin: 38px 0 14px; font-size: 1.25rem; letter-spacing: -.02em; }
    .eyebrow { margin-bottom: 8px; color: #8290a8; font-size: .76rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    .subtitle, .generated { color: #69758b; }
    .subtitle { margin-bottom: 24px; }
    .summary { position: relative; overflow: hidden; padding: 26px 28px; border: 1px solid #253653; border-radius: 18px; color: #eef4ff; background: radial-gradient(ellipse at top right, #29466f 0, transparent 48%), linear-gradient(130deg, #111c2e, #172943); box-shadow: 0 14px 34px #18294420; }
    .summary::after { position: absolute; top: -70px; right: -50px; width: 210px; height: 210px; border: 1px solid #ffffff18; border-radius: 50%; content: ""; }
    .summary-top { position: relative; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 14px; }
    .summary h2 { margin: 0; color: #fff; font-size: 1.3rem; }
    .summary p { position: relative; z-index: 1; margin: 11px 0 0; color: #b8c7de; }
    .status { display: inline-flex; align-items: center; padding: 4px 10px; border: 1px solid transparent; border-radius: 999px; font-size: .72rem; font-weight: 800; letter-spacing: .045em; white-space: nowrap; }
    .pass { color: #087443; background: #e5f8ed; border-color: #c7efd7; }
    .fail { color: #b42318; background: #fff0ee; border-color: #ffd5cf; }
    .not-run, .partial { color: #976000; background: #fff6df; border-color: #f4e3ae; }
    .incomplete { color: #ffe29a; background: #634819; border-color: #90713a; }
    .failed { color: #ffd2ce; background: #6b2927; border-color: #994844; }
    .passed { color: #baf4d1; background: #1d5d43; border-color: #388862; }
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin: 18px 0 30px; }
    .metric { padding: 16px 18px; border: 1px solid #e1e7f0; border-radius: 14px; background: #fff; box-shadow: 0 5px 18px #13213a08; }
    .metric span { display: block; color: #78849a; font-size: .78rem; font-weight: 650; }
    .metric strong { display: block; margin-top: 3px; font-size: 1.65rem; letter-spacing: -.04em; }
    .panel { overflow: hidden; border: 1px solid #e1e7f0; border-radius: 14px; background: #fff; box-shadow: 0 8px 28px #13213a09; }
    .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 16px; border-bottom: 1px solid #e9edf4; }
    .toolbar label { width: min(100%, 360px); }
    .toolbar input { width: 100%; padding: 10px 13px; border: 1px solid #dce3ee; border-radius: 9px; color: #172033; font: inherit; outline: none; }
    .toolbar input:focus { border-color: #6285c4; box-shadow: 0 0 0 3px #6285c422; }
    .hint { margin: 0; color: #8190a5; font-size: .8rem; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 13px 16px; border-bottom: 1px solid #edf0f5; text-align: left; vertical-align: top; }
    th { color: #738098; background: #f8faff; font-size: .72rem; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr:hover { background: #fafcff; }
    td { color: #47536a; font-size: .9rem; }
    .stage { min-width: 220px; color: #1e2a40; font-weight: 700; }
    td:nth-child(4) { white-space: nowrap; color: #69758b; font-variant-numeric: tabular-nums; }
    details { min-width: 145px; }
    summary { color: #34588f; cursor: pointer; font-size: .82rem; font-weight: 700; }
    pre { max-width: min(74vw, 900px); max-height: 24rem; overflow: auto; margin: 10px 0 0; padding: 14px; border: 1px solid #26364d; border-radius: 10px; color: #d5e2f2; background: #111b2a; font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .empty { padding: 24px; color: #7a879b; text-align: center; }
    footer { margin-top: 20px; color: #8490a4; font-size: .78rem; text-align: right; }
    @media (max-width: 780px) { main { padding: 28px 16px 42px; } .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .toolbar { align-items: stretch; flex-direction: column; } .hint { display: none; } }
    @media (max-width: 440px) { .metrics { gap: 9px; } .metric { padding: 13px; } .metric strong { font-size: 1.4rem; } .summary { padding: 21px; } }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Backend challenge · qualidade e integração</p>
    <h1>Relatório de testes</h1>
    <p class="subtitle">Visão geral das etapas executadas e das evidências para os critérios eliminatórios.</p>
    <section class="summary" aria-label="Resultado geral">
      <div class="summary-top">
        <span class="status ${overall.toLowerCase()}">${statusLabels[overall]}</span>
        <h2>${failures > 0 ? 'Há testes que precisam de atenção' : notRun > 0 || partial > 0 ? 'Execução incompleta: confira as evidências' : 'Execução concluída'}</h2>
      </div>
      <p>${escapeHtml(loadSummary)}</p>
    </section>
    <section class="metrics" aria-label="Resumo dos resultados">
      <article class="metric"><span>Etapas aprovadas</span><strong>${passed}</strong></article>
      <article class="metric"><span>Etapas reprovadas</span><strong>${failures}</strong></article>
      <article class="metric"><span>Etapas não executadas</span><strong>${notRun}</strong></article>
      <article class="metric"><span>Critérios parciais</span><strong>${partial}</strong></article>
    </section>
    <h2>Etapas da execução</h2>
    <section class="panel">
      <div class="toolbar">
        <label><input id="stage-filter" type="search" placeholder="Filtrar etapas..." aria-label="Filtrar etapas por nome ou resultado"></label>
        <p class="hint">Abra “Ver saída detalhada” para consultar os logs originais.</p>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Etapa</th><th>Resultado</th><th>Resumo</th><th>Duração</th><th>Detalhes</th></tr></thead>
          <tbody id="execution-body">${rows}</tbody>
        </table>
        <p id="no-results" class="empty" hidden>Nenhuma etapa corresponde à busca.</p>
      </div>
    </section>
    <h2>Verificação dos critérios eliminatórios</h2>
    <section class="panel table-wrap">
      <table>
        <thead><tr><th>Critério</th><th>Evidência</th><th>O que o teste comprova</th></tr></thead>
        <tbody>${eliminatoryRows}</tbody>
      </table>
    </section>
    <footer>Gerado em ${escapeHtml(generatedAt)} · Os logs detalhados mantêm a saída técnica original.</footer>
  </main>
  <script>
    const filter = document.querySelector('#stage-filter');
    const stageRows = [...document.querySelectorAll('#execution-body tr')];
    const emptyMessage = document.querySelector('#no-results');
    filter.addEventListener('input', () => {
      const query = filter.value.trim().toLocaleLowerCase('pt-BR');
      let visibleRows = 0;
      for (const row of stageRows) {
        const visible = row.textContent.toLocaleLowerCase('pt-BR').includes(query);
        row.hidden = !visible;
        visibleRows += Number(visible);
      }
      emptyMessage.hidden = visibleRows !== 0;
    });
  </script>
</body>
</html>`;
}

async function main() {
  await ensureReportDirectory();
  multiInstanceConfig = {
    requests: positiveInteger('TEST_MULTI_INSTANCE_REQUESTS', 50),
    applicationInstances: positiveInteger('TEST_MULTI_INSTANCE_COUNT', 3, 2),
  };
  multiInstanceConfig.databasePoolMax = positiveInteger(
    'TEST_MULTI_INSTANCE_POOL_MAX',
    Math.max(
      1,
      Math.min(10, Math.floor(40 / multiInstanceConfig.applicationInstances)),
    ),
  );
  const inheritedTestVariables = Object.keys(process.env).filter((key) =>
    key.startsWith('TEST_'),
  );
  const unitPassed = await run(
    'Unit tests and structural guards',
    process.execPath,
    [vitestPath, 'run', '--reporter=verbose', '--config', 'vitest.config.ts'],
    { unsetEnv: inheritedTestVariables },
  );
  const e2ePassed = await run(
    'HTTP and Swagger tests',
    process.execPath,
    [
      vitestPath,
      'run',
      '--reporter=verbose',
      '--config',
      'vitest.config.e2e.ts',
    ],
    { unsetEnv: inheritedTestVariables },
  );

  const buildPassed = await run(
    'Build production application for multi-instance tests',
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'build'],
  );

  const integrationEnvironment = buildPassed
    ? await initializeDockerIntegration()
    : undefined;
  if (integrationEnvironment) {
    const integrationPassed = await run(
      'PostgreSQL and multi-process integration',
      process.execPath,
      [
        vitestPath,
        'run',
        '--reporter=verbose',
        'src/infrastructure/database/mikro-orm/repositories/wager-transaction-concurrency.integration.spec.ts',
      ],
      {
        env: {
          ...integrationEnvironment,
          TEST_MULTI_INSTANCE_REQUESTS: String(multiInstanceConfig.requests),
          TEST_MULTI_INSTANCE_COUNT: String(
            multiInstanceConfig.applicationInstances,
          ),
          TEST_MULTI_INSTANCE_POOL_MAX: String(
            multiInstanceConfig.databasePoolMax,
          ),
        },
      },
    );
    const sqsPassed = await run(
      'PostgreSQL and MiniStack integration',
      process.execPath,
      [
        vitestPath,
        'run',
        '--reporter=verbose',
        'test/sqs-postgres.integration.spec.ts',
      ],
      { env: integrationEnvironment },
    );
    if (!integrationPassed || !sqsPassed) {
      failed = true;
    }
  } else {
    markNotRun(
      'PostgreSQL and multi-process integration',
      buildPassed
        ? 'Docker Compose, the isolated test database, or the test queues could not be prepared.'
        : 'The application build failed; the integration tests were not executed.',
    );
    markNotRun(
      'PostgreSQL and MiniStack integration',
      buildPassed
        ? 'Docker Compose, the isolated test database, or the test queues could not be prepared.'
        : 'The application build failed; the integration tests were not executed.',
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
        multiInstanceConfig,
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
  await writeFile(
    resultsPath,
    JSON.stringify({ status: 'FAILED', multiInstanceConfig, records }, null, 2),
    'utf8',
  );
  console.error(error);
  console.error(`HTML report: ${reportPath}`);
  process.exitCode = 1;
});
