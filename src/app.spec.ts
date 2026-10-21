import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { validate } from 'class-validator';
import { configureApp } from './app.config';
import { AppModule } from './app.module';
import { AuthService } from './auth.service';
import { nextAvailableMatricule } from './matricule';
import {
  CreateAdministratorDto,
  CreateEmployeeDto,
  UpdateAdministratorMatriculeDto,
  UpdateEmployeeMatriculeDto,
} from './pointage.dto';

describe('public HTTP routes', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('exposes the documented health route', async () => {
    const response = await fetch(`${baseUrl}/api/v1/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'degraded',
      service: 'pointage-api',
      dependencies: {
        redis: 'not_configured',
        supabase: 'not_configured',
      },
    });
  });

  it('keeps the root route outside the API prefix', async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ health: '/api/v1/health' });
  });

  it.each([
    '/api/v1/moi',
    '/api/v1/moi/pointages',
    '/api/v1/admin/tableau-de-bord',
    '/api/v1/admin/administrateurs',
    '/api/v1/admin/sites',
    '/api/v1/admin/employes',
    '/api/v1/admin/presences',
    '/api/v1/admin/terminaux',
    '/api/v1/terminaux/session',
    '/api/v1/events/moi',
    '/api/v1/events/admin',
    '/api/v1/events/terminal',
  ])('rejects unauthenticated access to %s', async (path) => {
    const response = await fetch(`${baseUrl}${path}`);
    expect(response.status).toBe(401);
  });

  it('validates terminal activation codes before accessing infrastructure', async () => {
    const response = await fetch(`${baseUrl}/api/v1/terminaux/activation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'court' }),
    });
    expect(response.status).toBe(400);
  });

  it('protects terminal activation-code renewal', async () => {
    const response = await fetch(`${baseUrl}/api/v1/admin/terminaux/00000000-0000-4000-8000-000000000000/code-activation`, {
      method: 'POST',
    });
    expect(response.status).toBe(401);
  });

  it.each([
    ['POST', '/api/v1/admin/administrateurs', { email: 'admin@inox.ci', displayName: 'Admin INOX', hiredAt: '2026-10-21', role: 'administrator' }],
    ['POST', '/api/v1/admin/administrateurs/00000000-0000-4000-8000-000000000000/invitation', undefined],
    ['PATCH', '/api/v1/admin/administrateurs/00000000-0000-4000-8000-000000000000/role', { role: 'maintainer' }],
    ['PATCH', '/api/v1/admin/administrateurs/00000000-0000-4000-8000-000000000000/matricule', { matricule: 'INOX-ADMIN-2026-0005' }],
    ['POST', '/api/v1/admin/employes/00000000-0000-4000-8000-000000000000/invitation', undefined],
    ['POST', '/api/v1/moi/activation', undefined],
    ['DELETE', '/api/v1/admin/sites/00000000-0000-4000-8000-000000000000', undefined],
    ['PATCH', '/api/v1/admin/employes/00000000-0000-4000-8000-000000000000/status', { active: false }],
    ['PATCH', '/api/v1/admin/employes/00000000-0000-4000-8000-000000000000/matricule', { matricule: 'INOX-EMP-2026-0002' }],
    ['DELETE', '/api/v1/admin/employes/00000000-0000-4000-8000-000000000000', undefined],
    ['PATCH', '/api/v1/admin/presences/00000000-0000-4000-8000-000000000000', { occurredAt: '2026-10-20T08:00:00.000Z' }],
    ['DELETE', '/api/v1/admin/presences/00000000-0000-4000-8000-000000000000', undefined],
    ['DELETE', '/api/v1/admin/presences', undefined],
    ['DELETE', '/api/v1/admin/terminaux/00000000-0000-4000-8000-000000000000', undefined],
  ])('protects %s %s', async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    expect(response.status).toBe(401);
  });

  it('requires an explicit attendance type for scans', async () => {
    const response = await fetch(`${baseUrl}/api/v1/pointages/scanner`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        qrPayload: `inox-presence:v1:${'a'.repeat(32)}`,
        idempotencyKey: '00000000-0000-4000-8000-000000000000',
      }),
    });
    expect(response.status).toBe(400);
  });
});

