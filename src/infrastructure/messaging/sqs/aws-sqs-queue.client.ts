import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { OnApplicationShutdown } from '@nestjs/common';
import {
  SqsQueueClient,
  SqsReceivedMessage,
} from './sqs-queue-client.js';

export class AwsSqsQueueClient
  implements SqsQueueClient, OnApplicationShutdown
{
  constructor(private readonly client: SQSClient) {}

  async receiveMessages(
    queueUrl: string,
    waitTimeSeconds: number,
    visibilityTimeoutSeconds: number,
    abortSignal: AbortSignal,
  ): Promise<SqsReceivedMessage[]> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: waitTimeSeconds,
        VisibilityTimeout: visibilityTimeoutSeconds,
        MessageSystemAttributeNames: [
          'ApproximateReceiveCount',
          'MessageGroupId',
        ],
      }),
      { abortSignal },
    );
    return (result.Messages ?? []).map((message) => ({
      messageId: message.MessageId,
      body: message.Body,
      receiptHandle: message.ReceiptHandle,
      approximateReceiveCount:
        message.Attributes?.ApproximateReceiveCount,
      messageGroupId: message.Attributes?.MessageGroupId,
    }));
  }

  async deleteMessage(
    queueUrl: string,
    receiptHandle: string,
  ): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
    );
  }

  async changeMessageVisibility(
    queueUrl: string,
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: visibilityTimeoutSeconds,
      }),
    );
  }

  async sendToDeadLetterQueue(
    queueUrl: string,
    body: string,
    messageGroupId: string,
    deduplicationId: string,
  ): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: messageGroupId,
        MessageDeduplicationId: deduplicationId,
      }),
    );
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
