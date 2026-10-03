import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiParam,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CreateWalletUseCase } from '../../../application/wallets/create-wallet/create-wallet.use-case.js';
import { GetWalletLedgerUseCase } from '../../../application/wallets/get-wallet/get-wallet-ledger.use-case.js';
import { GetWalletUseCase } from '../../../application/wallets/get-wallet/get-wallet.use-case.js';
import { ReconcileWalletUseCase } from '../../../application/wallets/reconcile-wallet/reconcile-wallet.use-case.js';
import { ProviderIdentityGuard } from '../auth/provider-identity.guard.js';
import { CreateWalletDto } from './dto/create-wallet.dto.js';
import {
  WalletIdParamsDto,
  WalletLedgerQueryDto,
} from './dto/get-wallet.dto.js';
import {
  WalletLedgerPageResponseDto,
  WalletReconciliationResponseDto,
  WalletResponseDto,
} from './dto/wallet-responses.dto.js';

@ApiTags('wallets')
@UseGuards(ProviderIdentityGuard)
@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly getWalletLedger: GetWalletLedgerUseCase,
    private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a wallet and its opening ledger entry' })
  @ApiCreatedResponse({
    description: 'Wallet created.',
    type: WalletResponseDto,
  })
  @ApiConflictResponse({
    description: 'A wallet already exists for this player and currency.',
  })
  @ApiBadRequestResponse({ description: 'Invalid wallet payload.' })
  create(@Body() input: CreateWalletDto) {
    return this.createWallet.execute(input);
  }

  @Get(':walletId')
  @ApiOperation({ summary: 'Get the current wallet balance' })
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiOkResponse({ description: 'Wallet found.', type: WalletResponseDto })
  @ApiNotFoundResponse({ description: 'Wallet not found.' })
  get(@Param() params: WalletIdParamsDto) {
    return this.getWallet.execute(params.walletId);
  }

  @Get(':walletId/ledger')
  @ApiOperation({
    summary: 'List wallet ledger entries using an opaque cursor',
  })
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiOkResponse({
    description: 'Ledger page.',
    type: WalletLedgerPageResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Wallet not found.' })
  ledger(
    @Param() params: WalletIdParamsDto,
    @Query() query: WalletLedgerQueryDto,
  ) {
    return this.getWalletLedger.execute(
      params.walletId,
      query.limit,
      query.cursor,
    );
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Compare wallet balance with its immutable ledger' })
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiOkResponse({
    description:
      'Reconciliation result; mismatches are reported, not corrected.',
    type: WalletReconciliationResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Wallet not found.' })
  reconcile(@Param() params: WalletIdParamsDto) {
    return this.reconcileWallet.execute(params.walletId);
  }
}
