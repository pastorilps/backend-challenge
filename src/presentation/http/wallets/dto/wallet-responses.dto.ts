import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MoneyResponseDto {
  @ApiProperty({ example: '975.00' })
  amount!: string;

  @ApiProperty({ example: 'BRL' })
  currency!: string;
}

export class WalletResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  playerId!: string;

  @ApiProperty({ type: MoneyResponseDto })
  balance!: MoneyResponseDto;

  @ApiProperty({ example: 1 })
  version!: number;
}

export class WalletLedgerEntryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ example: 'BET' })
  kind!: string;

  @ApiProperty({ enum: ['DEBIT', 'CREDIT'] })
  direction!: string;

  @ApiProperty({ type: MoneyResponseDto })
  amount!: MoneyResponseDto;

  @ApiProperty({ type: MoneyResponseDto })
  balanceBefore!: MoneyResponseDto;

  @ApiProperty({ type: MoneyResponseDto })
  balanceAfter!: MoneyResponseDto;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class WalletLedgerPageResponseDto {
  @ApiProperty({ format: 'uuid' })
  walletId!: string;

  @ApiProperty({ type: [WalletLedgerEntryResponseDto] })
  entries!: WalletLedgerEntryResponseDto[];

  @ApiPropertyOptional({
    nullable: true,
    description: 'Cursor for the next page.',
  })
  nextCursor!: string | null;

  @ApiProperty({ example: 50 })
  limit!: number;
}

export class WalletReconciliationResponseDto {
  @ApiProperty({ format: 'uuid' })
  walletId!: string;

  @ApiProperty({ type: MoneyResponseDto })
  storedBalance!: MoneyResponseDto;

  @ApiProperty({ type: MoneyResponseDto })
  calculatedBalance!: MoneyResponseDto;

  @ApiProperty({ type: MoneyResponseDto })
  difference!: MoneyResponseDto;

  @ApiProperty({ example: true })
  consistent!: boolean;

  @ApiProperty({ example: 42 })
  checkedEntries!: number;
}
