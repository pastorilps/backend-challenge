export interface CognitoAuthConfig {
  issuer: string;
  jwksUrl: string;
  providerByClientId: ReadonlyMap<string, string>;
}

export function loadCognitoAuthConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CognitoAuthConfig {
  const poolId = environment.COGNITO_USER_POOL_ID?.trim();
  if (!poolId || !/^[a-z0-9-]+_[A-Za-z0-9]+$/.test(poolId)) {
    throw new Error(
      'COGNITO_USER_POOL_ID must be a valid Cognito User Pool ID.',
    );
  }

  const region = poolId.slice(0, poolId.indexOf('_'));
  const endpoint = new URL(
    environment.COGNITO_ENDPOINT_URL ?? 'http://ministack:4566',
  );
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      'COGNITO_ENDPOINT_URL must be an origin without a path, query, or fragment.',
    );
  }

  const mappingValue = environment.COGNITO_PROVIDER_CLIENTS;
  if (!mappingValue) {
    throw new Error(
      'COGNITO_PROVIDER_CLIENTS must map provider IDs to Cognito app client IDs.',
    );
  }

  let mapping: unknown;
  try {
    mapping = JSON.parse(mappingValue);
  } catch (error) {
    throw new Error('COGNITO_PROVIDER_CLIENTS must contain valid JSON.', {
      cause: error,
    });
  }

  if (
    typeof mapping !== 'object' ||
    mapping === null ||
    Array.isArray(mapping)
  ) {
    throw new Error('COGNITO_PROVIDER_CLIENTS must be a JSON object.');
  }

  const providerByClientId = new Map<string, string>();
  for (const [providerId, clientId] of Object.entries(mapping)) {
    const normalizedProviderId = providerId.trim();
    const normalizedClientId =
      typeof clientId === 'string' ? clientId.trim() : '';
    if (
      !normalizedProviderId ||
      !normalizedClientId
    ) {
      throw new Error(
        'COGNITO_PROVIDER_CLIENTS entries must have non-empty provider and client IDs.',
      );
    }
    if (providerByClientId.has(normalizedClientId)) {
      throw new Error(
        `Cognito app client ${normalizedClientId} cannot identify multiple providers.`,
      );
    }
    providerByClientId.set(normalizedClientId, normalizedProviderId);
  }

  if (providerByClientId.size === 0) {
    throw new Error(
      'COGNITO_PROVIDER_CLIENTS must contain at least one entry.',
    );
  }

  return {
    issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}`,
    jwksUrl: `${endpoint.origin}/${encodeURIComponent(poolId)}/.well-known/jwks.json`,
    providerByClientId,
  };
}
