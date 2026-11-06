# Cartera — Sistema de préstamos, facturación mensual y cobranza

Aplicación web en español (COP, fechas DD/MM/AAAA) para administrar clientes, préstamos, calendario de cuotas, facturación automática (normal o acumulada), abonos, cartera vencida y estados de cuenta.

- **Servidor:** Node.js 22 + Express + SQLite (`better-sqlite3`), sin servicios externos.
- **Interfaz:** HTML/CSS/JS sin compilación, adaptable a celular, tableta y computador. Gráficos con Chart.js (servido localmente).
- **Exportaciones:** Excel (.xlsx) y documentos imprimibles / “Guardar como PDF” desde el navegador.

## Puesta en marcha

```bash
npm install
ADMIN_PASSWORD='una-clave-segura' npm start     # http://localhost:3000
```

En el primer arranque se crea el usuario `admin` (contraseña `ADMIN_PASSWORD`, o `admin123` si no se define: cámbiela en *Configuración › Mi cuenta*). La base de datos queda en `data/cartera.db`; haga copias de seguridad de ese archivo.

| Variable | Uso |
|---|---|
| `PORT` | Puerto HTTP (3000) |
| `DB_PATH` | Ruta de la base de datos (`data/cartera.db`) |
| `ADMIN_PASSWORD` | Contraseña del administrador inicial |
| `COOKIE_SECURE=1` | Cookie de sesión solo por HTTPS (actívela detrás de un proxy con TLS) |
| `JOB_INTERVAL_MS` | Frecuencia del proceso automático (1 hora por defecto) |

**Facturación automática sin la página abierta:** el proceso corre dentro del servidor (al iniciar y cada hora). Mantenga el servidor encendido como servicio, por ejemplo con `pm2 start server.js --name cartera` o una unidad `systemd`. El proceso es idempotente: nunca crea dos facturas para la misma cuota.

## Publicar en Render con la base de datos en Supabase

El servidor corre en Render y los datos se guardan en PostgreSQL de Supabase. El sistema calcula con SQLite en memoria (las mismas consultas de siempre) y escribe cada cambio en Supabase antes de responder; al arrancar carga todo desde Supabase. Las tablas se crean solas la primera vez, con RLS activo para que no queden expuestas por la API pública de Supabase.

1. **Supabase:** cree un proyecto en https://supabase.com. En *Connect* copie la cadena **Session pooler** (funciona con Render, que usa IPv4) y reemplace `[YOUR-PASSWORD]` por la contraseña de la base de datos.
2. **GitHub:** suba este proyecto a un repositorio (sin `node_modules`, `data`, `respaldo` ni `dist-web`).
3. **Render:** *New › Blueprint*, elija el repositorio. Render lee `render.yaml` y le pide `DATABASE_URL` (la cadena de Supabase) y `ADMIN_PASSWORD`.
4. Abra la URL `https://<servicio>.onrender.com`, entre como `admin` y en *Configuración › Respaldo* restaure el archivo de respaldo descargado de la versión anterior.

Plan gratuito de Render: el servicio se duerme tras 15 minutos sin uso y tarda unos 50 segundos en despertar; las facturas pendientes se emiten al despertar. Con el plan *Starter* no se duerme y la facturación corre cada hora. Supabase gratuito pausa el proyecto tras 7 días sin actividad (se reactiva desde su panel).

Para probar la conexión contra una base **vacía de prueba**: `DATABASE_URL=... npm run test:pg`.

### Datos de demostración

`npm run demo` crea **otra** base (`data/demo.db`) con clientes, préstamos y pagos de ejemplo; para verla: `DB_PATH=data/demo.db npm start`. La base de producción nunca contiene datos ficticios.

### Pruebas

`npm test` ejecuta pruebas de integración sobre una base temporal con fechas simuladas (incluye los ejemplos exactos de facturación normal: 3 × $200.000 = $600.000, y acumulada: $200.000 → $400.000 → $600.000, abono de $150.000 → $450.000), papelera, copias automáticas y listados.

- `npm run test:pg` — con `DATABASE_URL` apuntando a una base PostgreSQL **vacía de prueba**: verifica que cada cambio (incluidas operaciones simultáneas) llegue a Supabase y sobreviva a reinicios.
- `node scripts/bench.js 600` — mide el tiempo de respuesta de cada página con 600 clientes, 1.200 préstamos y ~9.000 facturas (todas por debajo de 30 ms en el servidor).

## Seguridad de los datos

- **Copias automáticas cada 3 días:** el sistema guarda una copia completa (se conservan las 10 más recientes, cerca de un mes) en *Administración → Respaldo*. Desde allí se descargan, se crean copias manuales o se restaura una copia; antes de restaurar se guarda automáticamente una copia del estado actual. El panel de inicio recuerda descargar una copia si han pasado más de 7 días.
- **Papelera (30 días):** eliminar un préstamo o un cliente lo envía a la papelera con todos sus pagos, facturas y notas; se puede restaurar íntegro durante 30 días, después se borra definitivamente. Requiere motivo y queda en la bitácora.

## Rendimiento

Los saldos se calculan con vistas SQL optimizadas (subconsultas correlacionadas e índices), los listados se filtran y ordenan en memoria con una caché que se invalida automáticamente con cada cambio, las respuestas se comprimen y la librería de Excel solo se carga al exportar. Solo se envían a Supabase las filas que cambiaron (registro de cambios por disparadores).

## Reglas de negocio implementadas

- **Una sola fuente de deuda:** cada cuota tiene como máximo una factura vigente (índice único). Los documentos acumulados son resúmenes de consulta y nunca se suman como deuda.
- **Cada pago se registra una vez;** su distribución entre facturas se guarda aparte (`allocations`). El excedente queda como saldo a favor (o pago sin aplicar) y requiere confirmación expresa.
- **Sin borrados silenciosos:** los pagos se reversan con motivo; las facturas y préstamos se anulan con motivo; la eliminación de préstamos y clientes pasa por la papelera (recuperable 30 días). Todo queda en la bitácora con fecha, hora y usuario.
- **Saldos diferenciados:** saldo contractual, saldo de facturas, valor vencido, total abonado, total recibido y saldo a favor.
- **Estados:** pendiente (azul), próxima a vencer (amarillo), abono parcial (naranja), pagada (verde), vencida (rojo, aun con abono parcial), anulada (gris).
- **Intereses:** no se asume ninguna tasa. Modalidades: sin interés, simple mensual, simple sobre el total, cuota fija o total pactado manualmente. Si se registra la tasa de usura vigente (% E.A.) en Configuración, se bloquean préstamos cuya tasa efectiva implícita la supere.
- **Calendario:** frecuencias diaria, semanal, quincenal (cada 15 días), mensual (respeta el día de pago, con regla configurable para meses cortos) y personalizada. Previsualización antes de activar; las modificaciones solo afectan cuotas no facturadas y conservan la versión anterior.
- **Modalidad de facturación por préstamo,** cambiable para periodos futuros; cada factura conserva la modalidad con la que se emitió.
- **Roles:** *Administrador* (todo, incluidas ediciones, anulaciones, reversiones, ajustes y configuración) y *Operador* (consulta y registro de clientes, préstamos, pagos y notas).
- Las facturas son **documentos internos de cobro**, no facturas electrónicas DIAN. Si su actividad exige facturación electrónica, debe emitirse con un proveedor tecnológico autorizado.
