import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MoneyResponseDto } from '../../wallets/dto/wallet-responses.dto.js';

export class WagerTransactionResponseDto {
  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ enum: ['PROCESSED', 'PENDING_REFERENCE', 'REJECTED'] })
  status!: string;

  @ApiProperty({ type: MoneyResponseDto, nullable: true })
  balance!: MoneyResponseDto | null;

  @ApiPropertyOptional({ example: 'INSUFFICIENT_BALANCE' })
  failureCode?: string;

  @ApiProperty({ example: false })
  idempotentReplay!: boolean;
}

export class WagerTransactionDetailsResponseDto {
  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({
    enum: ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'],
  })
  status!: string;

  @ApiProperty({ example: 'provider-a' })
  providerId!: string;

  @ApiProperty({ example: 'transaction-123' })
  externalTransactionId!: string;

  @ApiProperty({ format: 'uuid' })
  playerId!: string;

  @ApiProperty({ format: 'uuid' })
  walletId!: string;

  @ApiProperty({ nullable: true })
  roundId!: string | null;

  @ApiProperty({ nullable: true })
  gameId!: string | null;

  @ApiProperty({ example: 'BET' })
  kind!: string;

  @ApiProperty({ type: MoneyResponseDto })
  money!: MoneyResponseDto;

  @ApiProperty({ nullable: true })
  referenceExternalTransactionId!: string | null;

  @ApiPropertyOptional({ example: 'INSUFFICIENT_BALANCE', nullable: true })
  failureCode!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', nullable: true })
  processedAt!: string | null;
}
