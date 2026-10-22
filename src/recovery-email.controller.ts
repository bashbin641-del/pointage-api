import { Body, Controller, ForbiddenException, Get, Headers, Post } from '@nestjs/common';
import type { RequestIdentity } from './auth.service';
import { AuthService } from './auth.service';
import {
  RequestRecoveryEmailDto,
  RecoveryProofDto,
  RequestEmailChangeWithRecoveryDto,
  UpdatePasswordWithRecoveryDto,
  VerifyEmailChangeWithRecoveryDto,
  VerifyRecoveryCodeDto,
} from './pointage.dto';
import { RecoveryEmailService } from './recovery-email.service';

const adminRoles = new Set(['owner', 'administrator', 'maintainer']);

@Controller('moi/adresse-recuperation')
export class RecoveryEmailController {
  constructor(
    private readonly auth: AuthService,
    private readonly recovery: RecoveryEmailService,
  ) {}

  @Get()
  async status(@Headers('authorization') authorization?: string) {
    return this.recovery.status(await this.requireEligibleUser(authorization));
  }

  @Post('demande')
  async requestVerification(
    @Headers('authorization') authorization: string | undefined,
    @Body() input: RequestRecoveryEmailDto,
  ) {
    return this.recovery.requestContactVerification(await this.requireEligibleUser(authorization), input.email);
  }

  @Post('verification')
  async verifyContact(
    @Headers('authorization') authorization: string | undefined,
    @Body() input: VerifyRecoveryCodeDto,
  ) {
    return this.recovery.verifyContact(
      await this.requireEligibleUser(authorization),
      input.challengeId,
      input.code,
    );
  }

  @Post('code-mot-de-passe')
  async requestPasswordCode(@Headers('authorization') authorization?: string) {
    return this.recovery.requestActionCode(await this.requireEmployee(authorization), 'password_reset');
  }

  @Post('code-mot-de-passe/verification')
  async verifyPasswordCode(
    @Headers('authorization') authorization: string | undefined,
    @Body() input: VerifyRecoveryCodeDto,
  ) {
    return this.recovery.verifyActionCode(
      await this.requireEmployee(authorization),
      'password_reset',
      input.challengeId,
      input.code,
    );
  }

  @Post('mot-de-passe')
  async updatePassword(
    @Headers('authorization') authorization: string | undefined,
    @Body() input: UpdatePasswordWithRecoveryDto,
  ) {
    return this.recovery.updatePassword(
      await this.requireEmployee(authorization),
      input.proofToken,
      input.newPassword,
    );
  }

  @Post('changement-email/code-recuperation')
  async requestEmailChangeRecoveryCode(@Headers('authorization') authorization?: string) {
    return this.recovery.requestActionCode(
      await this.requireEligibleUser(authorization),
      'email_change_recovery',
    );
  }

  @Post('changement-email/code-recuperation/verification')
  async verifyEmailChangeRecoveryCode(
    @Headers('authorization') authorization: string | undefined,
    @Body() input: VerifyRecoveryCodeDto,
  ) {
    return this.recovery.verifyActionCode(
      await this.requireEligibleUser(authorization),
      'email_change_recovery',
      input.challengeId,
      input.code,
    );
  }

  @Post('changement-email/nouvelle-adresse')
  async requestNewEmailCode(
    @Headers('authorization') authorization: string | undefined,
    @Body() input: RequestEmailChangeWithRecoveryDto,
  ) {
    return this.recovery.requestNewEmailCode(
      await this.requireEligibleUser(authorization),
      input.proofToken,
      input.newEmail,
    );
  }

  @Post('changement-email/nouvelle-adresse/verification')
  async verifyNewEmailCode(
    @Headers('authorization') authorization: string | undefined,
    @Body() input: VerifyEmailChangeWithRecoveryDto,
  ) {
    return this.recovery.verifyNewEmailCode(
      await this.requireEligibleUser(authorization),
      input.recoveryProofToken,
      input.challengeId,
      input.code,
    );
  }

  @Post('changement-email/appliquer')
  async applyEmailChange(
    @Headers('authorization') authorization: string | undefined,
    @Body() input: RecoveryProofDto,
  ) {
    return this.recovery.updateEmail(await this.requireEligibleUser(authorization), input.proofToken);
  }

  private async requireEligibleUser(authorization?: string): Promise<RequestIdentity> {
    const identity = await this.auth.requireUser(authorization);
    if (adminRoles.has(String(identity.user.app_metadata.inox_admin_role))) {
      return this.auth.requireAdmin(authorization);
    }
    return identity;
  }

  private async requireEmployee(authorization?: string): Promise<RequestIdentity> {
    const identity = await this.auth.requireUser(authorization);
    if (adminRoles.has(String(identity.user.app_metadata.inox_admin_role))) {
      throw new ForbiddenException('OTP_ADMINISTRATEUR_REQUIS');
    }
    return identity;
  }
}
