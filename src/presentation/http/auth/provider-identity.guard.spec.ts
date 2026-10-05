import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../shared/errors/app.error.js';
import {
  CognitoAuthConfigurationError,
  InvalidCognitoTokenError,
  type CognitoAccessTokenVerifier,
} from './cognito-token-verifier.js';
import { ProviderIdentityGuard } from './provider-identity.guard.js';

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('ProviderIdentityGuard', () => {
  it('requires a bearer token', async () => {
    const verify = vi.fn();
    const verifier: CognitoAccessTokenVerifier = {
      verify,
    };
    const guard = new ProviderIdentityGuard(verifier);

    await expect(
      guard.canActivate(contextFor({ headers: {}, params: {}, body: {} })),
    ).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
      statusCode: 401,
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('accepts a valid principal and rejects another provider identity', async () => {
    const verifier: CognitoAccessTokenVerifier = {
      verify: vi.fn().mockResolvedValue({
        clientId: 'client-a',
        providerId: 'provider-a',
      }),
    };
    const guard = new ProviderIdentityGuard(verifier);
    const request = {
      headers: { authorization: 'Bearer signed-token' },
      params: { providerId: 'provider-a' },
      body: { providerId: 'provider-a' },
    };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request).toHaveProperty('auth', {
      clientId: 'client-a',
      providerId: 'provider-a',
    });

    await expect(
      guard.canActivate(
        contextFor({
          ...request,
          params: { providerId: 'provider-b' },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'PROVIDER_FORBIDDEN',
      statusCode: 403,
    });
  });

  it('distinguishes invalid credentials from an unavailable IdP', async () => {
    const invalidVerifier: CognitoAccessTokenVerifier = {
      verify: vi
        .fn()
        .mockRejectedValue(new InvalidCognitoTokenError('invalid')),
    };
    const guard = new ProviderIdentityGuard(invalidVerifier);
    const request = {
      headers: { authorization: 'Bearer invalid-token' },
      params: {},
      body: {},
    };

    await expect(guard.canActivate(contextFor(request))).rejects.toMatchObject({
      code: 'INVALID_ACCESS_TOKEN',
      statusCode: 401,
    });

    const unavailableVerifier: CognitoAccessTokenVerifier = {
      verify: vi.fn().mockRejectedValue(new TypeError('JWKS request failed')),
    };
    const unavailableGuard = new ProviderIdentityGuard(unavailableVerifier);
    await expect(
      unavailableGuard.canActivate(contextFor(request)),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      unavailableGuard.canActivate(contextFor(request)),
    ).rejects.toMatchObject({
      code: 'IDENTITY_PROVIDER_UNAVAILABLE',
      statusCode: 503,
    });
  });

  it('keeps the app bootable but reports missing Cognito config on protected routes', async () => {
    const verifier = new ProviderIdentityGuard({
      verify: vi
        .fn()
        .mockRejectedValue(
          new CognitoAuthConfigurationError(
            new Error('COGNITO_USER_POOL_ID must be configured.'),
          ),
        ),
    });

    await expect(
      verifier.canActivate(
        contextFor({
          headers: { authorization: 'Bearer token' },
          params: {},
          body: {},
        }),
      ),
    ).rejects.toMatchObject({
      code: 'COGNITO_AUTH_NOT_CONFIGURED',
      statusCode: 503,
    });
  });
});
