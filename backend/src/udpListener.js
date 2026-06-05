// =============================================================================
// udpListener.js — Ground Station DAQ (Data Acquisition)
// =============================================================================
// Receives raw UDP telemetry from the engine simulator, pipes it through
// the V&V engine, broadcasts validated data to the frontend via WebSocket,
// and persists everything to PostgreSQL.
// =============================================================================

const dgram   = require('dgram');
const { initSchema, startSession, endSession, insertBatch, logAnomalies } = require('./db');
const { analyzeTelemetry, resetEngine } = require('./vvEngine');
const { io }  = require('./server');

const UDP_PORT = parseInt(process.env.UDP_PORT, 10) || 5005;
const UDP_HOST = process.env.UDP_HOST || '127.0.0.1';

// --- Micro-batching config ---
const BATCH_INTERVAL_MS = 1000; // flush to DB every second
let   ramBuffer         = [];

// --- Session ID: one per process start ---
const RUN_ID = `SIM-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;

// =============================================================================
// GRACEFUL STARTUP — wait for DB schema before binding UDP
// =============================================================================
async function start() {
  try {
    await initSchema();
    await startSession(RUN_ID);
    console.log(`🆔 Run ID: ${RUN_ID}`);
  } catch (err) {
    console.error('Fatal: could not initialize database. Telemetry will not be persisted.');
    // Non-fatal: continue without DB persistence
  }

  const udpServer = dgram.createSocket('udp4');

  udpServer.on('listening', () => {
    const addr = udpServer.address();
    console.log(`🛰️  DAQ listening on UDP ${addr.address}:${addr.port}`);
  });

  // -------------------------------------------------------------------------
  // MAIN DATA PATH — executes at ≥10 Hz
  // -------------------------------------------------------------------------
  udpServer.on('message', (msg) => {
    let rawTelemetry;
    try {
      rawTelemetry = JSON.parse(msg.toString('utf-8'));
    } catch {
      console.warn('⚠️  Malformed UDP packet — discarding.');
      return;
    }

    // 1. V&V validation (CPU-bound, synchronous — must be fast)
    const validated = analyzeTelemetry(rawTelemetry);

    // 2. Broadcast to frontend (non-blocking)
    io.emit('telemetry_stream', validated);

    // 3. Log anomalies to console for visibility
    if (validated.vv_result.anomalies.length > 0) {
      const { severity, phase, anomalies } = validated.vv_result;
      console.log(
        `🚨 [T+${validated.mission_time.toFixed(2)}s | ${phase}] ${severity} — ` +
        anomalies.map(a => a.code).join(', ')
      );
      // Async DB write — fire and forget (don't block the data path)
      logAnomalies(validated.mission_time, anomalies, severity).catch(() => {});
    }

    // 4. Buffer for batch DB insert
    ramBuffer.push(validated);
  });

  udpServer.on('error', (err) => {
    console.error('❌ UDP socket error:', err.message);
    udpServer.close();
  });

  udpServer.bind(UDP_PORT, UDP_HOST);

  // -------------------------------------------------------------------------
  // MICRO-BATCH FLUSH — persist buffer to PostgreSQL every second
  // -------------------------------------------------------------------------
  setInterval(() => {
    if (ramBuffer.length === 0) return;
    const batch = ramBuffer.splice(0, ramBuffer.length); // atomic swap
    insertBatch(batch).catch(() => {}); // async, non-blocking
  }, BATCH_INTERVAL_MS);

  // -------------------------------------------------------------------------
  // GRACEFUL SHUTDOWN
  // -------------------------------------------------------------------------
  const shutdown = async (signal) => {
    console.log(`\n🛑 ${signal} received — flushing buffer and closing session...`);
    if (ramBuffer.length > 0) await insertBatch(ramBuffer);
    await endSession(RUN_ID);
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start();
