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
import { isMatriculeFor, nextAvailableMatricule, normalizeMatricule, parseHiringDate } from './matricule';
import { RealtimeService } from './realtime.service';
import type {
  ActivateTerminalDto,
  CreateAdministratorDto,
  CreateEmployeeDto,
  CreateSiteDto,
  CreateTerminalDto,
  ScanDto,
  UpdateAdministratorRoleDto,
  UpdateAdministratorMatriculeDto,
  UpdateAttendanceDto,
  UpdateEmployeeStatusDto,
  UpdateEmployeeMatriculeDto,
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

type CreatedEmployeeRow = {
  id: string;
  matricule: string;
  hired_at: string;
  display_name: string;
  active: boolean;
  created_at: string;
  sites: { name: string } | null;
};

type TerminalRow = {
  id: string;
  name: string;
  site_id: string;
  active: boolean;
  session_expires_at: string | null;
  sites?: { name: string; timezone: string } | null;
};

type AttendanceTrafficDay = {
  date: string;
  start: string;
  end: string;
};

@Injectable()
export class PointageService {
  constructor(
    private readonly infrastructure: InfrastructureService,
    private readonly auth: AuthService,
    private readonly realtime: RealtimeService,
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

  async confirmEmployeeActivation(authorization?: string) {
    const identity = await this.auth.requireUser(authorization);
    const employee = await this.employeeForUser(identity.user.id);
    if (identity.user.app_metadata.inox_employee_invitation_pending !== true) {
      return { activated: true };
    }

    const { error } = await this.infrastructure.getSupabaseClient().auth.admin.updateUserById(identity.user.id, {
      app_metadata: {
        ...identity.user.app_metadata,
        inox_employee_invitation_pending: false,
      },
    });
    if (error) throw new InternalServerErrorException('ACTIVATION_EMPLOYE_ECHOUEE');

    await this.audit(identity.user.id, 'employee.activated', 'employee', employee.id, {
      matricule: employee.matricule,
    });
    await this.realtime.publish({ type: 'employee.updated', employeeId: employee.id });
    return { activated: true };
  }

  async employeeEvents(authorization?: string) {
    const identity = await this.auth.requireUser(authorization);
    const employee = await this.employeeForUser(identity.user.id);
    return this.realtime.stream((event) => event.employeeId === employee.id);
  }

  async adminEvents(authorization?: string) {
    await this.auth.requireAdmin(authorization);
    return this.realtime.stream(() => true);
  }

  async terminalEvents(authorization?: string) {
    const terminal = await this.requireTerminal(authorization);
    return this.realtime.stream(
      (event) => event.type === 'terminal.session_revoked' && event.terminalId === terminal.id,
    );
  }

  async adminSummary(authorization?: string) {
    await this.auth.requireAdmin(authorization);
    const supabase = this.infrastructure.getSupabaseClient();
    const generatedAt = new Date();
    const trafficDays = this.attendanceTrafficDays(generatedAt, 7);
    const trafficRequests = trafficDays.flatMap((day) => [
      supabase
        .from('evenements_pointage')
        .select('id', { count: 'exact', head: true })
        .eq('event_type', 'entree')
        .gte('occurred_at', day.start)
        .lt('occurred_at', day.end),
      supabase
        .from('evenements_pointage')
        .select('id', { count: 'exact', head: true })
        .eq('event_type', 'sortie')
        .gte('occurred_at', day.start)
        .lt('occurred_at', day.end),
    ]);
    const [employees, sites, terminals, ...trafficCounts] = await Promise.all([
      supabase.from('employes').select('*', { count: 'exact', head: true }).eq('active', true),
      supabase.from('sites').select('*', { count: 'exact', head: true }).eq('active', true),
      supabase.from('terminaux').select('*', { count: 'exact', head: true }).eq('active', true),
      ...trafficRequests,
    ]);
    if (employees.error || sites.error || terminals.error || trafficCounts.some((result) => result.error)) {
      throw new InternalServerErrorException('TABLEAU_DE_BORD_INDISPONIBLE');
    }
    const traffic = trafficDays.map((day, index) => {
      const entries = trafficCounts[index * 2]?.count ?? 0;
      const exits = trafficCounts[index * 2 + 1]?.count ?? 0;
      return { date: day.date, entries, exits, total: entries + exits };
    });
    const today = traffic.at(-1);
    return {
      period: today?.date ?? generatedAt.toISOString().slice(0, 10),
      generatedAt: generatedAt.toISOString(),
      activeEmployees: employees.count ?? 0,
      attendanceEvents: today?.total ?? 0,
      activeSites: sites.count ?? 0,
      activeTerminals: terminals.count ?? 0,
      attendanceTraffic: {
        startDate: traffic[0]?.date ?? '',
        endDate: today?.date ?? '',
        days: traffic,
      },
    };
  }

  async listAdministrators(authorization?: string) {
    await this.auth.requireManager(authorization);
    const supabase = this.infrastructure.getSupabaseClient();
    const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) throw new InternalServerErrorException('ADMINISTRATEURS_INDISPONIBLES');

    const administrators = data.users.filter((user) => {
      const role = user.app_metadata.inox_admin_role;
      return role === 'owner' || role === 'administrator' || role === 'maintainer';
    });
    const items = await Promise.all(administrators.map(async (user) => {
      const metadata = user.app_metadata;
      const { data: factorData, error: factorError } = await supabase.auth.admin.mfa.listFactors({ userId: user.id });
      if (factorError) throw new InternalServerErrorException('ADMINISTRATEURS_INDISPONIBLES');
      const hasVerifiedFactor = factorData.factors.some((factor) => factor.status === 'verified');
      return {
        userId: user.id,
        email: user.email ?? 'Adresse indisponible',
        displayName: String(metadata.inox_admin_display_name || user.email?.split('@')[0] || 'Administrateur INOX'),
        matricule: String(metadata.inox_admin_matricule || 'Non attribué'),
        hiredAt: String(metadata.inox_admin_hired_at || user.created_at.slice(0, 10)),
        role: metadata.inox_admin_role as 'owner' | 'administrator' | 'maintainer',
        status: metadata.inox_admin_active !== true ? 'blocked' : hasVerifiedFactor ? 'active' : 'pending',
        createdAt: user.created_at,
      };
    }));
    items.sort((first, second) => first.displayName.localeCompare(second.displayName, 'fr'));
    return { items };
  }

  async createAdministrator(authorization: string | undefined, input: CreateAdministratorDto) {
    const identity = await this.auth.requireManager(authorization);
    const supabase = this.infrastructure.getSupabaseClient();
    const email = input.email.trim().toLowerCase();
    const displayName = input.displayName.trim();
    const hiringDate = this.validHiringDate(input.hiredAt);
    const requestedMatricule = normalizeMatricule(input.matricule);
    if (requestedMatricule && !isMatriculeFor(requestedMatricule, 'ADMIN', hiringDate.year)) {
      throw new BadRequestException('MATRICULE_ADMINISTRATEUR_INVALIDE');
    }
    const role = input.role;
    const { data: usersData, error: usersError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (usersError) {
      throw new InternalServerErrorException('VERIFICATION_ADMINISTRATEUR_ECHOUEE');
    }
    if (usersData.users.some((user) => user.email?.toLowerCase() === email)) {
      throw new ConflictException('EMAIL_DEJA_UTILISE');
    }
    let occupiedMatricules = usersData.users.map((user) => String(user.app_metadata.inox_admin_matricule || ''));
    if (requestedMatricule && occupiedMatricules.includes(requestedMatricule)) {
      throw new ConflictException('MATRICULE_DEJA_ATTRIBUE');
    }
    let matricule = requestedMatricule ?? nextAvailableMatricule('ADMIN', hiringDate.year, occupiedMatricules);

    const { data: invite, error: inviteError } = await supabase.auth.admin.generateLink({
      type: 'invite',
      email,
      options: { data: { display_name: displayName, invitation_type: 'administrator', administrator_role: role } },
    });
    if (inviteError || !invite.user || !invite.properties?.hashed_token) {
      throw new BadRequestException('INVITATION_ADMINISTRATEUR_ECHOUEE');
    }

    let administratorUpdated = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { error: updateError } = await supabase.auth.admin.updateUserById(invite.user.id, {
        app_metadata: {
          ...invite.user.app_metadata,
          inox_admin_active: true,
          inox_admin_role: role,
          inox_admin_display_name: displayName,
          inox_admin_matricule: matricule,
          inox_admin_hired_at: hiringDate.value,
          inox_admin_invited_by: identity.user.id,
          inox_admin_invitation_pending: true,
        },
      });
      if (!updateError) {
        administratorUpdated = true;
        break;
      }
      if (requestedMatricule) {
        const { data: refreshedUsers } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
        await supabase.auth.admin.deleteUser(invite.user.id);
        if (refreshedUsers?.users.some((user) => user.id !== invite.user.id && user.app_metadata.inox_admin_matricule === matricule)) {
          throw new ConflictException('MATRICULE_DEJA_ATTRIBUE');
        }
        throw new BadRequestException('INVITATION_ADMINISTRATEUR_ECHOUEE');
      }
      const { data: refreshedUsers, error: refreshError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (refreshError) break;
      occupiedMatricules = refreshedUsers.users.map((user) => String(user.app_metadata.inox_admin_matricule || ''));
      if (!occupiedMatricules.includes(matricule)) break;
      matricule = nextAvailableMatricule('ADMIN', hiringDate.year, occupiedMatricules);
    }
    if (!administratorUpdated) {
      await supabase.auth.admin.deleteUser(invite.user.id);
      throw new BadRequestException('INVITATION_ADMINISTRATEUR_ECHOUEE');
    }

    await this.audit(identity.user.id, 'administrator.invited', 'administrator', invite.user.id, {
      matricule,
      role,
    });
    return {
      invitationTokenHash: invite.properties.hashed_token,
      invitationType: 'invite',
      member: {
        userId: invite.user.id,
        email,
        displayName,
        matricule,
        hiredAt: hiringDate.value,
        role,
        status: 'pending',
        createdAt: invite.user.created_at,
      },
    };
  }

  async regenerateAdministratorInvitation(authorization: string | undefined, userId: string) {
    const identity = await this.auth.requireManager(authorization);
    const supabase = this.infrastructure.getSupabaseClient();
    const [{ data: userData, error: userError }, { data: factorData, error: factorError }] = await Promise.all([
      supabase.auth.admin.getUserById(userId),
      supabase.auth.admin.mfa.listFactors({ userId }),
    ]);
    const user = userData.user;
    if (userError || factorError) throw new InternalServerErrorException('VERIFICATION_ADMINISTRATEUR_ECHOUEE');
    if (!user || !['administrator', 'maintainer'].includes(String(user.app_metadata.inox_admin_role))) {
      throw new NotFoundException('ADMINISTRATEUR_INTROUVABLE');
    }
    if (user.app_metadata.inox_admin_active !== true) {
      throw new ConflictException('ADMINISTRATEUR_BLOQUE');
    }
    if (factorData.factors.some((factor) => factor.status === 'verified')) {
      throw new ConflictException('ADMINISTRATEUR_DEJA_ACTIVE');
    }
    if (!user.email) throw new BadRequestException('EMAIL_ADMINISTRATEUR_INDISPONIBLE');

    const { error: metadataError } = await supabase.auth.admin.updateUserById(user.id, {
      app_metadata: {
        ...user.app_metadata,
        inox_admin_invitation_pending: true,
        inox_admin_invited_by: identity.user.id,
      },
    });
    if (metadataError) throw new InternalServerErrorException('REGENERATION_INVITATION_ADMINISTRATEUR_ECHOUEE');

    const { data: link, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email: user.email,
    });
    if (linkError || !link.properties?.hashed_token) {
      throw new BadRequestException('REGENERATION_INVITATION_ADMINISTRATEUR_ECHOUEE');
    }

    await this.audit(identity.user.id, 'administrator.invitation.regenerated', 'administrator', user.id, {
      matricule: String(user.app_metadata.inox_admin_matricule || ''),
    });
    return {
      invitationTokenHash: link.properties.hashed_token,
      invitationType: 'recovery',
    };
  }

  async updateAdministratorRole(
    authorization: string | undefined,
    userId: string,
    input: UpdateAdministratorRoleDto,
  ) {
    const identity = await this.auth.requireManager(authorization);
    if (identity.user.id === userId) {
      throw new ForbiddenException('ROLE_PROPRE_COMPTE_PROTEGE');
    }

    const supabase = this.infrastructure.getSupabaseClient();
    const [{ data: userData, error: userError }, { data: factorData, error: factorError }] = await Promise.all([
      supabase.auth.admin.getUserById(userId),
      supabase.auth.admin.mfa.listFactors({ userId }),
    ]);
    const user = userData.user;
    if (userError || factorError) throw new InternalServerErrorException('MISE_A_JOUR_ROLE_ECHOUEE');
    if (!user || !['owner', 'administrator', 'maintainer'].includes(String(user.app_metadata.inox_admin_role))) {
      throw new NotFoundException('ADMINISTRATEUR_INTROUVABLE');
    }
    if (user.app_metadata.inox_admin_role === 'owner') {
      throw new ForbiddenException('PROPRIETAIRE_PROTEGE');
    }

    const previousRole = String(user.app_metadata.inox_admin_role);
    if (previousRole !== input.role) {
      const { data: updatedData, error: updateError } = await supabase.auth.admin.updateUserById(userId, {
        app_metadata: {
          ...user.app_metadata,
          inox_admin_role: input.role,
        },
      });
      if (updateError || !updatedData.user) {
        throw new InternalServerErrorException('MISE_A_JOUR_ROLE_ECHOUEE');
      }
      await this.audit(identity.user.id, 'administrator.role_updated', 'administrator', userId, {
        previousRole,
        role: input.role,
      });
      await this.realtime.publish({ type: 'administrator.updated' });
    }

    const hasVerifiedFactor = factorData.factors.some((factor) => factor.status === 'verified');
    return {
      member: {
        userId: user.id,
        email: user.email ?? 'Adresse indisponible',
        displayName: String(user.app_metadata.inox_admin_display_name || user.email?.split('@')[0] || 'Administrateur INOX'),
        matricule: String(user.app_metadata.inox_admin_matricule || 'Non attribué'),
        hiredAt: String(user.app_metadata.inox_admin_hired_at || user.created_at.slice(0, 10)),
        role: input.role,
        status: user.app_metadata.inox_admin_active !== true ? 'blocked' : hasVerifiedFactor ? 'active' : 'pending',
        createdAt: user.created_at,
      },
    };
  }

  async updateAdministratorMatricule(
    authorization: string | undefined,
    userId: string,
    input: UpdateAdministratorMatriculeDto,
  ) {
    const identity = await this.auth.requireManager(authorization);
    const supabase = this.infrastructure.getSupabaseClient();
    const [{ data: userData, error: userError }, { data: factorData, error: factorError }] = await Promise.all([
      supabase.auth.admin.getUserById(userId),
      supabase.auth.admin.mfa.listFactors({ userId }),
    ]);
    const user = userData.user;
    if (userError || factorError) throw new InternalServerErrorException('MISE_A_JOUR_MATRICULE_ADMINISTRATEUR_ECHOUEE');
    if (!user || !['owner', 'administrator', 'maintainer'].includes(String(user.app_metadata.inox_admin_role))) {
      throw new NotFoundException('ADMINISTRATEUR_INTROUVABLE');
    }

    const actorRole = String(identity.user.app_metadata.inox_admin_role);
    if (user.app_metadata.inox_admin_role === 'owner' && actorRole !== 'owner') {
      throw new ForbiddenException('PROPRIETAIRE_PROTEGE');
    }

    const hiringDate = this.validHiringDate(String(user.app_metadata.inox_admin_hired_at || user.created_at.slice(0, 10)));
    const matricule = normalizeMatricule(input.matricule);
    if (!matricule || !isMatriculeFor(matricule, 'ADMIN', hiringDate.year)) {
      throw new BadRequestException('MATRICULE_ADMINISTRATEUR_INVALIDE');
    }
    const previousMatricule = String(user.app_metadata.inox_admin_matricule || '');
    if (matricule !== previousMatricule) {
      const { data: usersData, error: usersError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (usersError) throw new InternalServerErrorException('VERIFICATION_MATRICULE_ECHOUEE');
      if (usersData.users.some((candidate) => candidate.id !== userId && candidate.app_metadata.inox_admin_matricule === matricule)) {
        throw new ConflictException('MATRICULE_DEJA_ATTRIBUE');
      }

      const { data: updatedData, error: updateError } = await supabase.auth.admin.updateUserById(userId, {
        app_metadata: {
          ...user.app_metadata,
          inox_admin_matricule: matricule,
        },
      });
      if (updateError || !updatedData.user) {
        const { data: refreshedUsers } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
        if (refreshedUsers?.users.some((candidate) => candidate.id !== userId && candidate.app_metadata.inox_admin_matricule === matricule)) {
          throw new ConflictException('MATRICULE_DEJA_ATTRIBUE');
        }
        throw new InternalServerErrorException('MISE_A_JOUR_MATRICULE_ADMINISTRATEUR_ECHOUEE');
      }

      await this.audit(identity.user.id, 'administrator.matricule_updated', 'administrator', userId, {
        previousMatricule,
        matricule,
      });
      await this.realtime.publish({ type: 'administrator.updated' });
    }

    const hasVerifiedFactor = factorData.factors.some((factor) => factor.status === 'verified');
    return {
      member: {
        userId: user.id,
        email: user.email ?? 'Adresse indisponible',
        displayName: String(user.app_metadata.inox_admin_display_name || user.email?.split('@')[0] || 'Administrateur INOX'),
        matricule,
        hiredAt: hiringDate.value,
        role: user.app_metadata.inox_admin_role as 'owner' | 'administrator' | 'maintainer',
        status: user.app_metadata.inox_admin_active !== true ? 'blocked' : hasVerifiedFactor ? 'active' : 'pending',
        createdAt: user.created_at,
      },
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
    await this.realtime.publish({ type: 'site.created' });
    return { site: data };
  }

  async deleteSite(authorization: string | undefined, siteId: string) {
    const identity = await this.auth.requireManager(authorization);
    const supabase = this.infrastructure.getSupabaseClient();
    const { data: terminals, error: terminalError } = await supabase
      .from('terminaux')
      .select('id')
      .eq('site_id', siteId);
    if (terminalError) throw new InternalServerErrorException('SUPPRESSION_SITE_ECHOUEE');

    const { data: site, error } = await supabase
      .from('sites')
      .delete()
      .eq('id', siteId)
      .select('id,name')
      .maybeSingle();
    if (error) throw new InternalServerErrorException('SUPPRESSION_SITE_ECHOUEE');
    if (!site) throw new NotFoundException('SITE_INTROUVABLE');

    await this.audit(identity.user.id, 'site.deleted', 'site', siteId, {
      name: site.name,
      terminalCount: terminals?.length ?? 0,
    });
    await Promise.all((terminals ?? []).map((terminal) => this.realtime.publish({
      type: 'terminal.session_revoked',
      terminalId: terminal.id,
    })));
    await this.realtime.publish({ type: 'site.deleted' });
    return { deleted: true, siteId };
  }

  async listEmployees(authorization?: string) {
    await this.auth.requireAdmin(authorization);
    const supabase = this.infrastructure.getSupabaseClient();
    const [{ data, error }, { data: authUsers, error: authUsersError }] = await Promise.all([
      supabase
      .from('employes')
        .select('id,auth_user_id,matricule,hired_at,display_name,active,created_at,sites(name)')
      .order('display_name'),
      supabase.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    ]);
    if (error || authUsersError) throw new InternalServerErrorException('EMPLOYES_INDISPONIBLES');
    const usersById = new Map(authUsers.users.map((user) => [user.id, user]));
    const items = (data ?? []).map(({ auth_user_id: authUserId, ...employee }) => {
      const user = usersById.get(authUserId);
      const pending = user?.app_metadata.inox_employee_invitation_pending === true || !user?.last_sign_in_at;
      return {
        ...employee,
        email: user?.email ?? 'Adresse indisponible',
        status: !employee.active ? 'blocked' : pending ? 'pending' : 'active',
      };
    });
    return { items };
  }

  async createEmployee(authorization: string | undefined, input: CreateEmployeeDto) {
    const identity = await this.auth.requireManager(authorization);
    const supabase = this.infrastructure.getSupabaseClient();
    const email = input.email.trim().toLowerCase();
    const displayName = input.displayName.trim();
    const hiringDate = this.validHiringDate(input.hiredAt);
    const requestedMatricule = normalizeMatricule(input.matricule);
    if (requestedMatricule && !isMatriculeFor(requestedMatricule, 'EMP', hiringDate.year)) {
      throw new BadRequestException('MATRICULE_EMPLOYE_INVALIDE');
    }
    const { data: site } = await supabase.from('sites').select('id').eq('id', input.siteId).eq('active', true).maybeSingle();
    if (!site) throw new BadRequestException('SITE_INVALIDE');

    const { data: existingEmployees, error: employeeLookupError } = await supabase
      .from('employes')
      .select('matricule')
      .like('matricule', `INOX-EMP-${hiringDate.year}-%`);
    if (employeeLookupError) throw new InternalServerErrorException('VERIFICATION_MATRICULE_ECHOUEE');
    let occupiedMatricules = (existingEmployees ?? []).map((employee) => employee.matricule);
    if (requestedMatricule && occupiedMatricules.includes(requestedMatricule)) {
      throw new ConflictException('MATRICULE_DEJA_ATTRIBUE');
    }
    let matricule = requestedMatricule ?? nextAvailableMatricule('EMP', hiringDate.year, occupiedMatricules);

    const { data: invite, error: inviteError } = await supabase.auth.admin.generateLink({
      type: 'invite',
      email,
      options: { data: { display_name: displayName } },
    });
    if (inviteError || !invite.user || !invite.properties?.hashed_token) {
      throw new BadRequestException('INVITATION_EMPLOYE_ECHOUEE');
    }
    const { error: metadataError } = await supabase.auth.admin.updateUserById(invite.user.id, {
      app_metadata: {
        ...invite.user.app_metadata,
        inox_employee_invitation_pending: true,
        inox_employee_hired_at: hiringDate.value,
      },
    });
    if (metadataError) {
      await supabase.auth.admin.deleteUser(invite.user.id);
      throw new BadRequestException('INVITATION_EMPLOYE_ECHOUEE');
    }
    let employee: CreatedEmployeeRow | null = null;
    let insertError: { code?: string } | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await supabase
        .from('employes')
        .insert({ auth_user_id: invite.user.id, matricule, hired_at: hiringDate.value, display_name: displayName, site_id: input.siteId })
        .select('id,matricule,hired_at,display_name,active,created_at,sites(name)')
        .single();
      employee = result.data as CreatedEmployeeRow | null;
      insertError = result.error;
      if (!insertError && employee) break;
      if (insertError?.code !== '23505' || requestedMatricule) break;
      const { data: refreshedEmployees, error: refreshError } = await supabase
        .from('employes')
        .select('matricule')
        .like('matricule', `INOX-EMP-${hiringDate.year}-%`);
      if (refreshError) break;
      occupiedMatricules = (refreshedEmployees ?? []).map((item) => item.matricule);
      matricule = nextAvailableMatricule('EMP', hiringDate.year, occupiedMatricules);
    }
    if (insertError || !employee) {
      await supabase.auth.admin.deleteUser(invite.user.id);
      if (insertError?.code === '23505') throw new ConflictException(requestedMatricule ? 'MATRICULE_DEJA_ATTRIBUE' : 'EMPLOYE_DEJA_EXISTANT');
      throw new BadRequestException('CREATION_EMPLOYE_ECHOUEE');
    }
    await this.audit(identity.user.id, 'employee.created', 'employee', employee.id, { matricule });
    await this.realtime.publish({ type: 'employee.created', employeeId: employee.id });
    return {
      employee: { ...employee, email, status: 'pending' },
      invitationTokenHash: invite.properties.hashed_token,
      invitationType: 'invite',
    };
  }

  private validHiringDate(value: string) {
    try {
      return parseHiringDate(value);
    } catch {
      throw new BadRequestException('DATE_EMBAUCHE_INVALIDE');
    }
  }

  async regenerateEmployeeInvitation(authorization: string | undefined, employeeId: string) {
    const identity = await this.auth.requireManager(authorization);
    const supabase = this.infrastructure.getSupabaseClient();
    const { data: employee, error: employeeError } = await supabase
      .from('employes')
      .select('id,auth_user_id,matricule,display_name,active')
      .eq('id', employeeId)
      .maybeSingle();
    if (employeeError) throw new InternalServerErrorException('VERIFICATION_EMPLOYE_ECHOUEE');
    if (!employee) throw new NotFoundException('EMPLOYE_INTROUVABLE');
    if (!employee.active) throw new ConflictException('EMPLOYE_BLOQUE');

    const { data: userData, error: userError } = await supabase.auth.admin.getUserById(employee.auth_user_id);
    const user = userData.user;
    if (userError) throw new InternalServerErrorException('VERIFICATION_EMPLOYE_ECHOUEE');
    if (!user?.email) throw new BadRequestException('EMAIL_EMPLOYE_INDISPONIBLE');
    const pending = user.app_metadata.inox_employee_invitation_pending === true || !user.last_sign_in_at;
    if (!pending) throw new ConflictException('EMPLOYE_DEJA_ACTIVE');

    const { error: metadataError } = await supabase.auth.admin.updateUserById(user.id, {
      app_metadata: {
        ...user.app_metadata,
        inox_employee_invitation_pending: true,
      },
    });
    if (metadataError) throw new InternalServerErrorException('REGENERATION_INVITATION_EMPLOYE_ECHOUEE');

    const { data: link, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email: user.email,
    });
    if (linkError || !link.properties?.hashed_token) {
      throw new BadRequestException('REGENERATION_INVITATION_EMPLOYE_ECHOUEE');
    }

    await this.audit(identity.user.id, 'employee.invitation.regenerated', 'employee', employee.id, {
      matricule: employee.matricule,
    });
    await this.realtime.publish({ type: 'employee.updated', employeeId: employee.id });
    return {
      invitationTokenHash: link.properties.hashed_token,
      invitationType: 'recovery',
    };
  }

  async updateEmployeeStatus(
    authorization: string | undefined,
    employeeId: string,
    input: UpdateEmployeeStatusDto,
  ) {
    const identity = await this.auth.requireManager(authorization);
    const supabase = this.infrastructure.getSupabaseClient();
    const { data: current, error: lookupError } = await supabase
      .from('employes')
      .select('id,auth_user_id,matricule,display_name,active')
      .eq('id', employeeId)
      .maybeSingle();
    if (lookupError) throw new InternalServerErrorException('MISE_A_JOUR_EMPLOYE_ECHOUEE');
    if (!current) throw new NotFoundException('EMPLOYE_INTROUVABLE');
    if (current.active === input.active) return { employee: current };

    const { error: authError } = await supabase.auth.admin.updateUserById(current.auth_user_id, {
      ban_duration: input.active ? 'none' : '876000h',
    });
    if (authError) throw new InternalServerErrorException('MISE_A_JOUR_ACCES_EMPLOYE_ECHOUEE');

    const { data: employee, error } = await supabase
      .from('employes')
      .update({ active: input.active, updated_at: new Date().toISOString() })
      .eq('id', employeeId)
      .select('id,matricule,display_name,active,created_at,sites(name)')
      .maybeSingle();
    if (error || !employee) {
      await supabase.auth.admin.updateUserById(current.auth_user_id, {
        ban_duration: current.active ? 'none' : '876000h',
      });
      throw new InternalServerErrorException('MISE_A_JOUR_EMPLOYE_ECHOUEE');
    }

    await this.audit(identity.user.id, input.active ? 'employee.unblocked' : 'employee.blocked', 'employee', employeeId, {
      matricule: current.matricule,
    });
    await this.realtime.publish({ type: 'employee.updated', employeeId });
    return { employee };
  }

  async updateEmployeeMatricule(
    authorization: string | undefined,
    employeeId: string,
    input: UpdateEmployeeMatriculeDto,
  ) {
    const identity = await this.auth.requireManager(authorization);
    const supabase = this.infrastructure.getSupabaseClient();
    const { data: current, error: lookupError } = await supabase
      .from('employes')
      .select('id,matricule,hired_at,display_name,active,created_at,sites(name)')
      .eq('id', employeeId)
      .maybeSingle();
    if (lookupError) throw new InternalServerErrorException('MISE_A_JOUR_MATRICULE_EMPLOYE_ECHOUEE');
    if (!current) throw new NotFoundException('EMPLOYE_INTROUVABLE');

    const hiringDate = this.validHiringDate(current.hired_at);
    const matricule = normalizeMatricule(input.matricule);
    if (!matricule || !isMatriculeFor(matricule, 'EMP', hiringDate.year)) {
      throw new BadRequestException('MATRICULE_EMPLOYE_INVALIDE');
    }
    if (matricule === current.matricule) return { employee: current };

    const { data: employee, error } = await supabase
      .from('employes')
      .update({ matricule, updated_at: new Date().toISOString() })
      .eq('id', employeeId)
      .select('id,matricule,hired_at,display_name,active,created_at,sites(name)')
      .maybeSingle();
    if (error?.code === '23505') throw new ConflictException('MATRICULE_DEJA_ATTRIBUE');
    if (error || !employee) throw new InternalServerErrorException('MISE_A_JOUR_MATRICULE_EMPLOYE_ECHOUEE');

    await this.audit(identity.user.id, 'employee.matricule_updated', 'employee', employeeId, {
      previousMatricule: current.matricule,
      matricule,
    });
    await this.realtime.publish({ type: 'employee.updated', employeeId });
    return { employee };
  }

  async deleteEmployee(authorization: string | undefined, employeeId: string) {
    const identity = await this.auth.requireManager(authorization);
    const supabase = this.infrastructure.getSupabaseClient();
    const { data: employee, error: lookupError } = await supabase
      .from('employes')
      .select('id,auth_user_id,matricule,display_name')
      .eq('id', employeeId)
      .maybeSingle();
    if (lookupError) throw new InternalServerErrorException('SUPPRESSION_EMPLOYE_ECHOUEE');
    if (!employee) throw new NotFoundException('EMPLOYE_INTROUVABLE');

    const { error } = await supabase.auth.admin.deleteUser(employee.auth_user_id);
    if (error) throw new InternalServerErrorException('SUPPRESSION_EMPLOYE_ECHOUEE');

    await this.audit(identity.user.id, 'employee.deleted', 'employee', employeeId, {
      matricule: employee.matricule,
      displayName: employee.display_name,
    });
    await this.realtime.publish({ type: 'employee.deleted', employeeId });
    return { deleted: true, employeeId };
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

  async updateAttendance(
    authorization: string | undefined,
    attendanceId: string,
    input: UpdateAttendanceDto,
  ) {
    const identity = await this.auth.requireAdmin(authorization);
    const occurredAt = new Date(input.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) throw new BadRequestException('DATE_POINTAGE_INVALIDE');

    const supabase = this.infrastructure.getSupabaseClient();
    const { data: current, error: lookupError } = await supabase
      .from('evenements_pointage')
      .select('id,occurred_at,event_type,employe_id')
      .eq('id', attendanceId)
      .maybeSingle();
    if (lookupError) throw new InternalServerErrorException('MODIFICATION_POINTAGE_ECHOUEE');
    if (!current) throw new NotFoundException('POINTAGE_INTROUVABLE');

    const { data: event, error } = await supabase
      .from('evenements_pointage')
      .update({ occurred_at: occurredAt.toISOString() })
      .eq('id', attendanceId)
      .select('id,event_type,occurred_at,employes(display_name,matricule),sites(name),terminaux(name)')
      .maybeSingle();
    this.throwAttendanceWriteError(error, 'MODIFICATION_POINTAGE_ECHOUEE');
    if (!event) throw new NotFoundException('POINTAGE_INTROUVABLE');

    await this.audit(identity.user.id, 'attendance.updated', 'attendance', attendanceId, {
      previousOccurredAt: current.occurred_at,
      occurredAt: event.occurred_at,
      eventType: current.event_type,
      employeeId: current.employe_id,
    });
    await this.realtime.publish({ type: 'attendance.updated', employeeId: current.employe_id });
    return { event };
  }

  async deleteAttendance(authorization: string | undefined, attendanceId: string) {
    const identity = await this.auth.requireAdmin(authorization);
    const { data: event, error } = await this.infrastructure
      .getSupabaseClient()
      .from('evenements_pointage')
      .delete()
      .eq('id', attendanceId)
      .select('id,event_type,occurred_at,employe_id')
      .maybeSingle();
    if (error) throw new InternalServerErrorException('SUPPRESSION_POINTAGE_ECHOUEE');
    if (!event) throw new NotFoundException('POINTAGE_INTROUVABLE');

    await this.audit(identity.user.id, 'attendance.deleted', 'attendance', attendanceId, {
      eventType: event.event_type,
      occurredAt: event.occurred_at,
      employeeId: event.employe_id,
    });
    await this.realtime.publish({ type: 'attendance.deleted', employeeId: event.employe_id });
    return { deleted: true, attendanceId };
  }

  async deleteAttendanceHistory(authorization?: string) {
    const identity = await this.auth.requireAdmin(authorization);
    const { data, error } = await this.infrastructure
      .getSupabaseClient()
      .from('evenements_pointage')
      .delete()
      .not('id', 'is', null)
      .select('id');
    if (error) throw new InternalServerErrorException('SUPPRESSION_HISTORIQUE_ECHOUEE');

    await this.audit(identity.user.id, 'attendance.history_deleted', 'attendance', identity.user.id, {
      deletedCount: data?.length ?? 0,
    });
    await this.realtime.publish({ type: 'attendance.deleted' });
    return { deleted: true, deletedCount: data?.length ?? 0 };
  }

  async listTerminals(authorization?: string) {
    await this.auth.requireAdmin(authorization);
    const { data, error } = await this.infrastructure
      .getSupabaseClient()
      .from('terminaux')
      .select('id,name,active,last_seen_at,activation_expires_at,session_expires_at,sites(name)')
      .order('name');
    if (error) throw new InternalServerErrorException('TERMINAUX_INDISPONIBLES');
    return { items: data ?? [] };
  }

  async createTerminal(authorization: string | undefined, input: CreateTerminalDto) {
    const identity = await this.auth.requireAdmin(authorization);
    const { code, activationExpiresAt } = this.newActivationCode();
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
    await this.realtime.publish({ type: 'terminal.created', terminalId: data.id });
    return { terminal: data, activationCode: code, activationExpiresAt };
  }

  async deleteTerminal(authorization: string | undefined, terminalId: string) {
    const identity = await this.auth.requireManager(authorization);
    const { data: terminal, error } = await this.infrastructure
      .getSupabaseClient()
      .from('terminaux')
      .delete()
      .eq('id', terminalId)
      .select('id,name,site_id')
      .maybeSingle();
    if (error) throw new InternalServerErrorException('SUPPRESSION_TERMINAL_ECHOUEE');
    if (!terminal) throw new NotFoundException('TERMINAL_INTROUVABLE');

    await this.audit(identity.user.id, 'terminal.deleted', 'terminal', terminalId, {
      name: terminal.name,
      siteId: terminal.site_id,
    });
    await this.realtime.publish({ type: 'terminal.session_revoked', terminalId });
    await this.realtime.publish({ type: 'terminal.deleted', terminalId });
    return { deleted: true, terminalId };
  }

  async renewTerminalActivationCode(authorization: string | undefined, terminalId: string) {
    const identity = await this.auth.requireAdmin(authorization);
    const { code, activationExpiresAt } = this.newActivationCode();
    const { data, error } = await this.infrastructure
      .getSupabaseClient()
      .from('terminaux')
      .update({
        activation_code_hash: this.hash(code),
        activation_expires_at: activationExpiresAt,
        session_token_hash: null,
        session_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', terminalId)
      .eq('active', true)
      .select('id,name,active,last_seen_at,activation_expires_at,session_expires_at,sites(name)')
      .maybeSingle();
    if (error) throw new InternalServerErrorException('RENOUVELLEMENT_CODE_TERMINAL_ECHOUE');
    if (!data) throw new NotFoundException('TERMINAL_INTROUVABLE');
    await this.audit(identity.user.id, 'terminal.activation_code_renewed', 'terminal', terminalId, {});
    await this.realtime.publish({ type: 'terminal.session_revoked', terminalId });
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
    await this.realtime.publish({ type: 'terminal.activated', terminalId: terminal.id });
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
    const occurredAt = new Date().toISOString();
    const { data: event, error } = await supabase
      .from('evenements_pointage')
      .insert({
        employe_id: qr.employeeId,
        terminal_id: terminal.id,
        site_id: terminal.site_id,
        event_type: input.eventType,
        occurred_at: occurredAt,
        qr_token_hash: tokenHash,
        idempotency_key: input.idempotencyKey,
      })
      .select('id,event_type,occurred_at')
      .single();
    if (error?.code === '23505') throw new ConflictException('POINTAGE_DEJA_TRAITE');
    this.throwAttendanceWriteError(error, 'POINTAGE_NON_CONFIRME');
    if (error || !event) throw new InternalServerErrorException('POINTAGE_NON_CONFIRME');
    await this.realtime.publish({
      type: 'attendance.recorded',
      employeeId: qr.employeeId,
      terminalId: terminal.id,
    });
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

  private throwAttendanceWriteError(error: { code?: string; message?: string } | null, fallback: string) {
    if (!error) return;
    if (error.code === 'P0001' && error.message?.includes('DAILY_ATTENDANCE_LIMIT_REACHED')) {
      throw new ConflictException('LIMITE_POINTAGES_QUOTIDIENNE_ATTEINTE');
    }
    if (error.code === 'P0001' && error.message?.includes('ATTENDANCE_TYPE_ALREADY_RECORDED')) {
      throw new ConflictException('TYPE_POINTAGE_DEJA_ENREGISTRE');
    }
    throw new InternalServerErrorException(fallback);
  }

  private newActivationCode() {
    return {
      code: randomBytes(6).toString('hex').toUpperCase(),
      activationExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  }

  private attendanceTrafficDays(now: Date, count: number): AttendanceTrafficDay[] {
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);
    return Array.from({ length: count }, (_, index) => {
      const start = new Date(today);
      start.setUTCDate(start.getUTCDate() - (count - index - 1));
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 1);
      return {
        date: start.toISOString().slice(0, 10),
        start: start.toISOString(),
        end: end.toISOString(),
      };
    });
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
}
