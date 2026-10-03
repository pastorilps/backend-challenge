#!/bin/sh
set -eu

endpoint="${SQS_ENDPOINT_URL:-http://ministack:4566}"
region="${AWS_DEFAULT_REGION:-us-east-1}"
queue_name="${SQS_QUEUE_NAME:-wager-transactions.fifo}"
dlq_name="${SQS_DLQ_NAME:-wager-transactions-dlq.fifo}"
max_attempts="${SQS_MAX_ATTEMPTS:-5}"

case "$max_attempts" in
  ''|*[!0-9]*|0)
    echo "SQS_MAX_ATTEMPTS must be a positive integer." >&2
    exit 1
    ;;
esac

aws_sqs() {
  aws --endpoint-url "$endpoint" --region "$region" sqs "$@"
}

aws_sqs create-queue \
  --queue-name "$dlq_name" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' \
  >/dev/null

dlq_url="$(aws_sqs get-queue-url --queue-name "$dlq_name" --query QueueUrl --output text)"
dlq_arn="$(aws_sqs get-queue-attributes \
  --queue-url "$dlq_url" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn \
  --output text)"

redrive_policy="$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"%s"}' "$dlq_arn" "$max_attempts")"
escaped_redrive_policy="$(printf '%s' "$redrive_policy" | sed 's/\\/\\\\/g; s/"/\\"/g')"
queue_attributes="$(printf '{"FifoQueue":"true","ContentBasedDeduplication":"false","VisibilityTimeout":"60","ReceiveMessageWaitTimeSeconds":"20","RedrivePolicy":"%s"}' "$escaped_redrive_policy")"

aws_sqs create-queue \
  --queue-name "$queue_name" \
  --attributes "$queue_attributes" \
  >/dev/null

queue_url="$(aws_sqs get-queue-url --queue-name "$queue_name" --query QueueUrl --output text)"
echo "SQS queues are ready: $queue_url and $dlq_url"
