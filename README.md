# 1987 BDC OS Backend — Tickets 2 y 3

Backend local en Node.js + TypeScript para BDC OS, con mensajería Meta multi-tenant, identidad y calificación de leads.

El backend recibe webhooks firmados de Meta en `/webhooks/meta`, almacena eventos en `public.raw_webhooks`, aplica idempotencia por `(tenant_id, external_id)` y registra mensajes inbound fuera del ciclo HTTP.

## Arquitectura

El código sigue una organización **feature-first**. Las integraciones Meta e identidad usan capas de Onion Architecture:

- `application`: casos de uso y puertos/interfaces.
- `domain`: entidades y tipos del dominio, sin dependencias de Express, PostgreSQL o Axios.
- `infrastructure`: clientes Meta, PostgreSQL, migraciones y cifrado AES-256-GCM.
- `presentation/http/*.routes.ts`: declara los paths y verbos y conecta cada endpoint con su controller.
- `presentation/http/controllers`: adapta Request/Response, valida el contrato HTTP y delega el trabajo a la capa de aplicación.

Las reglas y casos de uso viven en `application/*.service.ts`; el acceso SQL y el contexto RLS viven en `infrastructure/persistence`. Mantén los archivos de rutas delgados y evita colocar lógica de negocio o consultas SQL dentro de ellos.

La composición de dependencias vive en `src/main.ts`; las capas internas no conocen los adaptadores externos. Los servicios de presentación solo adaptan entradas/salidas HTTP: la lógica de negocio permanece en `application` y `domain`.

Los imports internos utilizan el alias absoluto `@/*`. TypeScript lo resuelve mediante `tsconfig.json`; `tsconfig-paths` lo habilita en desarrollo y `module-alias` lo habilita sobre `dist` en producción.

## Desarrollo local

1. Copia `.env.example` a `.env`.
2. Completa los valores reales únicamente en `.env`.
3. Ejecuta `npm run dev`.
4. Comprueba `GET http://localhost:3000/health`.
5. Configura `META_APP_ID`, `META_APP_SECRET` y `META_OAUTH_REDIRECT_URI` para habilitar el flujo OAuth por dealer. El estado OAuth está firmado y limitado al admin autenticado.

La aplicación ejecuta migraciones idempotentes al iniciar. También está disponible `npm run db:migrate` para ejecutarlas de forma explícita; incluye identidad, flags por tenant, atribución, `capi_events`, configuración Meta por dealer y `conversation_ai_shadow_runs` con RLS.

La misma migración garantiza que `public.raw_webhooks` exista. Meta firma solicitudes con `X-Hub-Signature-256`; se valida el cuerpo exacto antes de parsear JSON. El webhook acepta Page Messenger, Instagram y WhatsApp Cloud API. Las entregas se encolan en Redis y la unicidad SQL mantiene la idempotencia durable entre procesos.

El flujo de calificación se compone mediante `QUALIFICATION_FLOW_ENABLED`, desactivado por defecto. Cuando está activo, el orquestador encadena ledger/policy evaluator, registro PostgreSQL, veto de repetición semántica y entrega por el canal Meta del dealer. La respuesta efectiva requiere además `tenants.qualification_flow_enabled = true`.

La señal de calificación hacia Meta captura `ctwa_clid` y `source_id` desde `referral` y los persiste en `contacts`; el payload original permanece en `raw_webhooks`. La señal CAPI se encola únicamente cuando el ledger marca explícitamente `qualificationCompleted: true`, dentro de la transacción que actualiza objetivos. Los eventos CAPI son idempotentes, tienen RLS por dealer y reintentos desacoplados.

El worker permanece apagado con `QUALIFICATION_SIGNAL_ENABLED=false`. Al habilitarlo, el tag `qualification_completed` se procesa de forma independiente, pero solo para tenants con `qualification_signal_enabled = true`. Cada tenant usa su propio dataset y token cifrado en `tenants`; como respaldo local, `META_CAPI_DEALERS_JSON` se indexa por ID de tenant, nunca por nombre comercial. `meta_test_event_code` se ignora en producción y provoca fallo de contrato si aparece en una entrega de producción. `QUALIFICATION_SIGNAL_POLL_MS` controla el intervalo del worker (5 segundos por defecto). No se envían mensajes de conversación como parte de este ticket.

La configuración temporal del entorno acepta `META_CAPI_DEALERS_JSON` con pares `datasetId`/`accessToken` bajo el UUID de cada tenant. El token solo vive en memoria durante el envío: no se incluye en `payload_sent`, logs ni repositorio. En producción se usa la credencial cifrada propia del tenant.

Sofía usa `shared_dealer_v1` como configuración base común para todos los tenants. El nombre visible y el UUID vienen del tenant; las reglas de calificación permanecen iguales. Esta base está pensada para que cada dealer pueda personalizar opciones permitidas desde BDC OS en una etapa posterior. El plan es versionar el esquema y sus valores base, aplicar cambios por tenant como overrides validados, exponerlos en un editor administrativo con previsualización, guardar quién cambió cada valor y cuándo, y permitir revertir a una versión anterior. Los campos configurables deberán quedar acotados por reglas de seguridad y calificación. Hasta implementar esa etapa, los cambios de política se aplican a todos los dealers mediante la versión común.

