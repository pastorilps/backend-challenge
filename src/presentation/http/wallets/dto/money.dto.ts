import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches } from 'class-validator';

export class MoneyDto {
  @ApiProperty({
    example: '100.00',
    pattern: '^(0|[1-9]\\d{0,16})(\\.\\d{1,2})?$',
  })
  @IsString()
  @Matches(/^(0|[1-9]\d{0,16})(\.\d{1,2})?$/)
  amount!: string;

  @ApiProperty({ enum: ['BRL'], example: 'BRL' })
  @IsIn(['BRL'])
  currency!: string;
}
