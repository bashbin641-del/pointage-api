import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { configureApp } from './app.config';
import { AppModule } from './app.module';

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
});
