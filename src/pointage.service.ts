import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { AuthService } from './auth.service';
import { InfrastructureService } from './infrastructure.service';
import type {
  ActivateTerminalDto,
  CreateEmployeeDto,
  CreateSiteDto,
  CreateTerminalDto,
  ScanDto,
} from './pointage.dto';

type EmployeeRow = {
  id: string;
  auth_user_id: string;
  matricule: string;
  display_name: string;
  site_id: string | null;
  active: boolean;
  sites?: { name: string; timezone: string } | null;
};

type TerminalRow = {
  id: string;
  name: string;
  site_id: string;
  active: boolean;
  session_expires_at: string | null;
  sites?: { name: string; timezone: string } | null;
};

@Injectable()
export class PointageService {
  constructor(
    private readonly infrastructure: InfrastructureService,
    private readonly auth: AuthService,
  ) {}

  async me(authorization?: string) {
    const identity = await this.auth.requireUser(authorization);
    const employee = await this.employeeForUser(identity.user.id);
    return { employee: this.publicEmployee(employee) };
  }

  async myAttendance(authorization?: string) {
    const identity = await this.auth.requireUser(authorization);
    const employee = await this.employeeForUser(identity.user.id);
    const { data, error } = await this.infrastructure
      .getSupabaseClient()
      .from('evenements_pointage')
      .select('id,event_type,occurred_at,sites(name),terminaux(name)')
      .eq('employe_id', employee.id)
      .order('occurred_at', { ascending: false })
      .limit(50);
    if (error) throw new InternalServerErrorException('POINTAGES_INDISPONIBLES');
    return { items: data ?? [] };
  }

  async createQr(authorization?: string) {
    const identity = await this.auth.requireUser(authorization);
    const employee = await this.employeeForUser(identity.user.id);
    if (!employee.site_id) throw new ConflictException('SITE_EMPLOYE_REQUIS');

    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.hash(token);
    const expiresInSeconds = 30;
    const now = new Date();
    try {
      const redis = await this.infrastructure.getRedisClient();
      await redis.set(
        `pointage:qr:${tokenHash}`,
        JSON.stringify({ employeeId: employee.id, siteId: employee.site_id }),
        { EX: expiresInSeconds, NX: true },
      );
    } catch {
      throw new ServiceUnavailableException('QR_TEMPORAIRE_INDISPONIBLE');
    }

    return {
      payload: `inox-presence:v1:${token}`,
      expiresAt: new Date(now.getTime() + expiresInSeconds * 1_000).toISOString(),
      serverTime: now.toISOString(),
    };
  }

  async adminSummary(authorization?: string) {
    await this.auth.requireAdmin(authorization);
    const supabase = this.infrastructure.getSupabaseClient();
    const today = new Date().toISOString().slice(0, 10);
    const start = `${today}T00:00:00.000Z`;
    const [employees, events, sites, terminals] = await Promise.all([
      supabase.from('employes').select('*', { count: 'exact', head: true }).eq('active', true),
      supabase.from('evenements_pointage').select('*', { count: 'exact', head: true }).gte('occurred_at', start),
      supabase.from('sites').select('*', { count: 'exact', head: true }).eq('active', true),
      supabase.from('terminaux').select('*', { count: 'exact', head: true }).eq('active', true),
    ]);
    if (employees.error || events.error || sites.error || terminals.error) {
      throw new InternalServerErrorException('TABLEAU_DE_BORD_INDISPONIBLE');
    }
    return {
      period: today,
      activeEmployees: employees.count ?? 0,
      attendanceEvents: events.count ?? 0,
      activeSites: sites.count ?? 0,
      activeTerminals: terminals.count ?? 0,
    };
  }

  async listSites(authorization?: string) {
    await this.auth.requireAdmin(authorization);
    const { data, error } = await this.infrastructure
      .getSupabaseClient()
      .from('sites')
      .select('id,name,timezone,active,created_at')
      .order('name');
    if (error) throw new InternalServerErrorException('SITES_INDISPONIBLES');
    return { items: data ?? [] };
  }

  async createSite(authorization: string | undefined, input: CreateSiteDto) {
    const identity = await this.auth.requireAdmin(authorization);
    const name = input.name.trim();
    const { data, error } = await this.infrastructure
      .getSupabaseClient()
      .from('sites')
      .insert({ name })
      .select('id,name,timezone,active,created_at')
      .single();
    if (error?.code === '23505') throw new ConflictException('SITE_DEJA_EXISTANT');
    if (error || !data) throw new BadRequestException('CREATION_SITE_ECHOUEE');
    await this.audit(identity.user.id, 'site.created', 'site', data.id, { name });
    return { site: data };
  }

