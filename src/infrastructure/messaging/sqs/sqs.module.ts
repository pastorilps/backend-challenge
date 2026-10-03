import { SQSClient } from '@aws-sdk/client-sqs';
import { Module } from '@nestjs/common';
import { AwsSqsQueueClient } from './aws-sqs-queue.client.js';
import { SqsQueueClient } from './sqs-queue-client.js';

export const SQS_QUEUE_CLIENT = Symbol('SQS_QUEUE_CLIENT');

@Module({
  providers: [
    {
      provide: SQS_QUEUE_CLIENT,
      useFactory: (): SqsQueueClient => {
        const endpoint = process.env.SQS_ENDPOINT_URL;
        const region =
          process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
        const client = new SQSClient({
          region,
          ...(endpoint ? { endpoint } : {}),
        });
        return new AwsSqsQueueClient(client);
      },
    },
  ],
  exports: [SQS_QUEUE_CLIENT],
})
export class SqsModule {}