# Recuperación del búfer y migración a cola durable

## Estado actual

El búfer conserva los mensajes y el token del temporizador en Redis. El temporizador de control usa `BURST_BUFFER_CONTROL_TTL_SECONDS`, cuyo valor recomendado es 90 segundos para una ventana de 15 segundos. Al arrancar el backend, `recoverPendingTimers()` hace `SCAN` sobre las claves `buffer:timer:tenant:*:contact:*`, consulta el TTL restante y vuelve a programar cada flush. El flush sigue siendo idempotente: valida el token, toma el mutex por `tenant_id + contact_id` y drena la lista con una operación Lua.

## Límite conocido

La planificación local con `setTimeout` todavía se pierde durante una caída. La recuperación de arranque cubre las claves que sobreviven en Redis, pero no sustituye una cola durable ni ofrece reintentos administrados por un worker.

## Migración propuesta

1. Introducir un puerto `DelayedBurstFlushQueue` con `schedule`, `cancel` y `recover`, manteniendo `tenantId`, `contactId`, `runAt` y un identificador idempotente.
2. Implementar un adaptador durable (BullMQ sobre Redis o un servicio administrado equivalente) con job id compuesto por `tenantId:contactId:timerToken`.
3. Mantener Redis como fuente del búfer; el worker debe comprobar el token y usar el mismo mutex antes de drenar.
4. Durante la transición, ejecutar reconciliación de claves `buffer:timer:*` y enviar únicamente los jobs que no tengan un job durable confirmado.
5. Activar por tenant, observar duplicados, latencia y jobs vencidos, y retirar el `setTimeout` sólo después de una ventana de estabilidad.
6. Para rollback, detener la publicación de jobs nuevos, completar los jobs durable pendientes y reactivar la reconciliación de arranque.

La cola durable queda como requisito de la siguiente etapa; esta fase deja definido el contrato operativo y una recuperación segura de los temporizadores existentes.
