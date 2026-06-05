// =============================================================================
// vvEngine.js — V&V Validation & Verification Engine
// =============================================================================
// Core logic for real-time telemetry validation.
// Implements: static redline checks, rate-of-change anomaly detection,
// cross-sensor correlation, and mission phase state machine.
// =============================================================================

// --- MISSION PHASE STATE MACHINE ---
// Defines valid operating ranges per phase (avoids false positives at ignition)
const MISSION_PHASES = {
  PRELAUNCH:  { minTime: -Infinity, maxTime: 0 },
  IGNITION:   { minTime: 0,         maxTime: 3  },
  RAMP_UP:    { minTime: 3,         maxTime: 8  },
  NOMINAL:    { minTime: 8,         maxTime: Infinity },
  SHUTDOWN:   { minTime: -1,        maxTime: -1 }, // Triggered manually
};

// --- REDLINES (Hard limits — immediate abort if exceeded) ---
const REDLINES = {
  NOMINAL: {
    MAX_PRESSURE_BAR:  280.0,
    MIN_PRESSURE_BAR:  200.0,
    MAX_TEMP_K:        3700.0,
    MIN_TEMP_K:        3000.0,
    MAX_FLOW_KGS:      135.0,
    MIN_FLOW_KGS:       90.0,
  },
  IGNITION: {
    MAX_PRESSURE_BAR:  290.0,
    MIN_PRESSURE_BAR:    0.0,
    MAX_TEMP_K:        3800.0,
    MIN_TEMP_K:           0.0,
    MAX_FLOW_KGS:      150.0,
    MIN_FLOW_KGS:        0.0,
  },
  RAMP_UP: {
    MAX_PRESSURE_BAR:  285.0,
    MIN_PRESSURE_BAR:    0.0,
    MAX_TEMP_K:        3750.0,
    MIN_TEMP_K:           0.0,
    MAX_FLOW_KGS:      140.0,
    MIN_FLOW_KGS:        0.0,
  },
};

// --- RATE-OF-CHANGE LIMITS (per second) ---
// A sudden spike, even below max redline, is an anomaly worth flagging
const ROC_LIMITS = {
  MAX_PRESSURE_ROC_PER_SEC:  60.0,  // bar/s
  MAX_TEMP_ROC_PER_SEC:     400.0,  // K/s
};

// --- SENSOR CORRELATION MODEL ---
// At nominal thrust, these ratios must hold within tolerance.
// Derived from simplified rocket engine thermodynamics:
//   pressure ≈ (flow * temp * R_specific) / Area_throat
// We use a simplified linear correlation: pressure / flow ≈ NOMINAL_PRESSURE_FLOW_RATIO
const CORRELATION = {
  NOMINAL_PRESSURE_FLOW_RATIO: 250.0 / 120.0,  // ~2.083 bar·s/kg
  TOLERANCE_PERCENT: 0.20,                       // ±20% allowed deviation
};

// =============================================================================
// ENGINE STATE — Sliding window for rate-of-change calculations
// =============================================================================
const SLIDING_WINDOW_SIZE = 5; // number of samples (~500ms at 10Hz)
let sampleHistory = [];        // circular buffer of recent telemetry points

/**
 * Determines the current mission phase based on mission time.
 */
function getMissionPhase(missionTime) {
  if (missionTime < 0)  return 'PRELAUNCH';
  if (missionTime < 3)  return 'IGNITION';
  if (missionTime < 8)  return 'RAMP_UP';
  return 'NOMINAL';
}

/**
 * Calculates rate of change of a value using a linear regression
 * over the sliding window. More robust than simple delta.
 * Returns units/second.
 */
function calculateRateOfChange(field) {
  if (sampleHistory.length < 2) return 0;

  const n = sampleHistory.length;
  const recent = sampleHistory.slice(-n);

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  recent.forEach((pt, i) => {
    const x = pt.mission_time;
    const y = pt[field];
    sumX  += x;
    sumY  += y;
    sumXY += x * y;
    sumX2 += x * x;
  });

  const denominator = (n * sumX2 - sumX * sumX);
  if (Math.abs(denominator) < 1e-9) return 0;

  return (n * sumXY - sumX * sumY) / denominator; // slope = dy/dt
}

/**
 * Cross-sensor correlation check.
 * In nominal phase, validates that chamber pressure is consistent
 * with propellant flow rate using a simplified physics model.
 * Returns a correlation anomaly if deviation exceeds tolerance.
 */
function checkSensorCorrelation(pressure, flow, phase) {
  if (phase !== 'NOMINAL' || flow < 10) return null; // only check at steady state

  const expectedRatio = CORRELATION.NOMINAL_PRESSURE_FLOW_RATIO;
  const actualRatio   = pressure / flow;
  const deviation     = Math.abs(actualRatio - expectedRatio) / expectedRatio;

  if (deviation > CORRELATION.TOLERANCE_PERCENT) {
    return {
      code:    'SENSOR_CORRELATION_FAULT',
      message: `Pressure/Flow ratio deviation: ${(deviation * 100).toFixed(1)}% (expected ±${CORRELATION.TOLERANCE_PERCENT * 100}%)`,
      actual:  actualRatio.toFixed(3),
      expected: expectedRatio.toFixed(3),
    };
  }
  return null;
}

