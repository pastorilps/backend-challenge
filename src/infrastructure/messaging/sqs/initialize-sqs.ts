import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

interface QueueConfiguration {
  sourceQueueName: string;
  deadLetterQueueName: string;
  eventsQueueName: string;
  maxAttempts: number;
  visibilityTimeoutSeconds: number;
  waitTimeSeconds: number;
}

export async function initializeSqsQueues(
  client: SQSClient,
  configuration: QueueConfiguration,
): Promise<void> {
  const deadLetterQueue = await client.send(
    new CreateQueueCommand({
      QueueName: configuration.deadLetterQueueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
      },
    }),
  );
  const deadLetterQueueUrl = requiredQueueUrl(
    deadLetterQueue.QueueUrl,
    configuration.deadLetterQueueName,
  );
  const deadLetterAttributes = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: deadLetterQueueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const deadLetterQueueArn = deadLetterAttributes.Attributes?.QueueArn;
  if (!deadLetterQueueArn) {
    throw new Error(
      `MiniStack did not return an ARN for ${configuration.deadLetterQueueName}.`,
    );
  }

  const redrivePolicy = JSON.stringify({
    deadLetterTargetArn: deadLetterQueueArn,
    maxReceiveCount: String(configuration.maxAttempts),
  });

  const sourceQueue = await client.send(
    new CreateQueueCommand({
      QueueName: configuration.sourceQueueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
      },
    }),
  );
  const sourceQueueUrl = requiredQueueUrl(
    sourceQueue.QueueUrl,
    configuration.sourceQueueName,
  );
  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: sourceQueueUrl,
      Attributes: {
        VisibilityTimeout: String(configuration.visibilityTimeoutSeconds),
        ReceiveMessageWaitTimeSeconds: String(configuration.waitTimeSeconds),
        RedrivePolicy: redrivePolicy,
      },
    }),
  );
  await client.send(
    new CreateQueueCommand({
      QueueName: configuration.eventsQueueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
      },
    }),
  );

  console.info(
    `MiniStack SQS queues are ready: ${configuration.sourceQueueName}, ${configuration.deadLetterQueueName}, ${configuration.eventsQueueName}.`,
  );
}

function requiredQueueUrl(
  queueUrl: string | undefined,
  queueName: string,
): string {
  if (!queueUrl) {
    throw new Error(`MiniStack did not return a URL for ${queueName}.`);
  }
  return queueUrl;
}

function positiveInteger(
  value: string | undefined,
  defaultValue: number,
  name: string,
  maximum: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const endpoint = process.env.SQS_ENDPOINT_URL;
  if (!endpoint) {
    throw new Error('SQS_ENDPOINT_URL must be configured before queue setup.');
  }

  const configuration: QueueConfiguration = {
    sourceQueueName: process.env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo',
    deadLetterQueueName:
      process.env.SQS_DLQ_NAME ?? 'wager-transactions-dlq.fifo',
    eventsQueueName: process.env.SQS_EVENTS_QUEUE_NAME ?? 'wager-events.fifo',
    maxAttempts: positiveInteger(
      process.env.SQS_MAX_ATTEMPTS,
      5,
      'SQS_MAX_ATTEMPTS',
      100,
    ),
    visibilityTimeoutSeconds: positiveInteger(
      process.env.SQS_VISIBILITY_TIMEOUT_SECONDS,
      60,
      'SQS_VISIBILITY_TIMEOUT_SECONDS',
      43_200,
    ),
    waitTimeSeconds: positiveInteger(
      process.env.SQS_WAIT_TIME_SECONDS,
      20,
      'SQS_WAIT_TIME_SECONDS',
      20,
    ),
  };
  const client = new SQSClient({
    endpoint,
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });

  try {
    await initializeSqsQueues(client, configuration);
  } finally {
    client.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('MiniStack SQS queue initialization failed.', error);
  process.exitCode = 1;
});
