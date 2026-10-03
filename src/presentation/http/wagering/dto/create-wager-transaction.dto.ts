import { ApiHideProperty, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsString,
  IsUUID,
  Length,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { WagerTransactionKind } from '../../../../domain/wagering/enums/wager-transaction-kind.js';
import { MoneyDto } from '../../wallets/dto/money.dto.js';

export class CreateWagerTransactionDto {
  @ApiProperty({ example: 'provider-a', maxLength: 100 })
  @IsString()
  @Length(1, 100)
  providerId!: string;

  @ApiProperty({ example: 'transaction-123', maxLength: 255 })
  @IsString()
  @Length(1, 255)
  externalTransactionId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  playerId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  walletId!: string;

  @ApiProperty({ example: 'round-987', maxLength: 255 })
  @IsString()
  @Length(1, 255)
  roundId!: string;

  @ApiProperty({ example: 'fortune-chimp', maxLength: 255 })
  @IsString()
  @Length(1, 255)
  gameId!: string;

  @ApiProperty({
    enum: [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ],
  })
  @IsIn([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ])
  kind!: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;

  @ApiProperty({ type: MoneyDto })
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @ApiHideProperty()
  @ValidateIf(
    (input: CreateWagerTransactionDto, value: string | undefined) =>
      value !== undefined ||
      input.kind === WagerTransactionKind.Refund ||
      input.kind === WagerTransactionKind.Rollback,
  )
  @IsString()
  @Length(1, 255)
  referenceExternalTransactionId?: string;
}

export class WagerTransactionIdParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  transactionId!: string;
}

export class ProviderTransactionParamsDto {
  @ApiProperty({ maxLength: 100 })
  @IsString()
  @Length(1, 100)
  providerId!: string;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @Length(1, 255)
  externalTransactionId!: string;
}
