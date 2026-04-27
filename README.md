# barhub-backend

Backend FP&A para Soja Restoran, Mexicali BC.

## Stack
- Node.js + Express
- Google Drive API (Service Account)
- Claude API (extracción de PDFs)
- Supabase PostgreSQL
- node-cron (schedule viernes 2 PM)

## Variables de entorno Railway

```
ANTHROPIC_API_KEY=
SUPABASE_URL=https://zvulvzltzecqpuwxtvpr.supabase.co
SUPABASE_SERVICE_KEY=
GOOGLE_SERVICE_ACCOUNT_JSON=
APP_SECRET=BarHub2026
NODE_ENV=production
PORT=3000
```

## Endpoints

- `GET /health` — status
- `POST /api/sync/manual` — sync manual (requiere x-app-secret header)
- `GET /api/nomina/:semana` — nómina calculada
- `GET /api/propinas/:semana` — propinas + reparto piso
- `GET /api/dashboard/semana-actual` — datos semana en curso
- `GET /api/dashboard/historico` — últimas 12 semanas

## Cron Job
Cada viernes a las 2 PM (Mexicali / MST = 21:00 UTC):
1. Detecta PDFs nuevos en carpeta BarHub/Reportes Soft de Google Drive
2. Procesa con Claude API (Benny → Omar automático)
3. Guarda en Supabase