// =============================================================================
// MAIN ANALYSIS FUNCTION — Called on every telemetry packet
// =============================================================================
/**
 * Validates a raw telemetry packet and returns an enriched packet
 * with V&V status, detected anomalies, and diagnostics.
 *
 * @param {Object} rawTelemetry - Parsed UDP packet from the simulator
 * @returns {Object} validatedTelemetry - Enriched packet with V&V data
 */
function analyzeTelemetry(rawTelemetry) {
  const { sensor_data, mission_time } = rawTelemetry;
  const { chamber_pressure_bar: pressure, chamber_temp_k: temp, propellant_flow_kgs: flow } = sensor_data;

  const phase    = getMissionPhase(mission_time);
  const redlines = REDLINES[phase] || REDLINES.NOMINAL;
  const anomalies = [];
  let severity   = 'NOMINAL'; // NOMINAL | WARNING | CRITICAL_ABORT

  // ---[ 1. STATIC REDLINE CHECKS ]---
  if (pressure > redlines.MAX_PRESSURE_BAR) {
    severity = 'CRITICAL_ABORT';
    anomalies.push({ code: 'OVERPRESSURE', message: `Chamber pressure ${pressure} bar exceeds redline ${redlines.MAX_PRESSURE_BAR} bar`, sensor: 'PRESSURE' });
  }
  if (pressure < redlines.MIN_PRESSURE_BAR && phase === 'NOMINAL') {
    severity = severity === 'CRITICAL_ABORT' ? severity : 'WARNING';
    anomalies.push({ code: 'UNDERPRESSURE', message: `Chamber pressure ${pressure} bar below minimum ${redlines.MIN_PRESSURE_BAR} bar`, sensor: 'PRESSURE' });
  }
  if (temp > redlines.MAX_TEMP_K) {
    severity = 'CRITICAL_ABORT';
    anomalies.push({ code: 'OVERTEMP', message: `Chamber temperature ${temp} K exceeds redline ${redlines.MAX_TEMP_K} K`, sensor: 'TEMPERATURE' });
  }
  if (flow > redlines.MAX_FLOW_KGS) {
    severity = severity === 'CRITICAL_ABORT' ? severity : 'WARNING';
    anomalies.push({ code: 'FLOW_HIGH', message: `Propellant flow ${flow} kg/s exceeds limit ${redlines.MAX_FLOW_KGS} kg/s`, sensor: 'FLOW' });
  }
  if (flow < redlines.MIN_FLOW_KGS && phase === 'NOMINAL') {
    severity = 'CRITICAL_ABORT';
    anomalies.push({ code: 'FLOW_LOW', message: `Propellant flow ${flow} kg/s below minimum ${redlines.MIN_FLOW_KGS} kg/s — possible pump failure`, sensor: 'FLOW' });
  }

  // ---[ 2. RATE-OF-CHANGE CHECKS ]---
  // Update sliding window with flat values for regression
  sampleHistory.push({ mission_time, pressure, temp, flow });
  if (sampleHistory.length > SLIDING_WINDOW_SIZE) sampleHistory.shift();

  if (phase === 'NOMINAL' && sampleHistory.length >= 3) {
    const pressureROC = Math.abs(calculateRateOfChange('pressure'));
    const tempROC     = Math.abs(calculateRateOfChange('temp'));

    if (pressureROC > ROC_LIMITS.MAX_PRESSURE_ROC_PER_SEC) {
      severity = severity === 'NOMINAL' ? 'WARNING' : severity;
      anomalies.push({
        code:    'PRESSURE_SPIKE',
        message: `Rapid pressure change detected: ${pressureROC.toFixed(1)} bar/s (limit: ${ROC_LIMITS.MAX_PRESSURE_ROC_PER_SEC} bar/s)`,
        sensor:  'PRESSURE',
        roc:     pressureROC.toFixed(2),
      });
    }
    if (tempROC > ROC_LIMITS.MAX_TEMP_ROC_PER_SEC) {
      severity = severity === 'NOMINAL' ? 'WARNING' : severity;
      anomalies.push({
        code:    'TEMP_RUNAWAY',
        message: `Thermal runaway risk: ${tempROC.toFixed(1)} K/s rate of change`,
        sensor:  'TEMPERATURE',
        roc:     tempROC.toFixed(2),
      });
    }
  }

  // ---[ 3. CROSS-SENSOR CORRELATION CHECK ]---
  const correlationFault = checkSensorCorrelation(pressure, flow, phase);
  if (correlationFault) {
    severity = severity === 'NOMINAL' ? 'WARNING' : severity;
    anomalies.push(correlationFault);
  }

  // ---[ 4. BUILD ENRICHED OUTPUT ]---
  return {
    ...rawTelemetry,
    engine_status: severity,
    vv_result: {
      phase,
      severity,
      anomalies,
      checks_run:  ['STATIC_REDLINES', 'RATE_OF_CHANGE', 'SENSOR_CORRELATION'],
      sample_count: sampleHistory.length,
    },
    // Keep legacy field for frontend compatibility
    vv_alerts: anomalies.map(a => a.message),
  };
}

/**
 * Resets the engine state (call between test runs).
 */
function resetEngine() {
  sampleHistory = [];
  console.log('🔄 V&V Engine state reset.');
}

module.exports = { analyzeTelemetry, resetEngine, getMissionPhase };
