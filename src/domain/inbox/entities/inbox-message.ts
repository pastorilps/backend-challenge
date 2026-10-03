export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt?: Date;
}

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    InboxMessage.assertIdentifier(props.messageId, 'messageId');
    InboxMessage.assertIdentifier(props.consumerName, 'consumerName');
    if (!/^[a-f\d]{64}$/i.test(props.payloadHash)) {
      throw new RangeError('Inbox payload hash must be a SHA-256 hex digest.');
    }
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash.toLowerCase(),
      InboxMessage.validDate(props.receivedAt ?? new Date(), 'receivedAt'),
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt),
      state.processedAt ? new Date(state.processedAt) : undefined,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt) : undefined;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      return;
    }
    const processedAt = InboxMessage.validDate(at, 'processedAt');
    if (processedAt < this.receivedAt) {
      throw new RangeError(
        'Inbox message cannot be processed before it was received.',
      );
    }
    this._processedAt = processedAt;
  }

  private static assertIdentifier(value: string, name: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new RangeError(`${name} must be a non-empty string.`);
    }
  }

  private static validDate(value: Date, name: string): Date {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new RangeError(`${name} must be a valid date.`);
    }
    return new Date(value);
  }
}
