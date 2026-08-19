# 1987 BDC OS Backend — Tickets 2 y 3

Backend local en Node.js + TypeScript para la instalación OAuth de GoHighLevel y el almacenamiento multi-tenant de tokens cifrados.

El Ticket 3 añade `POST /webhooks/ghl`, validación HMAC-SHA256 sobre el cuerpo JSON crudo, almacenamiento de eventos en `public.raw_webhooks`, idempotencia por `(tenant_id, external_id)` y registro estructurado de mensajes inbound.

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

La misma migración garantiza que `public.raw_webhooks` exista. El endpoint de webhook acepta `x-ghl-signature` y usa `x-signature` como fallback; ambos deben contener el HMAC-SHA256 hexadecimal calculado con `GHL_CLIENT_SECRET`. El evento debe incluir `locationId` y un identificador único (`eventId` o `messageId`).

## Seguridad

- Los secretos solo se leen desde variables de entorno.
- Los tokens de GHL se cifran con AES-256-GCM antes de persistirse.
- La tabla `integrations` se vincula a `tenants(dealer_id)` y usa unicidad `(tenant_id, provider)`.
- El parámetro OAuth `state` está firmado con HMAC y expira en 10 minutos.
- Los webhooks se validan contra el cuerpo crudo antes de procesarse; una firma inválida recibe `401`.
- Los reintentos con el mismo identificador por tenant reciben `200` y no vuelven a insertar mensajes.
- Antes de acceder a tablas RLS, el repositorio fija `app.tenant_id` dentro de la transacción.
- El código no registra tokens, contraseñas ni URLs de conexión.

## Render

`render.yaml` deja preparada la definición del servicio. Las variables marcadas con `sync: false` deben ser configuradas manualmente por Juan en Render; no se incluyen valores sensibles en el repositorio.
