# Processador distribuído de transações de apostas

Backend NestJS para processamento de operações de carteira e transações de apostas. O sistema prioriza consistência financeira, idempotência persistente, concorrência entre instâncias e recuperação de mensagens usando PostgreSQL, MikroORM e SQS (MiniStack no ambiente local).

## Sumário

- [Arquitetura e fluxo](#arquitetura-e-fluxo)
- [Domínio e garantias](#domínio-e-garantias)
- [API HTTP](#api-http)
- [Processamento SQS e transactional outbox](#processamento-sqs-e-transactional-outbox)
- [Persistência e migrations](#persistência-e-migrations)
- [Executar localmente](#executar-localmente)
- [Testes](#testes)
- [Observabilidade e health checks](#observabilidade-e-health-checks)
- [Aderência à arquitetura e limitações conhecidas](#aderência-à-arquitetura-e-limitações-conhecidas)

## Arquitetura e fluxo

O código segue a separação descrita em [ARCHITECTURE.md](./ARCHITECTURE.md):

| Camada         | Responsabilidade                                                                                   | Localização              |
| -------------- | -------------------------------------------------------------------------------------------------- | ------------------------ |
| Domínio        | Dinheiro, carteira, transação, ledger, inbox e outbox; invariantes independentes de infraestrutura | `src/domain/`            |
| Aplicação      | Casos de uso, processamento de transação e contrato de métricas                                    | `src/application/`       |
| Infraestrutura | PostgreSQL/MikroORM, migrations, SQS, publisher e métricas                                         | `src/infrastructure/`    |
| Apresentação   | Controllers HTTP, DTOs, validação, Swagger e health checks                                         | `src/presentation/http/` |
| Compartilhado  | Erros, eventos de integração, hash e JSON canônico                                                 | `src/shared/`            |

HTTP e SQS reutilizam o mesmo `ProcessWagerTransactionUseCase`. Para cada operação financeira, o processador persiste em uma única transação PostgreSQL o estado da carteira, a transação, o lançamento no ledger, o receipt do inbox (quando originado da fila) e os eventos da outbox. Os eventos só são publicados pelo worker após o commit.

## Domínio e garantias

- O valor monetário trafega como decimal em string e é armazenado em `numeric(19,2)`. A moeda suportada para carteiras e ledger é BRL; rejeições de moeda podem ser auditadas na transação.
- Wallets são limitadas a uma por jogador/moeda. Um saldo inicial positivo cria uma transação `OPENING` e um crédito no ledger junto da wallet; saldo inicial zero não cria lançamento.
- `BET` debita; `WIN` credita; `LOSS` não altera saldo; `REFUND` e `ROLLBACK` dependem de uma transação de referência válida e não podem reverter a mesma referência mais de uma vez.
- A wallet é bloqueada com `SELECT ... FOR UPDATE` antes de validar/aplicar mudanças. Locks advisory transacionais serializam chaves de idempotência e identificadores externos; constraints únicas no PostgreSQL são a última defesa.
- O ledger registra o saldo antes/depois e não deve ser alterado pela aplicação depois da criação. Reconciliação compara o saldo materializado com a soma do ledger, registra divergências e não corrige automaticamente.
- `Idempotency-Key` e hash do payload são persistidos. Repetir a mesma chave e payload devolve a resposta original; reutilizar a chave com conteúdo diferente é conflito.
- Mensagens SQS têm entrega at-least-once. O inbox deduplica por consumidor e `messageId`; uma mensagem já processada não repete efeitos financeiros.
- Retries da outbox mantêm o `eventId` estável. Uma falha após o aceite pelo SQS e antes do commit pode duplicar a publicação; consumidores de eventos devem deduplicar pelo `eventId`.

## API HTTP

Swagger UI: `GET /docs`

Documento OpenAPI: `GET /docs-json`

| Método e rota                                                             | Uso                                                                     |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `POST /wallets`                                                           | Cria wallet e, se houver saldo inicial positivo, o lançamento `OPENING` |
| `GET /wallets/:walletId`                                                  | Consulta saldo atual                                                    |
| `GET /wallets/:walletId/ledger?limit=&cursor=`                            | Consulta ledger paginado com cursor opaco                               |
| `POST /wallets/:walletId/reconciliation`                                  | Recalcula saldo usando o ledger e retorna divergências                  |
| `POST /wagering/transactions`                                             | Processa aposta/operação; exige `Idempotency-Key`                       |
| `GET /wagering/transactions/:transactionId`                               | Consulta pelo UUID interno                                              |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo identificador externo do provedor                         |
| `GET /health/live`                                                        | Liveness do processo                                                    |
| `GET /health/ready`                                                       | Readiness de PostgreSQL e SQS/MiniStack                                 |

O envio de transação responde `200` para processamento/replay, `202` quando aguarda referência, `422` para rejeição de negócio e erros estruturados para conflitos/entradas inválidas. Falhas transitórias do banco são reportadas como indisponibilidade.

**Autenticação:** não foi implementada para este desafio. `ProviderIdentityGuard` é apenas um ponto de extensão no-op, não controle de acesso. Não exponha endpoints de negócio publicamente antes de substituí-lo por autenticação/autorização adequada (por exemplo, OIDC).

## Processamento SQS e transactional outbox

O consumer recebe `WagerTransactionRequested`, valida o envelope, grava/processa via inbox e só então confirma a mensagem original. Erros de negócio terminais são persistidos no inbox e confirmados; mensagens malformadas/conflitantes vão para DLQ; falhas transitórias recebem visibility timeout exponencial e são enviadas à DLQ ao atingir `SQS_MAX_ATTEMPTS`. No encerramento, o consumer interrompe o long polling e aguarda o handler ativo.

O publisher busca outbox pendente com `FOR UPDATE SKIP LOCKED`, publica em fila FIFO usando o agregado como `MessageGroupId` e o `eventId` como deduplication ID, e marca publicação. Falhas mantêm a linha pendente com tentativas e próximo horário de retry.

O Compose inicializa três filas FIFO no MiniStack:

- `wager-transactions.fifo` — entrada de transações;
- `wager-transactions-dlq.fifo` — dead-letter queue;
- `wager-events.fifo` — eventos de integração da outbox.

## Persistência e migrations

O schema MikroORM define `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages` e `outbox_messages`, seus relacionamentos, checks, índices e constraints. As migrations versionadas estão em `src/infrastructure/database/mikro-orm/migrations/`.

Ao iniciar, o container aplica migrations pendentes automaticamente. Em um banco vazio, cria o schema atual pelo MikroORM e registra o baseline correspondente às migrations existentes. Se houver um schema parcial, o startup falha explicitamente em vez de tentar repará-lo silenciosamente.

Para inicializar manualmente um banco com a imagem já construída:

```powershell
docker compose run --rm app npm run db:initialize
```

`npm run migration:up` continua disponível para executar migrations versionadas manualmente em ambientes com configuração TypeScript e conexão de banco.

## Executar localmente

Pré-requisitos: Docker Desktop (ou Docker Engine) com Docker Compose v2.

```powershell
Copy-Item .env.example .env
docker compose up --build -d
```

O Compose constrói e executa a API/worker no container `app`, inicia PostgreSQL e MiniStack, espera pelos health checks, cria as filas SQS e só então inicia a aplicação. Na primeira inicialização a aplicação cria o schema do banco; nos próximos starts aplica migrations pendentes antes de servir tráfego.

- API: `http://localhost:3000`
- Swagger: `http://localhost:3000/docs`
- PostgreSQL: `localhost:5432`
- MiniStack SQS: `localhost:4566`

Confira o estado e os logs:

```powershell
docker compose ps
docker compose logs -f app
```

Para parar os containers mantendo os dados do PostgreSQL:

```powershell
docker compose down
```

Para apagar também o volume persistente do banco (ação destrutiva, remove os dados locais):

```powershell
docker compose down --volumes
```

O Compose inicializa o serviço `sqs-init` após o health check do MiniStack. Para reinicializar as filas após limpar o emulador, execute:

```powershell
docker compose run --rm sqs-init
```

Configuração local relevante:

| Variável                                                    | Finalidade                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`       | Usuário, senha e banco criados pelo container PostgreSQL            |
| `POSTGRES_PORT`                                             | Porta publicada do PostgreSQL no host (padrão `5432`)               |
| `APP_PORT`                                                  | Porta HTTP publicada no host (padrão `3000`)                        |
| `MINISTACK_PORT`                                            | Porta SQS publicada no host (padrão `4566`)                         |
| `DATABASE_URL`                                              | URL de conexão interna; no Compose o hostname do banco é `postgres` |
| `SQS_ENDPOINT_URL`                                          | Endpoint interno do emulador (`http://ministack:4566`)              |
| `SQS_QUEUE_NAME` / `SQS_DLQ_NAME` / `SQS_EVENTS_QUEUE_NAME` | Nomes das filas FIFO inicializadas pelo Compose                     |
| `AWS_REGION` / `AWS_ACCOUNT_ID`                             | Região e account id usados pelo MiniStack                           |
| `SQS_MAX_ATTEMPTS`                                          | Tentativas de processamento antes de DLQ (padrão `5`)               |
| `SQS_RETRY_BASE_DELAY_MS` / `SQS_RETRY_MAX_DELAY_MS`        | Limites do backoff de retry                                         |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` / `SQS_WAIT_TIME_SECONDS`  | Visibilidade e long polling                                         |
| `OUTBOX_BATCH_SIZE` / `OUTBOX_POLL_INTERVAL_MS`             | Lote e intervalo do publisher                                       |

Também são configuráveis `SQS_CONSUMER_NAME`, `SQS_QUEUE_NAME`, `SQS_DLQ_NAME` e `SQS_EVENTS_QUEUE_NAME`. O serviço `app` usa os hostnames internos `postgres` e `ministack`; os ports publicados servem para ferramentas que rodam no host. As credenciais `test` do ambiente local não devem ser reutilizadas na AWS.

No fluxo padrão do Compose, as URLs internas são calculadas a partir dos nomes das filas e o consumer e publisher são iniciados automaticamente.

## Testes

```powershell
# Testes unitários e testes sem dependências externas
npm test

# Testes HTTP e Swagger com providers de aplicação simulados
npm run test:e2e

# Testes opt-in com PostgreSQL e MiniStack reais
npm run test:integration

# Build, type-check e lint
npm run build
npx tsc --noEmit
npm run lint
```

### Testes unitários e HTTP

A suíte unitária cobre objetos de valor, invariantes de wallet/transação/ledger, regras e referências, canonicalização/hash de payload, inbox/outbox, idempotência e consumer. Os testes e2e HTTP verificam contrato OpenAPI, validação, header idempotente, mapeamento de status e health checks; não inicializam PostgreSQL nem SQS reais.

### Testes reais (opt-in)

Os testes PostgreSQL exigem um banco descartável **com as migrations já aplicadas** em `TEST_DATABASE_URL`. Cobrem a presença de colunas, índices e constraints requeridos, abertura financiada da wallet e concorrência usando três instâncias MikroORM independentes: 50 entregas com mesma chave/inbox, disputa de saldo, identificador externo repetido entre carteiras, carteiras distintas e publishers concorrentes. Um cenário adicional inicia três processos Node independentes com 15 entregas paralelas em cada um para a mesma operação.

O cenário fim a fim PostgreSQL + MiniStack verifica processamento de entrada por SQS, persistência em inbox/ledger/outbox, publicação dos eventos e encaminhamento de mensagem malformada para DLQ. Também encerra um processo de worker depois do commit financeiro e antes do ACK, reabre a conexão PostgreSQL e confirma que o redelivery é processado como replay sem duplicar efeitos. Use filas de teste isoladas, nunca as filas compartilhadas de desenvolvimento.

Crie um banco de teste separado (uma única vez) e filas isoladas para não consumir ou alterar dados de desenvolvimento:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://root:rootpassword@localhost:5432/backend_challenge_test'
$env:DATABASE_URL = $env:TEST_DATABASE_URL
$env:SQS_QUEUE_NAME = 'wager-transactions-test.fifo'
$env:SQS_DLQ_NAME = 'wager-transactions-test-dlq.fifo'
$env:SQS_EVENTS_QUEUE_NAME = 'wager-events-test.fifo'
docker compose exec -T postgres psql -U root -d postgres -c 'CREATE DATABASE backend_challenge_test;'
docker compose run --rm sqs-init
npm run migration:up
```

Configure as variáveis de teste e execute:

```powershell
$env:TEST_SQS_ENDPOINT_URL = 'http://localhost:4566'
$env:TEST_SQS_QUEUE_URL = 'http://localhost:4566/000000000000/wager-transactions-test.fifo'
$env:TEST_SQS_DLQ_URL = 'http://localhost:4566/000000000000/wager-transactions-test-dlq.fifo'
$env:TEST_SQS_EVENTS_QUEUE_URL = 'http://localhost:4566/000000000000/wager-events-test.fifo'
npm run test:integration
```

Os testes de concorrência do banco são ignorados sem `TEST_DATABASE_URL`; o cenário que toca filas reais também é ignorado até que todas as variáveis `TEST_SQS_*` acima estejam definidas. Evite executar sobre filas que tenham mensagens que não pertençam ao teste.

### Cobertura ainda necessária para o item 13

Ainda faltam testes com três **containers** de aplicação distintos (a concorrência multiprocess atual usa três processos Node no mesmo host), publishers concorrentes contra MiniStack real e retry/backoff transitório exercitado na fila real. A suíte verifica migrations já aplicadas, mas não sobe um banco vazio e aplica migrations automaticamente como parte do teste. A ausência de Docker/PostgreSQL neste ambiente impede executar os opt-in aqui; não deve ser interpretada como resultado aprovado desses cenários.

## Observabilidade e health checks

Os logs de processamento, consumer, DLQ, reconciliação e publisher são JSON e incluem IDs de correlação disponíveis. Não registram payloads completos, valores/saldos, chaves de idempotência nem credenciais.

Métricas customizadas registradas por `AppMetrics`:

- `wager_transactions_total{status}`;
- `wager_transaction_duplicates_total`;
- `messaging_retries_total{source}` (`sqs` ou `outbox`);
- `sqs_messages_dead_lettered_total`;
- `database_lock_conflicts_total`;
- `wager_processing_latency_ms`;
- `outbox_lag_ms`;
- `wallet_reconciliation_mismatches_total`.

Os labels usam apenas valores de cardinalidade limitada; IDs não são labels. `/health/live` verifica que o processo responde. `/health/ready` consulta PostgreSQL e o endpoint HTTP do emulador; SQS não configurado aparece como `not_configured` e torna o serviço não pronto.

O módulo NestJS Observe está preparado, mas `appKey`/`appSecret` ainda são placeholders em `src/app.module.ts`. Configure credenciais reais antes de esperar exportação para um workspace Observe.

## Aderência à arquitetura e limitações conhecidas

A separação de camadas, PostgreSQL como fonte da verdade, `Money` decimal, locks transacionais, constraints de idempotência, inbox/outbox, SQS FIFO, API e health checks seguem as decisões centrais de [ARCHITECTURE.md](./ARCHITECTURE.md). As migrations e o schema materializam as cinco tabelas de persistência e suas relações.

Diferenças e itens de hardening que devem permanecer explícitos:

- A arquitetura inicial menciona Bun e LocalStack; o repositório usa npm/Node (`package-lock.json`) e MiniStack. O Compose e as variáveis do serviço estão calibrados para MiniStack.
- O guard de identidade de provedor é no-op; autenticação não está atendida.
- O reprocessador de transações com referência pendente existe como caso de uso/adaptador, mas ainda não está registrado em scheduler ou worker NestJS, então não há execução periódica automática.
- Idempotência/Inbox/Outbox e transações estão implementados, porém ledger imutável é uma regra da aplicação, não uma restrição que impeça alterações diretas via SQL.
- A recuperação por crash/ACK é validada opt-in em processo local; não há ainda execução em três containers, publisher concorrente usando MiniStack real, retry transitório validado contra a fila real ou bootstrap de migrations em banco vazio na suíte.

Esses pontos não devem ser tratados como garantias de produção sem a implementação e validação adicionais descritas.
