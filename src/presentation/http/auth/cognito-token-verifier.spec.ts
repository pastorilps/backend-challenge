import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CognitoAuthConfig } from './cognito-auth.config.js';
import { CognitoTokenVerifier } from './cognito-token-verifier.js';

describe('CognitoTokenVerifier', () => {
  const config: CognitoAuthConfig = {
    issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_testpool',
    jwksUrl: 'http://ministack:4566/us-east-1_testpool/.well-known/jwks.json',
    providerByClientId: new Map([['client-a', 'provider-a']]),
  };
  let verifier: CognitoTokenVerifier;
  let privateKey: CryptoKey;

  beforeAll(async () => {
    const keyPair = await generateKeyPair('RS256');
    privateKey = keyPair.privateKey;
    const publicJwk = await exportJWK(keyPair.publicKey);
    verifier = new CognitoTokenVerifier(
      config,
      createLocalJWKSet({
        keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }],
      }),
    );
  });

  async function issueToken(
    claims: Record<string, unknown>,
    issuer = config.issuer,
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  it('validates a signed access token and resolves its provider', async () => {
    const token = await issueToken({
      token_use: 'access',
      client_id: 'client-a',
    });

    await expect(verifier.verify(token)).resolves.toEqual({
      clientId: 'client-a',
      providerId: 'provider-a',
    });
  });

  it('rejects ID tokens and app clients not mapped to a provider', async () => {
    const idToken = await issueToken({
      token_use: 'id',
      client_id: 'client-a',
    });
    const unknownClientToken = await issueToken({
      token_use: 'access',
      client_id: 'unknown-client',
    });

    await expect(verifier.verify(idToken)).rejects.toThrow(
      'The JWT is not a Cognito access token.',
    );
    await expect(verifier.verify(unknownClientToken)).rejects.toThrow(
      'The Cognito app client is not registered for a provider.',
    );
  });

  it('rejects tokens signed for a different issuer', async () => {
    const token = await issueToken(
      { token_use: 'access', client_id: 'client-a' },
      'https://issuer.invalid/pool',
    );

    await expect(verifier.verify(token)).rejects.toThrow(
      'unexpected "iss" claim value',
    );
  });
});
