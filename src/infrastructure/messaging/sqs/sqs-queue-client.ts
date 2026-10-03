export interface SqsReceivedMessage {
  messageId?: string;
  body?: string;
  receiptHandle?: string;
  approximateReceiveCount?: string;
  messageGroupId?: string;
}

export interface SqsQueueClient {
  receiveMessages(
    queueUrl: string,
    waitTimeSeconds: number,
    visibilityTimeoutSeconds: number,
    abortSignal: AbortSignal,
  ): Promise<SqsReceivedMessage[]>;
  deleteMessage(queueUrl: string, receiptHandle: string): Promise<void>;
  changeMessageVisibility(
    queueUrl: string,
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): Promise<void>;
  sendToDeadLetterQueue(
    queueUrl: string,
    body: string,
    messageGroupId: string,
    deduplicationId: string,
  ): Promise<void>;
}
