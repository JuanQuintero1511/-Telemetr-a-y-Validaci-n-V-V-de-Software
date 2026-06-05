import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine
} from 'recharts';

// ─────────────────────────────────────────────────────────────────────────────
// SOCKET — single instance, reconnect on drop
// ─────────────────────────────────────────────────────────────────────────────
const WS_URL = import.meta.env.VITE_WS_URL || 'http://localhost:3000';
const socket = io(WS_URL, {
  transports:        ['websocket'],
  reconnectionDelay: 1000,
  reconnectionAttempts: 20,
});

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const MAX_POINTS   = 80;   // rolling window on charts
const MAX_ANOMALIES = 50;  // max rows in anomaly log

const REDLINES = {
  PRESSURE: { max: 280, min: 200 },
  TEMP:     { max: 3700, min: 3000 },
  FLOW:     { max: 135, min: 90 },
};

const PHASE_COLORS = {
  PRELAUNCH: '#64748b',
  IGNITION:  '#f59e0b',
  RAMP_UP:   '#3b82f6',
  NOMINAL:   '#10b981',
  SHUTDOWN:  '#64748b',
};

const SEVERITY_COLORS = {
  NOMINAL:        '#10b981',
  WARNING:        '#f59e0b',
  CRITICAL_ABORT: '#ef4444',
};

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const color = SEVERITY_COLORS[status] || '#64748b';
  return (
    <span style={{
      display:       'inline-flex',
      alignItems:    'center',
      gap:           '6px',
      padding:       '4px 12px',
      borderRadius:  '4px',
      border:        `1px solid ${color}33`,
      backgroundColor: `${color}15`,
      color,
      fontSize:      '11px',
      fontFamily:    "'JetBrains Mono', 'Fira Code', monospace",
      fontWeight:    '600',
      letterSpacing: '1.5px',
    }}>
      <span style={{
        width: '6px', height: '6px', borderRadius: '50%',
        backgroundColor: color,
        boxShadow: status !== 'NOMINAL' ? `0 0 8px ${color}` : 'none',
        animation: status === 'CRITICAL_ABORT' ? 'pulse 0.8s infinite' : 'none',
      }} />
      {status}
    </span>
  );
}

function MetricCard({ label, value, unit, redlineMax, redlineMin, color, phase }) {
  const isInPhase = phase === 'NOMINAL' || phase === 'RAMP_UP';
  const overMax  = isInPhase && redlineMax && value > redlineMax;
  const underMin = isInPhase && redlineMin && value < redlineMin;
  const warn     = overMax || underMin;

  return (
    <div style={{
      backgroundColor: '#111',
      border:          `1px solid ${warn ? '#ef444455' : '#1e1e1e'}`,
      borderRadius:    '6px',
      padding:         '16px 20px',
      transition:      'border-color 0.2s',
    }}>
      <div style={{ color: '#4b5563', fontSize: '10px', letterSpacing: '2px', marginBottom: '8px', fontFamily: 'monospace' }}>
        {label}
      </div>
      <div style={{
        fontSize:   '28px',
        fontWeight: '300',
        color:      warn ? '#ef4444' : color,
        fontFamily: "'JetBrains Mono', monospace",
        lineHeight: 1,
      }}>
        {typeof value === 'number' ? value.toFixed(1) : '—'}
        <span style={{ fontSize: '13px', marginLeft: '6px', color: '#4b5563' }}>{unit}</span>
      </div>
      {redlineMax && (
        <div style={{ marginTop: '6px', fontSize: '10px', color: '#374151', fontFamily: 'monospace' }}>
          LIMIT: {redlineMin}–{redlineMax} {unit}
        </div>
      )}
    </div>
  );
}

