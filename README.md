# Pointage API

API centrale NestJS du système INOX PRÉSENCE. Elle sera l'unique autorité pour les données métier de présence et l'accès à Redis. Les interfaces ne doivent pas accéder directement à PostgreSQL ou Redis.

Exception actuelle : le panel `pointage-admin` utilise Supabase Auth depuis son client SSR pour la connexion, le TOTP et les invitations. Sa clé secrète est réservée aux routes serveur Next.js. Aucun client navigateur ne doit recevoir cette clé, et aucune opération métier de pointage ne doit utiliser cette exception.

Le noyau métier (employés, sites, QR de pointage, événements, rapports) n'est pas encore implémenté. `GET /api/v1/health` ne prouve que la disponibilité HTTP, pas l'état des dépendances ou la capacité de pointer.

## Développement

```bash
npm install
npm run start:dev
```

Le contrôle de santé est disponible sur `GET /api/v1/health`.
