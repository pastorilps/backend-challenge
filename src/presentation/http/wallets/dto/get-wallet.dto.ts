import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class WalletIdParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  walletId!: string;
}

export class WalletLedgerQueryDto {
  @ApiProperty({
    required: false,
    description: 'Opaque cursor returned by the preceding page.',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: 1,
    maximum: 100,
    default: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;
}
