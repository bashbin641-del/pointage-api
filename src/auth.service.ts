import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { User } from '@supabase/supabase-js';
import { InfrastructureService } from './infrastructure.service';

const adminRoles = new Set(['owner', 'administrator', 'maintainer']);

export type RequestIdentity = {
  accessToken: string;
  aal: string;
  sessionId: string;
  user: User;
};

@Injectable()
export class AuthService {
  constructor(private readonly infrastructure: InfrastructureService) {}

  async requireUser(authorization?: string): Promise<RequestIdentity> {
    const accessToken = this.bearerToken(authorization);
    const { data, error } = await this.infrastructure
      .getSupabaseClient()
      .auth.getUser(accessToken);
    if (error || !data.user) {
      throw new UnauthorizedException('SESSION_INVALIDE');
    }

    const claims = this.readClaims(accessToken);
    return {
      accessToken,
      aal: typeof claims.aal === 'string' ? claims.aal : 'aal1',
      sessionId: typeof claims.session_id === 'string' ? claims.session_id : '',
      user: data.user,
    };
  }

  async requireAdmin(authorization?: string): Promise<RequestIdentity> {
    const identity = await this.requireUser(authorization);
    const metadata = identity.user.app_metadata;
    if (
      identity.aal !== 'aal2' ||
      !identity.sessionId ||
      metadata.inox_admin_active !== true ||
      !adminRoles.has(String(metadata.inox_admin_role))
    ) {
      throw new ForbiddenException('ACCES_ADMIN_REFUSE');
    }
    return identity;
  }

  async requireManager(authorization?: string): Promise<RequestIdentity> {
    const identity = await this.requireAdmin(authorization);
    const role = String(identity.user.app_metadata.inox_admin_role);
    if (role !== 'owner' && role !== 'administrator') {
      throw new ForbiddenException('GESTION_ADMIN_REQUISE');
    }
    return identity;
  }

  private bearerToken(authorization?: string): string {
    const [scheme, token] = authorization?.split(' ') ?? [];
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('SESSION_REQUISE');
    }
    return token;
  }

  private readClaims(token: string): Record<string, unknown> {
    try {
      const payload = token.split('.')[1];
      return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new UnauthorizedException('SESSION_INVALIDE');
    }
  }
}