function TelemetryChart({ data, dataKey, label, unit, color, redlineMax, redlineMin, domain }) {
  return (
    <div style={{
      backgroundColor: '#0d0d0d',
      border:          '1px solid #1a1a1a',
      borderRadius:    '6px',
      padding:         '16px',
    }}>
      <div style={{
        display:        'flex',
        justifyContent: 'space-between',
        alignItems:     'center',
        marginBottom:   '12px',
      }}>
        <span style={{ fontSize: '10px', letterSpacing: '2px', color: '#4b5563', fontFamily: 'monospace' }}>
          {label}
        </span>
        <span style={{ fontSize: '10px', color: '#374151', fontFamily: 'monospace' }}>{unit}</span>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="2 6" stroke="#1a1a1a" />
          <XAxis dataKey="time" stroke="#1f2937" tick={{ fontSize: 9, fill: '#374151', fontFamily: 'monospace' }} interval="preserveStartEnd" />
          <YAxis domain={domain || ['auto', 'auto']} stroke="#1f2937" tick={{ fontSize: 9, fill: '#374151', fontFamily: 'monospace' }} />
          <Tooltip
            contentStyle={{ backgroundColor: '#0a0a0a', border: '1px solid #1f2937', borderRadius: '4px', fontSize: '11px', fontFamily: 'monospace' }}
            labelStyle={{ color: '#6b7280' }}
            itemStyle={{ color }}
          />
          {redlineMax && <ReferenceLine y={redlineMax} stroke="#ef444440" strokeDasharray="4 4" label={{ value: 'MAX', fill: '#ef4444', fontSize: 9, fontFamily: 'monospace' }} />}
          {redlineMin && <ReferenceLine y={redlineMin} stroke="#f59e0b30" strokeDasharray="4 4" label={{ value: 'MIN', fill: '#f59e0b', fontSize: 9, fontFamily: 'monospace' }} />}
          <Line
            type="monotone"
            dataKey={dataKey}
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function AnomalyLog({ anomalies }) {
  const logRef = useRef(null);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [anomalies]);

  return (
    <div style={{
      backgroundColor: '#0d0d0d',
      border:          '1px solid #1a1a1a',
      borderRadius:    '6px',
      padding:         '16px',
      gridColumn:      '1 / -1',
    }}>
      <div style={{
        fontSize: '10px', letterSpacing: '2px', color: '#4b5563',
        fontFamily: 'monospace', marginBottom: '12px',
        display: 'flex', justifyContent: 'space-between',
      }}>
        <span>V&amp;V ANOMALY LOG</span>
        <span style={{ color: '#374151' }}>{anomalies.length} EVENTS</span>
      </div>

      <div ref={logRef} style={{ maxHeight: '160px', overflowY: 'auto' }}>
        {anomalies.length === 0 ? (
          <div style={{ color: '#1f2937', fontFamily: 'monospace', fontSize: '11px', textAlign: 'center', padding: '20px 0' }}>
            — NO ANOMALIES DETECTED —
          </div>
        ) : (
          [...anomalies].reverse().map((a, i) => (
            <div key={i} style={{
              display:        'grid',
              gridTemplateColumns: '80px 80px 120px 1fr',
              gap:            '12px',
              padding:        '6px 8px',
              borderBottom:   '1px solid #111',
              fontSize:       '11px',
              fontFamily:     'monospace',
              alignItems:     'center',
              backgroundColor: i === 0 ? '#111' : 'transparent',
            }}>
              <span style={{ color: '#374151' }}>T+{a.time.toFixed(2)}s</span>
              <span style={{ color: SEVERITY_COLORS[a.severity] || '#6b7280', fontSize: '10px' }}>{a.severity}</span>
              <span style={{ color: '#d97706', fontSize: '10px' }}>{a.code}</span>
              <span style={{ color: '#6b7280', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [stream,    setStream]    = useState([]);
  const [status,    setStatus]    = useState('OFFLINE');
  const [phase,     setPhase]     = useState('—');
  const [latest,    setLatest]    = useState(null);
  const [anomalies, setAnomalies] = useState([]);
  const [connected, setConnected] = useState(false);
  const [pktCount,  setPktCount]  = useState(0);

  const handleTelemetry = useCallback((data) => {
    const { sensor_data: sd, mission_time, vv_result } = data;

    setStatus(data.engine_status);
    setPhase(vv_result?.phase ?? '—');
    setLatest(sd);
    setPktCount(c => c + 1);

    setStream(prev => {
      const point = {
        time:     mission_time.toFixed(1),
        pressure: sd.chamber_pressure_bar,
        temp:     sd.chamber_temp_k,
        flow:     sd.propellant_flow_kgs,
      };
      const next = [...prev, point];
      return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
    });

    if (vv_result?.anomalies?.length > 0) {
      setAnomalies(prev => {
        const newEvents = vv_result.anomalies.map(a => ({
          time:     mission_time,
          severity: vv_result.severity,
          code:     a.code,
          message:  a.message,
        }));
        const combined = [...prev, ...newEvents];
        return combined.length > MAX_ANOMALIES ? combined.slice(combined.length - MAX_ANOMALIES) : combined;
      });
    }
  }, []);

  useEffect(() => {
    socket.on('connect',          () => setConnected(true));
    socket.on('disconnect',       () => { setConnected(false); setStatus('OFFLINE'); });
    socket.on('telemetry_stream', handleTelemetry);
    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('telemetry_stream');
    };
  }, [handleTelemetry]);

  const phaseColor = PHASE_COLORS[phase] || '#4b5563';

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;600&family=DM+Sans:wght@300;400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #080808; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #111; }
        ::-webkit-scrollbar-thumb { background: #1f2937; border-radius: 2px; }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
        @keyframes fadeIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
      `}</style>

      <div style={{
        minHeight:   '100vh',
        padding:     '24px 28px',
        fontFamily:  "'DM Sans', sans-serif",
        backgroundColor: '#080808',
        color:       '#d1d5db',
      }}>

        {/* ── HEADER ─────────────────────────────────────────────────────── */}
        <header style={{
          display:        'flex',
          justifyContent: 'space-between',
          alignItems:     'center',
          borderBottom:   '1px solid #111',
          paddingBottom:  '16px',
          marginBottom:   '24px',
        }}>
          <div>
            <div style={{
              fontSize:      '11px',
              letterSpacing: '3px',
              color:         '#374151',
              fontFamily:    'monospace',
              marginBottom:  '4px',
            }}>
              GROUND STATION / TELEMETRY MONITORING
            </div>
            <h1 style={{
              fontSize:      '20px',
              fontWeight:    '300',
              letterSpacing: '1px',
              color:         '#f9fafb',
            }}>
              V&amp;V Flight Software Simulator
            </h1>
          </div>

          <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
            {/* Phase indicator */}
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '10px', color: '#374151', fontFamily: 'monospace', letterSpacing: '1px', marginBottom: '4px' }}>MISSION PHASE</div>
              <div style={{ fontSize: '13px', color: phaseColor, fontFamily: 'monospace', fontWeight: '600', letterSpacing: '1px' }}>{phase}</div>
            </div>

            <div style={{ width: '1px', height: '32px', backgroundColor: '#1f2937' }} />

            {/* Engine status */}
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '10px', color: '#374151', fontFamily: 'monospace', letterSpacing: '1px', marginBottom: '4px' }}>ENGINE STATUS</div>
              <StatusBadge status={status} />
            </div>

            <div style={{ width: '1px', height: '32px', backgroundColor: '#1f2937' }} />

            {/* Connection */}
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '10px', color: '#374151', fontFamily: 'monospace', letterSpacing: '1px', marginBottom: '4px' }}>LINK</div>
              <div style={{
                fontSize: '11px', fontFamily: 'monospace',
                color: connected ? '#10b981' : '#ef4444',
                display: 'flex', alignItems: 'center', gap: '5px',
              }}>
                <span style={{
                  width: '5px', height: '5px', borderRadius: '50%',
                  backgroundColor: connected ? '#10b981' : '#ef4444',
                  animation: connected ? 'none' : 'pulse 1s infinite',
                }} />
                {connected ? 'ESTABLISHED' : 'NO SIGNAL'}
              </div>
            </div>
          </div>
        </header>

        {/* ── METRIC CARDS ──────────────────────────────────────────────── */}
        <div style={{
          display:             'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap:                 '12px',
          marginBottom:        '20px',
        }}>
          <MetricCard
            label="CHAMBER PRESSURE"
            value={latest?.chamber_pressure_bar}
            unit="bar"
            redlineMax={REDLINES.PRESSURE.max}
            redlineMin={REDLINES.PRESSURE.min}
            color="#d4af37"
            phase={phase}
          />
          <MetricCard
            label="CHAMBER TEMPERATURE"
            value={latest?.chamber_temp_k}
            unit="K"
            redlineMax={REDLINES.TEMP.max}
            redlineMin={REDLINES.TEMP.min}
            color="#3b82f6"
            phase={phase}
          />
          <MetricCard
            label="PROPELLANT FLOW"
            value={latest?.propellant_flow_kgs}
            unit="kg/s"
            redlineMax={REDLINES.FLOW.max}
            redlineMin={REDLINES.FLOW.min}
            color="#8b5cf6"
            phase={phase}
          />
          <div style={{
            backgroundColor: '#111',
            border:          '1px solid #1e1e1e',
            borderRadius:    '6px',
            padding:         '16px 20px',
          }}>
            <div style={{ color: '#4b5563', fontSize: '10px', letterSpacing: '2px', marginBottom: '8px', fontFamily: 'monospace' }}>
              V&amp;V ENGINE
            </div>
            <div style={{ fontSize: '11px', fontFamily: 'monospace', color: '#6b7280', lineHeight: 1.8 }}>
              <div>PACKETS <span style={{ color: '#9ca3af' }}>{pktCount}</span></div>
              <div>EVENTS  <span style={{ color: anomalies.length > 0 ? '#f59e0b' : '#9ca3af' }}>{anomalies.length}</span></div>
              <div>CHECKS  <span style={{ color: '#9ca3af' }}>3</span></div>
            </div>
          </div>
        </div>

        {/* ── CHARTS ────────────────────────────────────────────────────── */}
        <div style={{
          display:             'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap:                 '12px',
          marginBottom:        '16px',
        }}>
          <TelemetryChart
            data={stream}
            dataKey="pressure"
            label="CHAMBER PRESSURE"
            unit="bar"
            color="#d4af37"
            redlineMax={REDLINES.PRESSURE.max}
            redlineMin={REDLINES.PRESSURE.min}
            domain={[150, 320]}
          />
          <TelemetryChart
            data={stream}
            dataKey="temp"
            label="CHAMBER TEMPERATURE"
            unit="K"
            color="#3b82f6"
            redlineMax={REDLINES.TEMP.max}
            redlineMin={REDLINES.TEMP.min}
            domain={[2500, 4000]}
          />
          <TelemetryChart
            data={stream}
            dataKey="flow"
            label="PROPELLANT FLOW RATE"
            unit="kg/s"
            color="#8b5cf6"
            redlineMax={REDLINES.FLOW.max}
            redlineMin={REDLINES.FLOW.min}
            domain={[60, 160]}
          />
        </div>

        {/* ── ANOMALY LOG ───────────────────────────────────────────────── */}
        <AnomalyLog anomalies={anomalies} />

        {/* ── FOOTER ────────────────────────────────────────────────────── */}
        <footer style={{
          marginTop:     '20px',
          display:       'flex',
          justifyContent: 'space-between',
          fontSize:      '10px',
          fontFamily:    'monospace',
          color:         '#1f2937',
          letterSpacing: '1px',
        }}>
          <span>LOX/KEROSENE GAS-GENERATOR CYCLE — SIMULATION</span>
          <span>CHECKS: STATIC REDLINES · RATE-OF-CHANGE · SENSOR CORRELATION</span>
        </footer>
      </div>
    </>
  );
}
