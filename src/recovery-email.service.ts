import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import type { RequestIdentity } from './auth.service';
import { InfrastructureService } from './infrastructure.service';

type RecoveryPurpose = 'verify_contact' | 'password_reset' | 'email_change_recovery' | 'email_change_target';
type ProofPurpose = 'password_reset' | 'email_change_recovery' | 'email_change_final';
type ChallengeResult = {
  status: 'verified' | 'invalid' | 'used' | 'expired' | 'locked';
  destination_ciphertext: string | null;
  destination_hash: string | null;
};

@Injectable()
export class RecoveryEmailService {
  private transporter?: Transporter;

  constructor(private readonly infrastructure: InfrastructureService) {}

  async status(identity: RequestIdentity) {
    const { data, error } = await this.infrastructure
      .getSupabaseClient()
      .from('recovery_email_contacts')
      .select('email_masked,verified_at,available_after')
      .eq('user_id', identity.user.id)
      .maybeSingle();
    if (error) throw new InternalServerErrorException('ADRESSE_RECUPERATION_INDISPONIBLE');

    return {
      primaryEmail: identity.user.email ?? null,
      recoveryEmail: data?.email_masked ?? null,
      verified: Boolean(data?.verified_at),
      availableAfter: data?.available_after ?? null,
      inCooldown: Boolean(data?.available_after && new Date(data.available_after).getTime() > Date.now()),
      configuration: this.configuration(),
    };
  }

  async requestContactVerification(identity: RequestIdentity, requestedEmail: string) {
    this.assertAvailable();
    const email = this.normalizeEmail(requestedEmail);
    if (email === this.normalizeEmail(identity.user.email ?? '')) {
      throw new ConflictException('EMAIL_RECUPERATION_IDENTIQUE');
    }
    if (await this.primaryEmailExists(email, identity.user.id)) {
      throw new ConflictException('EMAIL_RECUPERATION_DEJA_UTILISE');
    }

    await this.enforceRateLimit(identity.user.id, 'verify-contact', 5, 15 * 60);
    const hash = this.emailHash(email);
    const { data: existing } = await this.infrastructure
      .getSupabaseClient()
      .from('recovery_email_contacts')
      .select('user_id')
      .eq('email_hash', hash)
      .neq('user_id', identity.user.id)
      .maybeSingle();
    if (existing) throw new ConflictException('EMAIL_RECUPERATION_DEJA_UTILISE');

    return this.createAndSendChallenge(identity.user.id, 'verify_contact', email);
  }

  async verifyContact(identity: RequestIdentity, challengeId: string, code: string) {
    this.assertAvailable();
    const result = await this.consumeChallenge(identity.user.id, 'verify_contact', challengeId, code);
    if (result.status !== 'verified' || !result.destination_ciphertext || !result.destination_hash) {
      this.throwChallengeError(result.status);
    }

    const email = this.decrypt(result.destination_ciphertext);
    const availableAfter = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const now = new Date().toISOString();
    const { error } = await this.infrastructure.getSupabaseClient().from('recovery_email_contacts').upsert({
      user_id: identity.user.id,
      email_ciphertext: result.destination_ciphertext,
      email_hash: result.destination_hash,
      email_masked: this.maskEmail(email),
      verified_at: now,
      available_after: availableAfter,
      updated_at: now,
    });
    if (error?.code === '23505') throw new ConflictException('EMAIL_RECUPERATION_DEJA_UTILISE');
    if (error) throw new InternalServerErrorException('VERIFICATION_EMAIL_RECUPERATION_ECHOUEE');

    await this.audit(identity.user.id, 'recovery_email.verified', {
      recoveryEmail: this.maskEmail(email),
      availableAfter,
    });
    return { verified: true, recoveryEmail: this.maskEmail(email), availableAfter };
  }

