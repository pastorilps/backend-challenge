import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '../../../shared/errors/app.error.js';
import {
  CognitoTokenVerifier,
  CognitoAuthConfigurationError,
  InvalidCognitoTokenError,
  type CognitoAccessTokenVerifier,
  type CognitoPrincipal,
} from './cognito-token-verifier.js';

type AuthenticatedRequest = Request & {
  auth?: CognitoPrincipal;
};

@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  constructor(
    @Inject(CognitoTokenVerifier)
    private readonly tokenVerifier: CognitoAccessTokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer\s+(\S+)$/i);
    if (!match) {
      throw new AppError(
        'A Cognito bearer access token is required.',
        'AUTHENTICATION_REQUIRED',
        401,
      );
    }

    let principal: CognitoPrincipal;
    try {
      principal = await this.tokenVerifier.verify(match[1]);
    } catch (error) {
      if (error instanceof CognitoAuthConfigurationError) {
        throw new AppError(
          'Cognito authentication is not configured for this environment.',
          'COGNITO_AUTH_NOT_CONFIGURED',
          503,
          { cause: error },
        );
      }
      if (error instanceof InvalidCognitoTokenError) {
        throw new AppError(
          'The bearer token is invalid or not authorized for a provider.',
          'INVALID_ACCESS_TOKEN',
          401,
        );
      }
      if (CognitoTokenVerifier.isIdentityProviderUnavailable(error)) {
        throw new AppError(
          'The identity provider is temporarily unavailable.',
          'IDENTITY_PROVIDER_UNAVAILABLE',
          503,
          { cause: error },
        );
      }
      throw error;
    }

    request.auth = principal;
    const requestedProviderIds = [
      request.params.providerId,
      this.providerIdFromBody(request.body),
    ].filter(
      (providerId): providerId is string => typeof providerId === 'string',
    );

    if (
      requestedProviderIds.some(
        (providerId) => providerId !== principal.providerId,
      )
    ) {
      throw new AppError(
        'The authenticated client cannot access another provider.',
        'PROVIDER_FORBIDDEN',
        403,
      );
    }

    return true;
  }

  private providerIdFromBody(body: unknown): string | undefined {
    if (typeof body !== 'object' || body === null || !('providerId' in body)) {
      return undefined;
    }
    const providerId = body.providerId;
    return typeof providerId === 'string' ? providerId : undefined;
  }
}