  async listEmployees(authorization?: string) {
    await this.auth.requireAdmin(authorization);
    const { data, error } = await this.infrastructure
      .getSupabaseClient()
      .from('employes')
      .select('id,matricule,display_name,active,created_at,sites(name)')
      .order('display_name');
    if (error) throw new InternalServerErrorException('EMPLOYES_INDISPONIBLES');
    return { items: data ?? [] };
  }

  async createEmployee(authorization: string | undefined, input: CreateEmployeeDto) {
    const identity = await this.auth.requireAdmin(authorization);
    const supabase = this.infrastructure.getSupabaseClient();
    const email = input.email.trim().toLowerCase();
    const displayName = input.displayName.trim();
    const matricule = input.matricule.trim().toUpperCase();
    const { data: site } = await supabase.from('sites').select('id').eq('id', input.siteId).eq('active', true).maybeSingle();
    if (!site) throw new BadRequestException('SITE_INVALIDE');

    const { data: invite, error: inviteError } = await supabase.auth.admin.generateLink({
      type: 'invite',
      email,
      options: { data: { display_name: displayName } },
    });
    if (inviteError || !invite.user || !invite.properties?.hashed_token) {
      throw new BadRequestException('INVITATION_EMPLOYE_ECHOUEE');
    }
    const { data: employee, error } = await supabase
      .from('employes')
      .insert({ auth_user_id: invite.user.id, matricule, display_name: displayName, site_id: input.siteId })
      .select('id,matricule,display_name,active,created_at,sites(name)')
      .single();
    if (error || !employee) {
      await supabase.auth.admin.deleteUser(invite.user.id);
      if (error?.code === '23505') throw new ConflictException('EMPLOYE_DEJA_EXISTANT');
      throw new BadRequestException('CREATION_EMPLOYE_ECHOUEE');
    }
    await this.audit(identity.user.id, 'employee.created', 'employee', employee.id, { matricule });
    return { employee, invitationTokenHash: invite.properties.hashed_token };
  }

  async listAttendance(authorization?: string) {
    await this.auth.requireAdmin(authorization);
    const { data, error } = await this.infrastructure
      .getSupabaseClient()
      .from('evenements_pointage')
      .select('id,event_type,occurred_at,employes(display_name,matricule),sites(name),terminaux(name)')
      .order('occurred_at', { ascending: false })
      .limit(100);
    if (error) throw new InternalServerErrorException('PRESENCES_INDISPONIBLES');
    return { items: data ?? [] };
  }

  async listTerminals(authorization?: string) {
    await this.auth.requireAdmin(authorization);
    const { data, error } = await this.infrastructure
      .getSupabaseClient()
      .from('terminaux')
      .select('id,name,active,last_seen_at,session_expires_at,sites(name)')
      .order('name');
    if (error) throw new InternalServerErrorException('TERMINAUX_INDISPONIBLES');
    return { items: data ?? [] };
  }

  async createTerminal(authorization: string | undefined, input: CreateTerminalDto) {
    const identity = await this.auth.requireAdmin(authorization);
    const code = randomBytes(6).toString('hex').toUpperCase();
    const activationExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const { data, error } = await this.infrastructure
      .getSupabaseClient()
      .from('terminaux')
      .insert({
        name: input.name.trim(),
        site_id: input.siteId,
        activation_code_hash: this.hash(code),
        activation_expires_at: activationExpiresAt,
      })
      .select('id,name,active,created_at,sites(name)')
      .single();
    if (error || !data) throw new BadRequestException('CREATION_TERMINAL_ECHOUEE');
    await this.audit(identity.user.id, 'terminal.created', 'terminal', data.id, { siteId: input.siteId });
    return { terminal: data, activationCode: code, activationExpiresAt };
  }

