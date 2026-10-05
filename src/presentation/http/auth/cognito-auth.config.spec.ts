import { describe, expect, it } from 'vitest';
import { loadCognitoAuthConfig } from './cognito-auth.config.js';

describe('loadCognitoAuthConfig', () => {
  const environment = {
    COGNITO_USER_POOL_ID: 'us-east-1_examplePool',
    COGNITO_ENDPOINT_URL: 'http://localhost:4566',
    COGNITO_PROVIDER_CLIENTS: '{"provider-a":"client-a"}',
  };

  it('derives the issuer and local MiniStack JWKS URL', () => {
    const config = loadCognitoAuthConfig(environment);

    expect(config.issuer).toBe(
      'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_examplePool',
    );
    expect(config.jwksUrl).toBe(
      'http://localhost:4566/us-east-1_examplePool/.well-known/jwks.json',
    );
    expect(config.providerByClientId.get('client-a')).toBe('provider-a');
  });

  it('rejects shared client IDs that would make provider identity ambiguous', () => {
    expect(() =>
      loadCognitoAuthConfig({
        ...environment,
        COGNITO_PROVIDER_CLIENTS:
          '{"provider-a":"shared-client","provider-b":"shared-client"}',
      }),
    ).toThrow('cannot identify multiple providers');
  });

  it('fails closed when provider mappings are missing', () => {
    expect(() =>
      loadCognitoAuthConfig({
        COGNITO_USER_POOL_ID: environment.COGNITO_USER_POOL_ID,
      }),
    ).toThrow('COGNITO_PROVIDER_CLIENTS must map provider IDs');
  });
});
