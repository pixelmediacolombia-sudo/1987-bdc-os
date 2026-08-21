# 1987 BDC OS Backend — Tickets 2 y 3

Backend local en Node.js + TypeScript para la instalación OAuth de GoHighLevel y el almacenamiento multi-tenant de tokens cifrados.

El backend recibe `POST /webhooks/ghl`, valida la firma oficial de HighLevel sobre los bytes exactos del cuerpo, almacena eventos en `public.raw_webhooks`, aplica idempotencia por `(tenant_id, external_id)` y registra mensajes inbound fuera del ciclo HTTP.

## Arquitectura

El código sigue una organización **feature-first**. El feature `ghl-oauth` contiene las capas de Onion Architecture:

- `application`: casos de uso y puertos/interfaces.
- `domain`: entidades y tipos del dominio, sin dependencias de Express, PostgreSQL o Axios.
- `infrastructure`: configuración, cliente GHL, PostgreSQL, migración y cifrado AES-256-GCM.
- `presentation`: servicios de orquestación HTTP, controladores y rutas.

La composición de dependencias vive en `src/main.ts`; las capas internas no conocen los adaptadores externos. Los servicios de presentación solo adaptan entradas/salidas HTTP: la lógica de negocio permanece en `application` y `domain`.

Los imports internos utilizan el alias absoluto `@/*`. TypeScript lo resuelve mediante `tsconfig.json`; `tsconfig-paths` lo habilita en desarrollo y `module-alias` lo habilita sobre `dist` en producción.

## Desarrollo local

1. Copia `.env.example` a `.env`.
2. Completa los valores reales únicamente en `.env`.
3. Ejecuta `npm run dev`.
4. Comprueba `GET http://localhost:3000/health`.
5. Inicia OAuth en `GET /oauth/initiate` o `GET /oauth/initiate?tenant_id=<dealer_id>`.

La aplicación ejecuta una migración idempotente al iniciar y garantiza que `public.integrations` exista antes de escuchar peticiones. También está disponible `npm run db:migrate` para ejecutarla de forma explícita.

La misma migración garantiza que `public.raw_webhooks` exista. El endpoint acepta `X-GHL-Signature` (Ed25519, preferida) o `X-WH-Signature` (RSA-SHA256, compatibilidad temporal), verificadas antes de parsear JSON. El evento debe incluir `locationId` y un identificador único (`eventId` o `messageId`). El ACK `200` se emite inmediatamente y el procesamiento se encola en memoria; la unicidad SQL mantiene la idempotencia durable entre procesos.

El Ticket 7 añade el motor determinista de siguiente acción en `src/modules/decisions`. `REPLY` y cualquier otra acción deben quedar dentro de `allowed_actions` antes de invocar un LLM. Las políticas locales incluyen compatibilidad con el `policy_version` histórico `v0.1` usado por el sandbox, además de `koons_policy_v1`, que usa quiet hours de 21:00 a 08:00 y deja `downPayment.min` sin definir hasta que gerencia configure la banda aprobada; un down payment explícitamente igual a cero sigue requiriendo el disclaimer estructurado. El endpoint `GET /tests/policy-evaluation` requiere `X-Policy-Diagnostic-Token` y `POLICY_DIAGNOSTIC_TOKEN`; recibe `tenant_id`, `contact_id` y `payload` JSON URL-encoded, registra la decisión bajo RLS y no envía mensajes.

Para los eventos inbound no duplicados, el Ticket 4 añade un búfer Redis por contacto de `BURST_BUFFER_SECONDS` (15 por defecto) y un mutex Redis con TTL de `CONTACT_MUTEX_TTL_SECONDS` (30 por defecto). Los fragmentos se consolidan en orden antes de entregarse al puerto de orquestación. El adaptador de orquestación permanece deshabilitado hasta el piloto controlado. La cola de trabajo HTTP continúa siendo en memoria y debe sustituirse por una cola durable en la siguiente fase.

## Seguridad

- Los secretos solo se leen desde variables de entorno.
- Los tokens de GHL se cifran con AES-256-GCM antes de persistirse.
- La tabla `integrations` se vincula a `tenants(dealer_id)` y usa unicidad `(tenant_id, provider)`.
- Los tokens OAuth guardan expiración, se refrescan automáticamente cinco minutos antes de vencer o tras un `401`, se vuelven a cifrar y dejan auditoría técnica.
- El parámetro OAuth `state` está firmado con HMAC y expira en 10 minutos.
- Los webhooks se validan contra el cuerpo crudo antes de procesarse; una firma inválida recibe `401`.
- Los reintentos con el mismo identificador por tenant reciben `200` y no vuelven a insertar mensajes.
- `raw_webhooks`, `integrations` y `integration_token_audits` usan RLS forzado; antes de acceder a ellas, el repositorio fija `app.tenant_id` dentro de la transacción.
- Redis se configura únicamente mediante `REDIS_URL`; el repositorio no contiene ni registra credenciales, URL o puertos reales.
- El código no registra tokens, contraseñas ni URLs de conexión.

## Regresión de seguridad

`npm run test:security` compila y ejecuta pruebas de firma sin cabecera, firma Ed25519 inválida, cuerpo alterado, ACK asíncrono y cinco entregas idénticas concurrentes. La matriz RLS requiere una base de pruebas desechable configurada explícitamente mediante variables de entorno y no usa el `.env` local ni producción.

## Render

`render.yaml` deja preparada la definición del servicio. Las variables marcadas con `sync: false` deben ser configuradas manualmente por Juan en Render; no se incluyen valores sensibles en el repositorio.
