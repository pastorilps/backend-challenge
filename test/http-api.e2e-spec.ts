import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { GetWagerTransactionUseCase } from '../src/application/wagering/get-wager-transaction/get-wager-transaction.use-case.js';
import { ProcessWagerTransactionUseCase } from '../src/application/wagering/process-wager-transaction/process-wager-transaction.use-case.js';
import { CreateWalletUseCase } from '../src/application/wallets/create-wallet/create-wallet.use-case.js';
import { GetWalletLedgerUseCase } from '../src/application/wallets/get-wallet/get-wallet-ledger.use-case.js';
import { GetWalletUseCase } from '../src/application/wallets/get-wallet/get-wallet.use-case.js';
import { ReconcileWalletUseCase } from '../src/application/wallets/reconcile-wallet/reconcile-wallet.use-case.js';
import { WagerTransactionStatus } from '../src/domain/wagering/enums/wager-transaction-status.js';
import { DATABASE_ORM } from '../src/infrastructure/database/database.module.js';
import { configureHttpApplication } from '../src/presentation/http/configure-http-application.js';
import { HealthController } from '../src/presentation/http/health/health.controller.js';
import { WageringController } from '../src/presentation/http/wagering/wagering.controller.js';
import { WalletsController } from '../src/presentation/http/wallets/wallets.controller.js';
import { ProviderIdentityGuard } from '../src/presentation/http/auth/provider-identity.guard.js';

describe('HTTP API (e2e)', () => {
  let app: INestApplication<App>;
  let processTransaction: ReturnType<typeof vi.fn>;
  let previousSqsHealthUrl: string | undefined;

  beforeEach(async () => {
    previousSqsHealthUrl = process.env.SQS_HEALTHCHECK_URL;
    delete process.env.SQS_HEALTHCHECK_URL;
    processTransaction = vi.fn().mockResolvedValue({
      response: {
        transactionId: '00000000-0000-4000-8000-000000000003',
        status: WagerTransactionStatus.Processed,
        balance: { amount: '90.00', currency: 'BRL' },
        idempotentReplay: false,
      },
      replayed: false,
    });
    const module = await Test.createTestingModule({
      controllers: [WalletsController, WageringController, HealthController],
      providers: [
        ProviderIdentityGuard,
        {
          provide: CreateWalletUseCase,
          useValue: {
            execute: vi.fn().mockResolvedValue({
              id: '00000000-0000-4000-8000-000000000002',
              playerId: '00000000-0000-4000-8000-000000000001',
              balance: { amount: '100.00', currency: 'BRL' },
              version: 1,
            }),
          },
        },
        {
          provide: GetWalletUseCase,
          useValue: { execute: vi.fn().mockResolvedValue({ id: 'wallet' }) },
        },
        {
          provide: GetWalletLedgerUseCase,
          useValue: { execute: vi.fn().mockResolvedValue({ entries: [] }) },
        },
        {
          provide: ReconcileWalletUseCase,
          useValue: {
            execute: vi.fn().mockResolvedValue({ consistent: true }),
          },
        },
        {
          provide: ProcessWagerTransactionUseCase,
          useValue: { execute: processTransaction },
        },
        {
          provide: GetWagerTransactionUseCase,
          useValue: {
            byId: vi.fn().mockResolvedValue({ transactionId: 'transaction' }),
            byProviderExternalId: vi
              .fn()
              .mockResolvedValue({ transactionId: 'transaction' }),
          },
        },
        {
          provide: DATABASE_ORM,
          useValue: {
            em: {
              getConnection: () => ({
                execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
              }),
            },
          },
        },
      ],
    }).compile();

    app = module.createNestApplication();
    configureHttpApplication(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    if (previousSqsHealthUrl === undefined) {
      delete process.env.SQS_HEALTHCHECK_URL;
    } else {
      process.env.SQS_HEALTHCHECK_URL = previousSqsHealthUrl;
    }
  });

  it('serves a generated OpenAPI document containing the planned endpoints', async () => {
    const result = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);

    expect(result.body.paths).toHaveProperty('/wallets');
    expect(result.body.paths).toHaveProperty('/wallets/{walletId}');
    expect(result.body.paths).toHaveProperty('/wallets/{walletId}/ledger');
    expect(result.body.paths).toHaveProperty(
      '/wallets/{walletId}/reconciliation',
    );
    expect(result.body.paths).toHaveProperty('/wagering/transactions');
    expect(result.body.paths).toHaveProperty(
      '/wagering/transactions/{transactionId}',
    );
    expect(result.body.paths).toHaveProperty(
      '/providers/{providerId}/wagering/transactions/{externalTransactionId}',
    );
    expect(result.body.paths).toHaveProperty('/health/live');
    expect(
      result.body.components.schemas.CreateWagerTransactionDto.properties,
    ).not.toHaveProperty('referenceExternalTransactionId');
  });

  it('requires an idempotency key and returns a structured client error', async () => {
    const result = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .send({
        providerId: 'provider-a',
        externalTransactionId: 'transaction-1',
        playerId: '00000000-0000-4000-8000-000000000001',
        walletId: '00000000-0000-4000-8000-000000000002',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      })
      .expect(400);

    expect(result.body).toMatchObject({
      statusCode: 400,
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });
    expect(processTransaction).not.toHaveBeenCalled();
  });

  it.each([
    [WagerTransactionStatus.Processed, 200],
    [WagerTransactionStatus.PendingReference, 202],
    [WagerTransactionStatus.Rejected, 422],
  ])('maps transaction status %s to HTTP %s', async (status, httpStatus) => {
    processTransaction.mockResolvedValueOnce({
      response: {
        transactionId: '00000000-0000-4000-8000-000000000003',
        status,
        balance: { amount: '90.00', currency: 'BRL' },
        idempotentReplay: false,
        ...(status === WagerTransactionStatus.Rejected
          ? { failureCode: 'INSUFFICIENT_BALANCE' }
          : {}),
      },
      replayed: false,
    });

    const result = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:transaction-1')
      .send({
        providerId: 'provider-a',
        externalTransactionId: 'transaction-1',
        playerId: '00000000-0000-4000-8000-000000000001',
        walletId: '00000000-0000-4000-8000-000000000002',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      })
      .expect(httpStatus);

    expect(result.body.status).toBe(status);
  });

  it('keeps live health open and reports unconfigured SQS as not ready', async () => {
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'ok' });

    const ready = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);
    expect(ready.body.checks).toEqual({
      database: { status: 'up' },
      sqs: { status: 'not_configured' },
    });
  });
});