  async requestActionCode(identity: RequestIdentity, purpose: 'password_reset' | 'email_change_recovery') {
    this.assertAvailable();
    await this.enforceRateLimit(identity.user.id, `action-${purpose}`, 5, 15 * 60);
    const { data, error } = await this.infrastructure
      .getSupabaseClient()
      .from('recovery_email_contacts')
      .select('email_ciphertext,verified_at,available_after')
      .eq('user_id', identity.user.id)
      .maybeSingle();
    if (error) throw new InternalServerErrorException('ADRESSE_RECUPERATION_INDISPONIBLE');
    if (!data?.verified_at) throw new ForbiddenException('ADRESSE_RECUPERATION_REQUISE');
    if (new Date(data.available_after).getTime() > Date.now()) {
      throw new ForbiddenException('ADRESSE_RECUPERATION_EN_ATTENTE');
    }
    return this.createAndSendChallenge(identity.user.id, purpose, this.decrypt(data.email_ciphertext));
  }

  async verifyActionCode(
    identity: RequestIdentity,
    purpose: 'password_reset' | 'email_change_recovery',
    challengeId: string,
    code: string,
  ) {
    this.assertAvailable();
    const result = await this.consumeChallenge(identity.user.id, purpose, challengeId, code);
    if (result.status !== 'verified') this.throwChallengeError(result.status);

    const token = randomBytes(32).toString('base64url');
    const proofLifetimeSeconds = purpose === 'email_change_recovery' ? 15 * 60 : 5 * 60;
    const { error } = await this.infrastructure.getSupabaseClient().from('recovery_email_proofs').insert({
      user_id: identity.user.id,
      purpose,
      token_digest: this.digest(`proof:${purpose}`, token),
      expires_at: new Date(Date.now() + proofLifetimeSeconds * 1000).toISOString(),
    });
    if (error) throw new InternalServerErrorException('PREUVE_RECUPERATION_ECHOUEE');
    return { proofToken: token, expiresInSeconds: proofLifetimeSeconds };
  }

  async requestNewEmailCode(identity: RequestIdentity, recoveryProofToken: string, requestedEmail: string) {
    this.assertAvailable();
    if (!(await this.proofExists(identity.user.id, 'email_change_recovery', recoveryProofToken))) {
      throw new ForbiddenException('PREUVE_RECUPERATION_INVALIDE_OU_EXPIREE');
    }
    const email = this.normalizeEmail(requestedEmail);
    if (email === this.normalizeEmail(identity.user.email ?? '')) throw new ConflictException('EMAIL_IDENTIQUE');
    if (this.isAdministrator(identity) && !email.endsWith('@inox.ci')) {
      throw new BadRequestException('EMAIL_ADMINISTRATEUR_INOX_REQUIS');
    }
    if (await this.primaryEmailExists(email, identity.user.id)) throw new ConflictException('EMAIL_DEJA_UTILISE');
    const { data: recoveryContact } = await this.infrastructure
      .getSupabaseClient()
      .from('recovery_email_contacts')
      .select('email_hash')
      .eq('user_id', identity.user.id)
      .maybeSingle();
    if (recoveryContact?.email_hash === this.emailHash(email)) {
      throw new ConflictException('EMAIL_IDENTIQUE_ADRESSE_RECUPERATION');
    }
    await this.enforceRateLimit(identity.user.id, 'email-change-target', 5, 15 * 60);
    return this.createAndSendChallenge(identity.user.id, 'email_change_target', email);
  }

