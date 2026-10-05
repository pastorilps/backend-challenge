import {
  CognitoIdentityProviderClient,
  CreateUserPoolCommand,
  CreateResourceServerCommand,
  CreateUserPoolClientCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const client = new CognitoIdentityProviderClient({
  region: "us-east-1",
  endpoint: "http://localhost:4566",
  credentials: {
    accessKeyId: "test",
    secretAccessKey: "test",
  },
});

async function setup() {
  try {
    console.log("Criando User Pool...");
    const poolRes = await client.send(
      new CreateUserPoolCommand({ PoolName: "backend-challenge" })
    );
    const poolId = poolRes.UserPool?.Id;
    console.log(`User Pool ID: ${poolId}`);

    console.log("Criando Resource Server...");
    await client.send(
      new CreateResourceServerCommand({
        UserPoolId: poolId,
        Identifier: "backend",
        Name: "backend",
        Scopes: [
          {
            ScopeName: "transactions",
            ScopeDescription: "Submit wagering transactions",
          },
        ],
      })
    );

    console.log("Criando App Client...");
    const clientRes = await client.send(
      new CreateUserPoolClientCommand({
        UserPoolId: poolId,
        ClientName: "provider-a",
        GenerateSecret: true,
        AllowedOAuthFlows: ["client_credentials"],
        AllowedOAuthScopes: ["backend/transactions"],
        AllowedOAuthFlowsUserPoolClient: true,
      })
    );

    const clientId = clientRes.UserPoolClient?.ClientId;
    const clientSecret = clientRes.UserPoolClient?.ClientSecret;

    console.log("\n--- CONFIGURAÇÃO CONCLUÍDA ---");
    console.log(`COGNITO_USER_POOL_ID=${poolId}`);
    console.log(`COGNITO_PROVIDER_CLIENTS={"provider-a":"${clientId}"}`);
    console.log(`Client Secret: ${clientSecret}`);
  } catch (error) {
    console.error("Erro ao configurar o Cognito:", error);
  }
}

setup();