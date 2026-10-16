# Pointage API

API centrale NestJS du système INOX PRÉSENCE. Les interfaces ne doivent pas accéder directement à Supabase ou Redis.

## Développement

```bash
npm install
npm run start:dev
```

Le contrôle de santé est disponible sur `GET /api/v1/health`.
