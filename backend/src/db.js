// =============================================================================
// db.js — PostgreSQL Data Layer
// =============================================================================
// Handles connection pooling, schema initialization, and batch insertion
// of validated telemetry packets. Designed for high-frequency writes (≥10 Hz).
// =============================================================================

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user:     process.env.DB_USER,
  host:     process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port:     parseInt(process.env.DB_PORT, 10),
  // Connection pool tuned for embedded telemetry workloads
  max:              5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL pool error:', err.message);
});

// =============================================================================
// SCHEMA INITIALIZATION
// =============================================================================
// Creates tables if they don't exist. Safe to call on every startup.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS telemetry_sessions (
    id          SERIAL PRIMARY KEY,
    run_id      VARCHAR(64) UNIQUE NOT NULL,
    started_at  TIMESTAMPTZ DEFAULT NOW(),
    ended_at    TIMESTAMPTZ,
    notes       TEXT
  );

  CREATE TABLE IF NOT EXISTS telemetry_packets (
    id              BIGSERIAL PRIMARY KEY,
    run_id          VARCHAR(64) NOT NULL REFERENCES telemetry_sessions(run_id),
    received_at     TIMESTAMPTZ DEFAULT NOW(),
    mission_time    DOUBLE PRECISION NOT NULL,
    pressure_bar    DOUBLE PRECISION,
    temperature_k   DOUBLE PRECISION,
    flow_kg_s       DOUBLE PRECISION,
    engine_status   VARCHAR(32),
    vv_phase        VARCHAR(32),
    vv_severity     VARCHAR(32)
  );

  CREATE TABLE IF NOT EXISTS vv_anomaly_log (
    id            BIGSERIAL PRIMARY KEY,
    run_id        VARCHAR(64) NOT NULL,
    mission_time  DOUBLE PRECISION NOT NULL,
    detected_at   TIMESTAMPTZ DEFAULT NOW(),
    anomaly_code  VARCHAR(64),
    anomaly_msg   TEXT,
    sensor        VARCHAR(32),
    severity      VARCHAR(32)
  );

  CREATE INDEX IF NOT EXISTS idx_packets_run_time
    ON telemetry_packets(run_id, mission_time);

  CREATE INDEX IF NOT EXISTS idx_anomaly_run
    ON vv_anomaly_log(run_id, mission_time);
`;

async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);
    console.log('✅ PostgreSQL schema ready.');
  } catch (err) {
    console.error('❌ Schema init failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// =============================================================================
// SESSION MANAGEMENT
// =============================================================================
let activeRunId = null;

async function startSession(runId) {
  activeRunId = runId;
  try {
    await pool.query(
      'INSERT INTO telemetry_sessions (run_id) VALUES ($1) ON CONFLICT (run_id) DO NOTHING',
      [runId]
    );
    console.log(`📋 Session started: ${runId}`);
  } catch (err) {
    console.error('❌ Failed to start session:', err.message);
  }
}

async function endSession(runId) {
  try {
    await pool.query(
      'UPDATE telemetry_sessions SET ended_at = NOW() WHERE run_id = $1',
      [runId || activeRunId]
    );
    console.log(`📋 Session closed: ${runId || activeRunId}`);
  } catch (err) {
    console.error('❌ Failed to end session:', err.message);
  }
}

// =============================================================================
// BATCH INSERT — Telemetry packets
// =============================================================================
async function insertBatch(telemetryArray) {
  if (!telemetryArray.length) return;
  const runId = activeRunId;
  if (!runId) {
    console.warn('⚠️  insertBatch called without an active session.');
    return;
  }

  const values = [];
  const placeholders = telemetryArray.map((d, i) => {
    const base = i * 7;
    values.push(
      runId,
      d.mission_time,
      d.sensor_data.chamber_pressure_bar,
      d.sensor_data.chamber_temp_k,
      d.sensor_data.propellant_flow_kgs,
      d.engine_status,
      d.vv_result?.phase ?? null,
    );
    return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7})`;
  }).join(',');

  const query = `
    INSERT INTO telemetry_packets
      (run_id, mission_time, pressure_bar, temperature_k, flow_kg_s, engine_status, vv_phase)
    VALUES ${placeholders}
  `;

  try {
    await pool.query(query, values);
    console.log(`💾 Batch: ${telemetryArray.length} packets → PostgreSQL`);
  } catch (err) {
    console.error('❌ Batch insert failed:', err.message);
  }
}

// =============================================================================
// ANOMALY LOG INSERT
// =============================================================================
async function logAnomalies(missionTime, anomalies, severity) {
  if (!anomalies.length) return;
  const runId = activeRunId;
  if (!runId) return;

  for (const anomaly of anomalies) {
    try {
      await pool.query(
        `INSERT INTO vv_anomaly_log
           (run_id, mission_time, anomaly_code, anomaly_msg, sensor, severity)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [runId, missionTime, anomaly.code, anomaly.message, anomaly.sensor ?? null, severity]
      );
    } catch (err) {
      console.error('❌ Anomaly log insert failed:', err.message);
    }
  }
}

module.exports = { initSchema, startSession, endSession, insertBatch, logAnomalies };
