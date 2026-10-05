# Backend Challenge

Backend para carteiras e processamento de transações de apostas. A API recebe
operações de provedores, aplica regras financeiras e registra cada movimento
no PostgreSQL. As mesmas regras são usadas no processamento HTTP e no worker
que consome mensagens SQS.

Este documento apresenta o projeto e explica como iniciar o ambiente local,
provisionar o Cognito do MiniStack e acessar a API. As decisões de arquitetura,
trade-offs e limitações estão em [ARCHITECTURE.md](./ARCHITECTURE.md).

## Visão geral

O serviço foi organizado para manter regras financeiras independentes dos
detalhes de transporte e persistência:

- carteiras, transações e ledger formam o domínio financeiro;
- casos de uso são compartilhados entre API e processamento assíncrono;
- PostgreSQL mantém saldos, histórico, idempotência e estados de mensagens;
- SQS desacopla o recebimento de operações e a publicação de eventos;
- Cognito autentica os provedores que acessam as rotas protegidas.

O ledger registra os movimentos que explicam o saldo. Inbox e outbox ajudam a
recuperar mensagens sem repetir efeitos financeiros. O Swagger descreve os
endpoints HTTP e permite experimentá-los pelo navegador.

## Pré-requisitos

- Bun 1.x;
- Docker Desktop com suporte a Docker Compose.

## Executar localmente

1. Na raiz do projeto, crie o arquivo `.env` copiando `.env.example` pelo
   Explorer ou pelo editor. O arquivo `.env` contém configuração local e não
   deve ser compartilhado ou enviado ao Git.
2. Instale as dependências com `bun install --frozen-lockfile`.
3. Inicie os serviços com `docker compose up --build -d`. Isso sobe a API,
   o PostgreSQL e o MiniStack. A aplicação inicializa as filas e o schema do
   banco antes de começar a atender.
4. Aguarde os serviços ficarem saudáveis. O estado pode ser acompanhado pela
   visão de containers do Docker Desktop; os logs do serviço `app` mostram a
   inicialização de filas, migrations e API.
5. Acesse a API em `http://localhost:3000`, a documentação Swagger em
   `http://localhost:3000/docs` e o MiniStack em `http://localhost:4566`.

O Cognito não é provisionado automaticamente no início. Até configurá-lo, a
API pode iniciar e responder aos health checks, mas as rotas protegidas não
aceitam chamadas autenticadas.

Para encerrar o ambiente, pare o projeto pelo Docker Compose. Parar os
containers mantém o volume do PostgreSQL; remover o volume apaga os dados
locais e deve ser uma decisão intencional. Para apenas parar os serviços, use
`docker compose down`; essa ação preserva o banco local.

## Configurar o Cognito local

O script `setup-cognito.ts` cria um User Pool, o resource server `backend` com
o escopo `transactions` e um app client confidencial para `provider-a`. O app
client usa o fluxo OAuth `client_credentials`.

1. Inicie o MiniStack pelo Docker Compose e confirme que está saudável.
2. Na raiz do projeto, execute o script com Bun (`bun setup-cognito.ts`).
   O script se conecta ao MiniStack em `http://localhost:4566` usando as
   credenciais locais de emulação; elas não são credenciais para a AWS.
3. Na saída, localize `COGNITO_USER_POOL_ID` e
   `COGNITO_PROVIDER_CLIENTS`. Copie esses valores para as variáveis
   correspondentes do `.env`. Mantenha `COGNITO_ENDPOINT_URL` apontando para
   `http://localhost:4566`.
4. O script também imprime o `Client Secret`. Ele é exibido em texto aberto:
   guarde-o em um local seguro e não o coloque no `.env`, no código, em logs
   compartilhados ou em commits. A API não precisa receber esse segredo.
5. Recrie o serviço `app` com `docker compose up -d --force-recreate app`
   para que ele carregue os novos IDs.
6. Use o ID e o segredo do app client para obter um access token pelo fluxo
   `client_credentials`, usando uma ferramenta OAuth de sua preferência.
   Tanto o segredo quanto o access token devem ser tratados como credenciais e
   não devem ser compartilhados.
7. No Swagger, use **Authorize** para informar o access token e testar as
   rotas protegidas.

Execute o setup apenas uma vez para cada ambiente persistente. Cada execução
cria um User Pool e um app client novos; se rodar novamente, atualize no `.env`
os IDs que saíram juntos naquela execução e use o client secret correspondente.
O MiniStack local pode perder esses recursos se seu estado for recriado.

`COGNITO_PROVIDER_CLIENTS` associa cada ID de app client a um `providerId`.
Para cadastrar outro provedor, crie um app client dedicado e inclua sua
associação nessa configuração. Não reutilize o client de um provedor para
representar outro.

## Usar a API

As rotas de carteiras e apostas exigem um access token Cognito. As rotas de
health e a documentação Swagger permanecem públicas.

| Método e rota | Finalidade |
| --- | --- |
| `POST /wallets` | Criar carteira e, quando houver saldo inicial, seu crédito de abertura |
| `GET /wallets/:walletId` | Consultar o saldo atual |
| `GET /wallets/:walletId/ledger` | Consultar lançamentos do ledger por páginas |
| `POST /wallets/:walletId/reconciliation` | Comparar o saldo com o histórico do ledger |
| `POST /wagering/transactions` | Submeter uma transação; exige `Idempotency-Key` |
| `GET /wagering/transactions/:transactionId` | Consultar pelo UUID interno da API |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consultar pelo identificador do provedor |
| `GET /health/live` | Verificar se o processo está respondendo |
| `GET /health/ready` | Verificar se as dependências necessárias estão acessíveis |

Ao criar uma transação, guarde o `externalTransactionId` enviado pelo
provedor. Ele é usado na consulta por identificador externo junto com o
`providerId`. A resposta também inclui `transactionId`, o identificador
interno que pode ser usado na consulta por UUID.

O ledger é paginado. Na primeira chamada, escolha um limite de 1 a 100; para
continuar, envie o `nextCursor` devolvido na página anterior. Dinheiro é
representado como string decimal, por exemplo, `15.00 BRL`.

## Testes e qualidade

O projeto inclui testes unitários, testes HTTP/OpenAPI e testes de integração
com PostgreSQL e MiniStack. Os testes de integração devem usar dados e filas
descartáveis, nunca recursos de desenvolvimento que precisem ser preservados.

O comando `bun run test:report` prepara um ambiente de teste isolado e gera um
relatório em `.test-results/`. Os comandos `bun run test` e
`bun run test:e2e` executam, respectivamente, os testes unitários e a suíte
HTTP com dependências simuladas. `bun run test:integration` roda os cenários
que usam serviços reais quando as configurações necessárias estão disponíveis.

Build, verificação de tipos e lint estão disponíveis pelos scripts Bun do
projeto. A cobertura dos testes, incluindo seus limites conhecidos, está
descrita em [ARCHITECTURE.md](./ARCHITECTURE.md).

## Documentação

- [ARCHITECTURE.md](./ARCHITECTURE.md): desenho do sistema, decisões, trade-offs
  e limitações conhecidas.
- [PLAN.md](./PLAN.md): requisitos e critérios do desafio.
