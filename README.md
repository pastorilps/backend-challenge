<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## HTTP API

Copy `.env.example` to `.env`, start the local dependencies with `docker compose up -d`, and apply the MikroORM migrations before starting the service. The Nest application loads `.env` automatically. The API includes wallet creation and queries, paginated wallet ledger, reconciliation, wager submission/queries, and health checks.

- Swagger UI: `http://localhost:3000/docs`
- OpenAPI JSON: `http://localhost:3000/docs-json`
- `GET /health/live` checks process liveness and is always public.
- `GET /health/ready` checks PostgreSQL and MiniStack via `SQS_HEALTHCHECK_URL`; readiness returns `503` until both dependencies are reachable.
- `POST /wagering/transactions` requires an `Idempotency-Key` header.

Provider authentication is intentionally not implemented for this challenge. The provider identity guard is a no-op extension point and must be replaced with OIDC authentication before exposing business endpoints in production.

## SQS wager consumer

The worker consumes `WagerTransactionRequested` messages from the FIFO source queue and uses the same wager use case as the HTTP API. `docker compose up -d` starts MiniStack and a one-shot initializer that creates the source queue and FIFO DLQ with the required redrive policy. The default configuration is:

```text
SQS_QUEUE_URL=http://localhost:4566/000000000000/wager-transactions.fifo
SQS_DLQ_URL=http://localhost:4566/000000000000/wager-transactions-dlq.fifo
SQS_ENDPOINT_URL=http://localhost:4566
AWS_REGION=us-east-1
SQS_HEALTHCHECK_URL=http://localhost:4566/_ministack/health
```

On Windows PowerShell, start the dependencies and the application with:

```powershell
Copy-Item .env.example .env
docker compose up -d
npm run start:dev
```

Compose reads `.env` automatically; the Nest application loads the same file through `dotenv`. The AWS SDK uses its normal credential provider chain. The example uses MiniStack's local test credentials (`test`/`test`), which must not be reused in AWS. If both queue URLs are omitted, the HTTP service starts with the consumer disabled; setting only one is a startup configuration error.

The queue initializer runs once after MiniStack reports healthy. If queues need to be recreated after resetting MiniStack, run `docker compose run --rm sqs-init`. Queue names and retry count can be overridden with `SQS_QUEUE_NAME`, `SQS_DLQ_NAME`, and `SQS_MAX_ATTEMPTS` in `.env`.

The sample endpoint and queue URLs target an application running on the host. If the application is later run inside `app_network`, use `SQS_ENDPOINT_URL=http://ministack:4566`, `SQS_QUEUE_URL=http://ministack:4566/000000000000/wager-transactions.fifo`, `SQS_DLQ_URL=http://ministack:4566/000000000000/wager-transactions-dlq.fifo`, and `SQS_HEALTHCHECK_URL=http://ministack:4566/_ministack/health`.

The message body follows section 10 of `PLAN.md`; its `data` also includes `idempotencyKey`. Business validation errors are terminal and acknowledged after being persisted in the inbox. Invalid or conflicting message IDs go to the configured FIFO DLQ. Other failures are retried with exponential visibility backoff and sent to the DLQ after `SQS_MAX_ATTEMPTS` (default `5`).

Optional tuning variables are `SQS_CONSUMER_NAME` (default `wager-transaction-consumer`), `SQS_MAX_ATTEMPTS`, `SQS_RETRY_BASE_DELAY_MS` (default `1000`), `SQS_RETRY_MAX_DELAY_MS` (default `300000`), `SQS_VISIBILITY_TIMEOUT_SECONDS` (default `60`), and `SQS_WAIT_TIME_SECONDS` (default `20`). On shutdown the worker stops polling, cancels the long poll, and waits for the current message handler to finish.

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Observability

In production applications, observability is essential for understanding how your system behaves, detecting issues early, and maintaining reliable performance.

[NestJS Observe](https://observe.nestjs.com) automatically instruments your NestJS application, giving you deep visibility into your system with minimal setup:

- **Distributed tracing:** Follow requests across services and understand how they flow through your system.
- **Waterfall analysis:** Visualize request execution and identify slow operations, bottlenecks, and unexpected delays.
- **Performance analysis:** Analyze application performance in real time and quickly pinpoint areas that need optimization.
- **Metrics:** Track key application and infrastructure metrics to understand system health and performance trends.
- **Logging:** Centralize and correlate logs with traces and other telemetry to make debugging easier.
- **Error tracking:** Detect errors quickly and investigate their root causes with the surrounding context.
- **SLA monitoring:** Track service-level objectives and identify when your application is approaching or exceeding defined thresholds.
- **Alarms and alerts:** Set up alerts for critical errors, performance degradation, SLA violations, and other anomalies so your team can react quickly.

This project is already instrumented. Create a free account at [observe.nestjs.com](https://observe.nestjs.com), add an application, and paste the generated app key and secret into the `ObserveModule.forRoot()` call in `src/app.module.ts`.

The free plan needs no payment details and covers 300,000 events a month. You can also browse the [live demo](https://www.observe-demo.nestjs.com/dashboard) first - the whole dashboard over a busy service's data, with nothing to install.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Auto-instrument your application with [NestJS Observe](https://observe.nestjs.com). Distributed tracing, metrics, and logging made easy. Error tracking and performance monitoring for your NestJS applications.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