  async verifyNewEmailCode(
    identity: RequestIdentity,
    recoveryProofToken: string,
    challengeId: string,
    code: string,
  ) {
    this.assertAvailable();
    const challenge = await this.consumeChallenge(identity.user.id, 'email_change_target', challengeId, code);
    if (challenge.status !== 'verified' || !challenge.destination_ciphertext) {
      this.throwChallengeError(challenge.status);
    }
    const supabase = this.infrastructure.getSupabaseClient();
    const { data: recoveryProof, error: proofError } = await supabase.rpc('consume_recovery_email_proof', {
      p_user_id: identity.user.id,
      p_purpose: 'email_change_recovery',
      p_token_digest: this.digest('proof:email_change_recovery', recoveryProofToken),
    });
    if (proofError) throw new InternalServerErrorException('VALIDATION_PREUVE_RECUPERATION_ECHOUEE');
    if (recoveryProof !== true) throw new ForbiddenException('PREUVE_RECUPERATION_INVALIDE_OU_EXPIREE');

    const token = randomBytes(32).toString('base64url');
    const { error } = await supabase.from('recovery_email_proofs').insert({
      user_id: identity.user.id,
      purpose: 'email_change_final',
      token_digest: this.digest('proof:email_change_final', token),
      payload_ciphertext: challenge.destination_ciphertext,
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    if (error) throw new InternalServerErrorException('PREUVE_CHANGEMENT_EMAIL_ECHOUEE');
    return { proofToken: token, expiresInSeconds: 300 };
  }

  async updateEmail(identity: RequestIdentity, proofToken: string) {
    this.assertAvailable();
    const supabase = this.infrastructure.getSupabaseClient();
    const { data, error } = await supabase.rpc('consume_recovery_email_payload_proof', {
      p_user_id: identity.user.id,
      p_purpose: 'email_change_final',
      p_token_digest: this.digest('proof:email_change_final', proofToken),
    });
    if (error) throw new InternalServerErrorException('VALIDATION_PREUVE_CHANGEMENT_EMAIL_ECHOUEE');
    if (typeof data !== 'string' || !data) throw new ForbiddenException('PREUVE_RECUPERATION_INVALIDE_OU_EXPIREE');
    const newEmail = this.normalizeEmail(this.decrypt(data));
    if (this.isAdministrator(identity) && !newEmail.endsWith('@inox.ci')) {
      throw new BadRequestException('EMAIL_ADMINISTRATEUR_INOX_REQUIS');
    }
    if (await this.primaryEmailExists(newEmail, identity.user.id)) throw new ConflictException('EMAIL_DEJA_UTILISE');

    const oldEmail = identity.user.email ?? '';
    const { error: updateError } = await supabase.auth.admin.updateUserById(identity.user.id, {
      email: newEmail,
      email_confirm: true,
    });
    if (updateError) throw new BadRequestException('MISE_A_JOUR_EMAIL_ECHOUEE');
    await this.audit(identity.user.id, 'email.updated_via_recovery_email', {
      oldEmail: this.maskEmail(oldEmail),
      newEmail: this.maskEmail(newEmail),
    });
    if (oldEmail) void this.sendSecurityNotice(oldEmail, newEmail).catch(() => undefined);
    await supabase.auth.admin.signOut(identity.accessToken, 'global');
    return { updated: true, signedOut: true, email: this.maskEmail(newEmail) };
  }

  async updatePassword(identity: RequestIdentity, proofToken: string, newPassword: string) {
    this.assertAvailable();
    const { data, error } = await this.infrastructure.getSupabaseClient().rpc('consume_recovery_email_proof', {
      p_user_id: identity.user.id,
      p_purpose: 'password_reset',
      p_token_digest: this.digest('proof:password_reset', proofToken),
    });
    if (error) throw new InternalServerErrorException('VALIDATION_PREUVE_RECUPERATION_ECHOUEE');
    if (data !== true) throw new ForbiddenException('PREUVE_RECUPERATION_INVALIDE_OU_EXPIREE');

    const supabase = this.infrastructure.getSupabaseClient();
    const { error: updateError } = await supabase.auth.admin.updateUserById(identity.user.id, {
      password: newPassword,
    });
    if (updateError) throw new BadRequestException('MISE_A_JOUR_MOT_DE_PASSE_ECHOUEE');
    await this.audit(identity.user.id, 'password.updated_via_recovery_email', {});
    await supabase.auth.admin.signOut(identity.accessToken, 'global');
    return { updated: true, signedOut: true };
  }

  configuration() {
    const available = Boolean(this.secret() && this.smtpConfiguration());
    return {
      available,
      required: available && process.env.RECOVERY_EMAIL_REQUIRED === 'true',
    };
  }

  private async createAndSendChallenge(userId: string, purpose: RecoveryPurpose, email: string) {
    const code = randomInt(0, 100_000_000).toString().padStart(8, '0');
    const encrypted = this.encrypt(email);
    const hash = this.emailHash(email);
    const supabase = this.infrastructure.getSupabaseClient();
    await supabase
      .from('recovery_email_challenges')
      .update({ consumed_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('purpose', purpose)
      .is('consumed_at', null);

    const { data, error } = await supabase
      .from('recovery_email_challenges')
      .insert({
        user_id: userId,
        purpose,
        destination_ciphertext: encrypted,
        destination_hash: hash,
        code_digest: this.digest(`code:${purpose}`, code),
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      })
      .select('id,expires_at')
      .single();
    if (error || !data) throw new InternalServerErrorException('CREATION_CODE_RECUPERATION_ECHOUEE');

    try {
      await this.sendCode(email, code, purpose);
    } catch {
      await supabase.from('recovery_email_challenges').delete().eq('id', data.id);
      throw new ServiceUnavailableException('ENVOI_EMAIL_RECUPERATION_ECHOUE');
    }
    return { challengeId: data.id, expiresAt: data.expires_at, destination: this.maskEmail(email) };
  }

  private async consumeChallenge(
    userId: string,
    purpose: RecoveryPurpose,
    challengeId: string,
    code: string,
  ): Promise<ChallengeResult> {
    const { data, error } = await this.infrastructure.getSupabaseClient().rpc('consume_recovery_email_challenge', {
      p_id: challengeId,
      p_user_id: userId,
      p_purpose: purpose,
      p_code_digest: this.digest(`code:${purpose}`, code),
    });
    if (error || !Array.isArray(data) || !data[0]) {
      throw new InternalServerErrorException('VALIDATION_CODE_RECUPERATION_ECHOUEE');
    }
    return data[0] as ChallengeResult;
  }

  private throwChallengeError(status: ChallengeResult['status']): never {
    if (status === 'expired') throw new ForbiddenException('CODE_RECUPERATION_EXPIRE');
    if (status === 'used') throw new ForbiddenException('CODE_RECUPERATION_DEJA_UTILISE');
    if (status === 'locked') throw new HttpException('CODE_RECUPERATION_BLOQUE', HttpStatus.TOO_MANY_REQUESTS);
    throw new BadRequestException('CODE_RECUPERATION_INVALIDE');
  }

  private async enforceRateLimit(userId: string, action: string, limit: number, ttlSeconds: number) {
    try {
      const redis = await this.infrastructure.getRedisClient();
      const key = `recovery-email:${action}:${userId}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, ttlSeconds);
      if (count > limit) throw new HttpException('TROP_DE_DEMANDES_EMAIL_RECUPERATION', HttpStatus.TOO_MANY_REQUESTS);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) throw error;
      throw new ServiceUnavailableException('PROTECTION_EMAIL_RECUPERATION_INDISPONIBLE');
    }
  }

  private async primaryEmailExists(email: string, ownUserId: string) {
    const supabase = this.infrastructure.getSupabaseClient();
    for (let page = 1; page <= 20; page += 1) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw new InternalServerErrorException('VERIFICATION_UNICITE_EMAIL_ECHOUEE');
      if (data.users.some((user) => user.id !== ownUserId && this.normalizeEmail(user.email ?? '') === email)) return true;
      if (data.users.length < 1000) return false;
    }
    throw new InternalServerErrorException('VERIFICATION_UNICITE_EMAIL_INCOMPLETE');
  }

  private async sendCode(email: string, code: string, purpose: RecoveryPurpose) {
    const smtp = this.smtpConfiguration();
    if (!smtp) throw new Error('SMTP_MISSING');
    this.transporter ??= nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
    });
    const subject = purpose === 'verify_contact'
      ? 'Vérification de votre adresse de récupération INOX.techs Pointage'
      : purpose === 'password_reset'
        ? 'Code de réinitialisation INOX.techs Pointage'
        : purpose === 'email_change_recovery'
          ? 'Confirmation de récupération INOX.techs Pointage'
          : 'Vérification de votre nouvelle adresse INOX.techs Pointage';
    const action = purpose === 'verify_contact'
      ? 'confirmer cette adresse comme adresse de récupération'
      : purpose === 'password_reset'
        ? 'autoriser la réinitialisation de votre mot de passe'
        : purpose === 'email_change_recovery'
          ? 'confirmer que vous utilisez votre adresse de récupération'
          : 'confirmer votre nouvelle adresse de connexion';
    await this.transporter.sendMail({
      from: smtp.from,
      to: email,
      subject,
      text: `Votre code est ${code}. Il permet de ${action}. Il expire dans 15 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.`,
      html: `<p>Utilisez le code suivant pour ${action} :</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>Ce code expire dans 15 minutes et ne peut être utilisé qu'une fois.</p><p>Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.</p>`,
    });
  }

  private async sendSecurityNotice(oldEmail: string, newEmail: string) {
    const smtp = this.smtpConfiguration();
    if (!smtp) return;
    this.transporter ??= nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
    });
    await this.transporter.sendMail({
      from: smtp.from,
      to: oldEmail,
      subject: 'Votre adresse de connexion INOX.techs Pointage a été modifiée',
      text: `Votre adresse de connexion a été remplacée par ${this.maskEmail(newEmail)} après validation de votre adresse de récupération et de la nouvelle adresse. Si vous n'êtes pas à l'origine de cette action, contactez immédiatement l'administration INOX.`,
    });
  }

  private async proofExists(userId: string, purpose: ProofPurpose, token: string) {
    const { data, error } = await this.infrastructure
      .getSupabaseClient()
      .from('recovery_email_proofs')
      .select('id')
      .eq('user_id', userId)
      .eq('purpose', purpose)
      .eq('token_digest', this.digest(`proof:${purpose}`, token))
      .is('consumed_at', null)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (error) throw new InternalServerErrorException('VALIDATION_PREUVE_RECUPERATION_ECHOUEE');
    return Boolean(data);
  }

  private isAdministrator(identity: RequestIdentity) {
    return ['owner', 'administrator', 'maintainer'].includes(String(identity.user.app_metadata.inox_admin_role));
  }

  private smtpConfiguration() {
    const host = process.env.RECOVERY_SMTP_HOST;
    const user = process.env.RECOVERY_SMTP_USER;
    const pass = process.env.RECOVERY_SMTP_PASS;
    const from = process.env.RECOVERY_SMTP_FROM;
    if (!host || !user || !pass || !from) return null;
    const port = Number(process.env.RECOVERY_SMTP_PORT ?? '465');
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return {
      host,
      user,
      pass,
      from,
      port,
      secure: process.env.RECOVERY_SMTP_SECURE !== 'false',
    };
  }

  private secret() {
    const value = process.env.RECOVERY_EMAIL_SECRET;
    if (!value) return null;
    const decoded = Buffer.from(value, 'base64');
    return decoded.length >= 32 ? decoded : null;
  }

  private assertAvailable() {
    if (!this.configuration().available) {
      throw new ServiceUnavailableException('SERVICE_EMAIL_RECUPERATION_INDISPONIBLE');
    }
  }

  private key(label: string) {
    const secret = this.secret();
    if (!secret) throw new ServiceUnavailableException('SERVICE_EMAIL_RECUPERATION_INDISPONIBLE');
    return createHmac('sha256', secret).update(label).digest();
  }

  private digest(context: string, value: string) {
    return createHmac('sha256', this.key(`hmac:${context}`)).update(value).digest('hex');
  }

  private emailHash(email: string) {
    return this.digest('email', this.normalizeEmail(email));
  }

  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key('encryption'), iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
  }

  private decrypt(value: string) {
    const [version, iv, tag, ciphertext] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('INVALID_CIPHERTEXT');
    const decipher = createDecipheriv('aes-256-gcm', this.key('encryption'), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  }

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  private maskEmail(email: string) {
    const [local, domain] = email.split('@');
    if (!local || !domain) return 'adresse masquée';
    return `${local.slice(0, 2)}${'*'.repeat(Math.max(2, Math.min(6, local.length - 2)))}@${domain}`;
  }

  private async audit(userId: string, action: string, details: Record<string, unknown>) {
    await this.infrastructure.getSupabaseClient().from('journaux_audit').insert({
      actor_user_id: userId,
      action,
      target_type: 'user',
      target_id: userId,
      details,
    });
  }
}