  async activateTerminal(input: ActivateTerminalDto) {
    const codeHash = this.hash(input.code.trim().toUpperCase());
    const supabase = this.infrastructure.getSupabaseClient();
    const { data: terminal, error } = await supabase
      .from('terminaux')
      .select('id,name,site_id,active,activation_expires_at,sites(name,timezone)')
      .eq('activation_code_hash', codeHash)
      .maybeSingle();
    if (error || !terminal) throw new UnauthorizedException('CODE_ACTIVATION_INVALIDE');
    if (!terminal.active) throw new ForbiddenException('TERMINAL_DESACTIVE');
    if (!terminal.activation_expires_at || new Date(terminal.activation_expires_at).getTime() <= Date.now()) {
      throw new GoneException('CODE_ACTIVATION_EXPIRE');
    }
    const sessionToken = randomBytes(32).toString('base64url');
    const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
    const { error: updateError } = await supabase
      .from('terminaux')
      .update({
        activation_code_hash: null,
        activation_expires_at: null,
        session_token_hash: this.hash(sessionToken),
        session_expires_at: sessionExpiresAt,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', terminal.id);
    if (updateError) throw new InternalServerErrorException('ACTIVATION_TERMINAL_ECHOUEE');
    return {
      sessionToken,
      sessionExpiresAt,
      terminal: { id: terminal.id, name: terminal.name, site: terminal.sites },
    };
  }

  async terminalSession(authorization?: string) {
    const terminal = await this.requireTerminal(authorization);
    return { terminal: { id: terminal.id, name: terminal.name, site: terminal.sites } };
  }

  async scan(authorization: string | undefined, input: ScanDto) {
    const terminal = await this.requireTerminal(authorization);
    const prefix = 'inox-presence:v1:';
    if (!input.qrPayload.startsWith(prefix)) throw new BadRequestException('QR_INVALIDE');
    const rawToken = input.qrPayload.slice(prefix.length);
    if (rawToken.length < 32 || rawToken.length > 100) throw new BadRequestException('QR_INVALIDE');
    const tokenHash = this.hash(rawToken);
    let qrValue: string | null;
    try {
      qrValue = await (await this.infrastructure.getRedisClient()).getDel(`pointage:qr:${tokenHash}`);
    } catch {
      throw new ServiceUnavailableException('VERIFICATION_QR_INDISPONIBLE');
    }
    if (!qrValue) throw new GoneException('QR_EXPIRE_OU_DEJA_UTILISE');

    const qr = JSON.parse(qrValue) as { employeeId?: string; siteId?: string };
    if (!qr.employeeId || qr.siteId !== terminal.site_id) throw new ForbiddenException('QR_SITE_REFUSE');
    const supabase = this.infrastructure.getSupabaseClient();
    const { data: employee } = await supabase
      .from('employes')
      .select('id,active')
      .eq('id', qr.employeeId)
      .maybeSingle();
    if (!employee?.active) throw new ForbiddenException('EMPLOYE_INACTIF');
    const { data: last } = await supabase
      .from('evenements_pointage')
      .select('event_type')
      .eq('employe_id', qr.employeeId)
      .order('occurred_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const eventType = last?.event_type === 'entree' ? 'sortie' : 'entree';
    const occurredAt = new Date().toISOString();
    const { data: event, error } = await supabase
      .from('evenements_pointage')
      .insert({
        employe_id: qr.employeeId,
        terminal_id: terminal.id,
        site_id: terminal.site_id,
        event_type: eventType,
        occurred_at: occurredAt,
        qr_token_hash: tokenHash,
        idempotency_key: input.idempotencyKey,
      })
      .select('id,event_type,occurred_at')
      .single();
    if (error?.code === '23505') throw new ConflictException('POINTAGE_DEJA_TRAITE');
    if (error || !event) throw new InternalServerErrorException('POINTAGE_NON_CONFIRME');
    return { event };
  }

  private async employeeForUser(userId: string): Promise<EmployeeRow> {
    const { data, error } = await this.infrastructure
      .getSupabaseClient()
      .from('employes')
      .select('id,auth_user_id,matricule,display_name,site_id,active,sites(name,timezone)')
      .eq('auth_user_id', userId)
      .maybeSingle();
    if (error) throw new InternalServerErrorException('PROFIL_EMPLOYE_INDISPONIBLE');
    if (!data) throw new NotFoundException('PROFIL_EMPLOYE_ABSENT');
    if (!data.active) throw new ForbiddenException('COMPTE_EMPLOYE_INACTIF');
    return data as unknown as EmployeeRow;
  }

  private publicEmployee(employee: EmployeeRow) {
    return {
      id: employee.id,
      matricule: employee.matricule,
      displayName: employee.display_name,
      site: employee.sites,
    };
  }

  private async requireTerminal(authorization?: string): Promise<TerminalRow> {
    const [scheme, token] = authorization?.split(' ') ?? [];
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw new UnauthorizedException('TERMINAL_NON_ACTIVE');
    const { data, error } = await this.infrastructure
      .getSupabaseClient()
      .from('terminaux')
      .select('id,name,site_id,active,session_expires_at,sites(name,timezone)')
      .eq('session_token_hash', this.hash(token))
      .maybeSingle();
    if (error || !data) throw new UnauthorizedException('SESSION_TERMINAL_INVALIDE');
    if (!data.active) throw new ForbiddenException('TERMINAL_DESACTIVE');
    if (!data.session_expires_at || new Date(data.session_expires_at).getTime() <= Date.now()) {
      throw new UnauthorizedException('SESSION_TERMINAL_EXPIREE');
    }
    void this.infrastructure.getSupabaseClient().from('terminaux').update({ last_seen_at: new Date().toISOString() }).eq('id', data.id);
    return data as unknown as TerminalRow;
  }

  private async audit(actorUserId: string, action: string, targetType: string, targetId: string, details: Record<string, unknown>) {
    await this.infrastructure.getSupabaseClient().from('journaux_audit').insert({
      actor_user_id: actorUserId,
      action,
      target_type: targetType,
      target_id: targetId,
      details,
    });
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
}
