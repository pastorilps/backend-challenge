import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import type { CognitoAuthConfig } from './cognito-auth.config.js';

export interface CognitoPrincipal {
  clientId: string;
  providerId: string;
}

export interface CognitoAccessTokenVerifier {
  verify(token: string): Promise<CognitoPrincipal>;
}

export class InvalidCognitoTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = InvalidCognitoTokenError.name;
  }
}

export class CognitoAuthConfigurationError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : 'Cognito authentication is not configured.',
      { cause },
    );
    this.name = CognitoAuthConfigurationError.name;
  }
}

export class CognitoTokenVerifier implements CognitoAccessTokenVerifier {
  private config: CognitoAuthConfig | undefined;
  private jwks: JWTVerifyGetKey | undefined;
  private readonly loadConfig: () => CognitoAuthConfig;

  constructor(
    config: CognitoAuthConfig | (() => CognitoAuthConfig),
    jwks?: JWTVerifyGetKey,
  ) {
    if (typeof config === 'function') {
      this.loadConfig = config;
    } else {
      this.config = config;
      this.loadConfig = () => config;
    }
    this.jwks = jwks;
  }

  async verify(token: string): Promise<CognitoPrincipal> {
    let config: CognitoAuthConfig;
    try {
      config = this.config ??= this.loadConfig();
    } catch (error) {
      throw new CognitoAuthConfigurationError(error);
    }

    const jwks = (this.jwks ??= createRemoteJWKSet(new URL(config.jwksUrl)));
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      algorithms: ['RS256'],
    });
    const clientId = payload.client_id;
    if (payload.token_use !== 'access' || typeof clientId !== 'string') {
      throw new InvalidCognitoTokenError(
        'The JWT is not a Cognito access token.',
      );
    }

    const providerId = config.providerByClientId.get(clientId);
    if (!providerId) {
      throw new InvalidCognitoTokenError(
        'The Cognito app client is not registered for a provider.',
      );
    }

    return { clientId, providerId };
  }

  static isIdentityProviderUnavailable(error: unknown): boolean {
    return (
      error instanceof TypeError ||
      (error instanceof errors.JOSEError &&
        (error.code === 'ERR_JOSE_GENERIC' ||
          error.code === 'ERR_JWKS_TIMEOUT' ||
          error.code === 'ERR_JWKS_INVALID'))
    );
  }
}