La capa híbrida usa `CONVERSATIONAL_AI_ENABLED=false` por defecto. Cuando se autorice, el adapter OpenAI-compatible ejecuta extracción JSON y redacción por separado, con modelos configurables, prompts versionados y fallback determinista. `conversational_ai_shadow_enabled` guarda la respuesta del modelo junto a la regla en `conversation_ai_shadow_runs`; `conversational_ai_send_enabled` permanece apagado hasta revisar dos semanas de sombra. La API key no se necesita para build ni pruebas locales: las pruebas usan un fake local con el mismo contrato.

## Identidades y alta de dealers

`public.app_users` contiene el único administrador global y las cuentas de dealer; `public.user_tenant_memberships` asocia cada usuario regular con su empresa. El admin consulta `GET /auth/admin/dealers` y crea un dealer con `POST /auth/admin/dealers`, enviando `dealerName`, `ownerName` y `ownerEmail`. El tenant nuevo nace con Sofía y las automatizaciones apagadas.

La creación emite una invitación de un solo uso, ligada al correo y dealer, con vencimiento de 72 horas. SMTP se configura con `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL` y `SMTP_FROM_NAME`; `BDC_APP_URL` debe señalar el backend accesible por el invitado. Si el envío SMTP falla, la respuesta administrativa incluye un enlace de respaldo. La persona invitada crea su propia contraseña (mínimo 12 caracteres); se guarda como scrypt y la invitación queda invalidada al aceptarse. Un usuario existente puede aceptar una invitación adicional sin cambiar su contraseña.

Compose local envía a Mailpit (`http://localhost:8025`) y no entrega mensajes a cuentas externas. Sin SMTP, la API devuelve al admin el enlace para compartir manualmente. Las migraciones son idempotentes y admiten dealers antes de conectar sus canales Meta.

La policy `shared_dealer_v1` se activa por tenant mediante la migración idempotente `ensureSharedDealerPolicy`. El motor de Sofía es de código: extrae hechos, valida rangos/coherencia y redacta respuestas con reglas deterministas. La matriz de calificación está cubierta por 70 pruebas en `test:shared-dealer:matrix`; la prueba `test:shared-dealer:db10` ejecuta 10 conversaciones contra PostgreSQL local y comprueba respuestas y estado persistido.

El Ticket 7 añade el motor determinista de siguiente acción en `src/modules/decisions`. `REPLY` y cualquier otra acción deben quedar dentro de `allowed_actions` antes de invocar un LLM. Las políticas locales incluyen compatibilidad con el `policy_version` histórico `v0.1` usado por el sandbox, además de `koons_policy_v1`, que usa quiet hours de 21:00 a 08:00 y deja `downPayment.min` sin definir hasta que gerencia configure la banda aprobada; un down payment explícitamente igual a cero sigue requiriendo el disclaimer estructurado.

Para eventos inbound no duplicados, el búfer Redis agrupa mensajes por tenant/contacto y un mutex Redis evita procesar conversaciones simultáneas. Los fragmentos se consolidan en orden antes de entregarse al orquestador; las colas durables conservan ACK, reintento y dead-letter.

## Seguridad

- Los secretos solo se leen desde variables de entorno.
- Los tokens de Meta se cifran con AES-256-GCM antes de persistirse.
- Las conexiones de Facebook, Instagram y WhatsApp se guardan cifradas por tenant en la tabla `meta_messaging_connections`.
- El intercambio OAuth y la conexión de canales Meta se limitan al dealer autorizado y se almacenan cifrados.
- El parámetro OAuth `state` está firmado con HMAC y expira en 10 minutos.
- Los webhooks Meta se validan contra el cuerpo crudo antes de procesarse; una firma inválida recibe `401`.
- Los reintentos con el mismo identificador por tenant reciben `200` y no vuelven a insertar mensajes.
- Las tablas con datos de dealer usan RLS forzado; antes de acceder a ellas, el repositorio fija `app.tenant_id` dentro de la transacción.
- Redis se configura únicamente mediante `REDIS_URL`; el repositorio no contiene ni registra credenciales, URL o puertos reales.
- El código no registra tokens, contraseñas ni URLs de conexión.
- Los diagnósticos administrativos están desactivados por defecto y no se montan bajo `/tests`. Para habilitarlos se requiere `INTERNAL_DIAGNOSTICS_ENABLED=true` y credenciales únicas por tenant en `INTERNAL_DIAGNOSTIC_CREDENTIALS_JSON`; cada credencial enlaza un token de al menos 32 bytes con la identidad auditada del operador. En producción también se requiere `INTERNAL_DIAGNOSTIC_ALLOWED_REMOTE_IPS` con las IP remotas exactas permitidas.
- Las rutas protegidas viven bajo `/internal/admin/diagnostics`, aceptan `Authorization: Bearer <token>` y `tenant_id`, limitan cada tenant/operador a 30 solicitudes por minuto y escriben el acceso en `internal_diagnostic_access_audit` bajo RLS. La reconciliación toma el operador de la credencial, no de un parámetro manipulable. Rotar o revocar el token requiere actualizar el mapa de credenciales y reiniciar el servicio; la credencial anterior deja de autorizar después del reinicio.

## Regresión de seguridad

`npm run test:security` compila y ejecuta pruebas de firma sin cabecera, firma Ed25519 inválida, cuerpo alterado, ACK asíncrono, cinco entregas idénticas concurrentes y protección de diagnósticos. La matriz RLS requiere una base de pruebas configurada explícitamente mediante variables de entorno y no usa producción.

## Render

`render.yaml` deja preparada la definición del servicio. Las variables marcadas con `sync: false` deben ser configuradas manualmente por Juan en Render; no se incluyen valores sensibles en el repositorio.
