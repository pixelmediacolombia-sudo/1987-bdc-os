# Recuperación del búfer y cola durable

## Estado actual

El búfer conserva los mensajes y el estado `{ token, runAt }` del temporizador en Redis. El temporizador de control usa `BURST_BUFFER_CONTROL_TTL_SECONDS`, cuyo valor recomendado es 90 segundos para una ventana de 15 segundos. Al arrancar el backend, `recoverPendingTimers()` hace `SCAN` sobre las claves `buffer:timer:tenant:*:contact:*` y vuelve a programar cada flush con `max(0, runAt - now)`. El flush sigue siendo idempotente: valida el token, toma el mutex por `tenant_id + contact_id` y drena la lista con una operación Lua.

## Límite conocido

La planificación de producción usa `RedisBurstFlushQueue`, un sorted set durable por `tenant_id + contact_id`. Cada miembro contiene tenant, contacto, token y `runAt`; el poller reclama un lease con `SET NX PX` y conserva el miembro en Redis mientras ejecuta el flush. Solo después del éxito hace `ZREM` (ACK). Si el handler falla, el miembro se reprograma atómicamente y el servicio también puede persistir un nuevo token de timer. Si el proceso reinicia, los timers se reconstruyen desde Redis y la cola vuelve a observar los jobs persistidos.

`RedisWebhookQueue` usa el mismo principio de claim y ACK, con `attempts`, backoff exponencial acotado por `WEBHOOK_QUEUE_MAX_BACKOFF_MS` y traslado atómico a `queue:webhook:dead-letter` al alcanzar `WEBHOOK_QUEUE_MAX_ATTEMPTS`. El error persistido se limita a 500 caracteres y no incluye objetos de conexión ni secretos.

## Migración propuesta

1. Mantener el puerto `BurstFlushQueuePort` con `schedule`, `start` y `stop`, manteniendo `tenantId`, `contactId`, `runAt` y un identificador idempotente.
2. Mantener Redis como fuente del búfer y de la cola; el worker comprueba el token y usa el mismo mutex antes de drenar.
3. Ejecutar reconciliación de claves `buffer:timer:*` al arrancar para reconstruir jobs perdidos durante una caída.
4. Observar duplicados, latencia, jobs vencidos y reintentos antes de habilitar mensajería real.
5. Para rollback, detener la publicación de jobs nuevos y completar los jobs durables pendientes sin activar el envío outbound.

La cola durable queda implementada para desarrollo y validación operativa. La prueba unitaria local cubre claim, ACK posterior al éxito, reprogramación, backoff y DLQ; las pruebas Redis reales permanecen condicionadas a `RUN_REDIS_INTEGRATION_TESTS=true` y una `REDIS_URL` inyectada por Juan. La activación de mensajería e IA sigue bloqueada hasta completar el Redis de Render y la secuencia real firmada en GHL Sandbox.