describe('employee matricule validation', () => {
  function employeeWithMatricule(matricule: string) {
    const employee = new CreateEmployeeDto();
    employee.email = 'employee@inox.ci';
    employee.displayName = 'Employé INOX';
    employee.hiredAt = '2026-10-21';
    employee.matricule = matricule;
    employee.siteId = '00000000-0000-4000-8000-000000000000';
    return employee;
  }

  it('accepts the INOX employee format', async () => {
    await expect(validate(employeeWithMatricule('INOX-EMP-2026-0001'))).resolves.toHaveLength(0);
  });

  it.each(['INOX-EMP-2026-0000', 'INOX-ADMIN-2026-0001', 'EMP-2026-0001'])('rejects invalid matricule %s', async (matricule) => {
    const errors = await validate(employeeWithMatricule(matricule));
    expect(errors.some((error) => error.property === 'matricule')).toBe(true);
  });
});

describe('administrator invitation validation', () => {
  it('accepts a professional email, a name and a formatted matricule', async () => {
    const administrator = new CreateAdministratorDto();
    administrator.email = 'admin@inox.ci';
    administrator.displayName = 'Administration INOX';
    administrator.hiredAt = '2026-10-21';
    administrator.matricule = 'INOX-ADMIN-2026-0002';
    administrator.role = 'maintainer';
    await expect(validate(administrator)).resolves.toHaveLength(0);
  });

  it('rejects an invalid administrator matricule', async () => {
    const administrator = new CreateAdministratorDto();
    administrator.email = 'admin@inox.ci';
    administrator.displayName = 'Administration INOX';
    administrator.hiredAt = '2026-10-21';
    administrator.matricule = 'INOX-EMP-2026-0002';
    administrator.role = 'administrator';
    const errors = await validate(administrator);
    expect(errors.some((error) => error.property === 'matricule')).toBe(true);
  });

  it('rejects owner as an invitation role', async () => {
    const administrator = new CreateAdministratorDto();
    administrator.email = 'admin@inox.ci';
    administrator.displayName = 'Administration INOX';
    administrator.hiredAt = '2026-10-21';
    administrator.matricule = 'INOX-ADMIN-2026-0002';
    administrator.role = 'owner' as 'administrator';
    const errors = await validate(administrator);
    expect(errors.some((error) => error.property === 'role')).toBe(true);
  });
});

describe('ordered matricule generation', () => {
  it('starts at 0001 and reuses the first free number', () => {
    expect(nextAvailableMatricule('EMP', 2026, [])).toBe('INOX-EMP-2026-0001');
    expect(nextAvailableMatricule('EMP', 2026, ['INOX-EMP-2026-0001', 'INOX-EMP-2026-0003']))
      .toBe('INOX-EMP-2026-0002');
  });

  it('keeps employee and administrator sequences independent', () => {
    expect(nextAvailableMatricule('ADMIN', 2026, ['INOX-EMP-2026-0001']))
      .toBe('INOX-ADMIN-2026-0001');
  });
});

describe('matricule update validation', () => {
  it('accepts only an employee matricule for an employee update', async () => {
    const valid = new UpdateEmployeeMatriculeDto();
    valid.matricule = 'INOX-EMP-2026-0002';
    await expect(validate(valid)).resolves.toHaveLength(0);

    const invalid = new UpdateEmployeeMatriculeDto();
    invalid.matricule = 'INOX-ADMIN-2026-0002';
    const errors = await validate(invalid);
    expect(errors.some((error) => error.property === 'matricule')).toBe(true);
  });

  it('accepts only an administrator matricule for an administrator update', async () => {
    const valid = new UpdateAdministratorMatriculeDto();
    valid.matricule = 'INOX-ADMIN-2026-0005';
    await expect(validate(valid)).resolves.toHaveLength(0);

    const invalid = new UpdateAdministratorMatriculeDto();
    invalid.matricule = 'INOX-EMP-2026-0005';
    const errors = await validate(invalid);
    expect(errors.some((error) => error.property === 'matricule')).toBe(true);
  });
});

describe('account-management permission', () => {
  it.each(['owner', 'administrator'])('allows the %s role', async (role) => {
    const auth = new AuthService({} as never);
    jest.spyOn(auth, 'requireAdmin').mockResolvedValue({ user: { app_metadata: { inox_admin_role: role } } } as never);
    await expect(auth.requireManager('Bearer test')).resolves.toBeDefined();
  });

  it('rejects the maintainer role', async () => {
    const auth = new AuthService({} as never);
    jest.spyOn(auth, 'requireAdmin').mockResolvedValue({ user: { app_metadata: { inox_admin_role: 'maintainer' } } } as never);
    await expect(auth.requireManager('Bearer test')).rejects.toThrow('GESTION_ADMIN_REQUISE');
  });
});
