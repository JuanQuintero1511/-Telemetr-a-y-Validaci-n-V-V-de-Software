"""
turbopump_sim.py — Liquid Rocket Engine Telemetry Simulator
============================================================
Simulates sensor telemetry for a pressure-fed / gas-generator cycle engine
operating on LOX/Kerosene propellants.

Physics model (simplified):
  - Chamber pressure rises with propellant flow rate
  - Temperature follows an adiabatic flame temperature curve
  - Random Gaussian noise models real sensor uncertainty
  - Anomaly injection tests the V&V backend's detection capability

Transmission: UDP/JSON at configurable frequency (default: 10 Hz)
"""

import socket
import time
import json
import random
import math
import argparse

# ─────────────────────────────────────────────
# CONFIGURATION
# ─────────────────────────────────────────────
UDP_IP      = "127.0.0.1"
UDP_PORT    = 5005
FREQ_HZ     = 10          # Samples per second
CYCLE_S     = 1.0 / FREQ_HZ

# Nominal operating parameters (LOX/Kerosene engine at full thrust)
NOM_PRESSURE_BAR   = 250.0   # bar   — nominal chamber pressure
NOM_TEMP_K         = 3500.0  # K     — nominal adiabatic flame temperature
NOM_FLOW_KGS       = 120.0   # kg/s  — nominal propellant mass flow rate

# Sensor noise (Gaussian std dev — realistic sensor uncertainty)
NOISE_PRESSURE     = 4.5     # bar
NOISE_TEMP         = 45.0    # K
NOISE_FLOW         = 1.8     # kg/s

# Anomaly injection (after 10s mission time)
ANOMALY_PROB       = 0.05    # 5% per sample probability of a pressure spike
ANOMALY_MAGNITUDE  = (50.0, 100.0)  # bar range for spike

# ─────────────────────────────────────────────
# PHASE MODEL
# ─────────────────────────────────────────────
def get_phase_multiplier(t: float) -> tuple[float, str]:
    """
    Returns (multiplier, phase_name) for a given mission time.
    Models ignition → ramp-up → nominal thrust → coast.
    """
    if t < 0:
        return 0.0, "PRELAUNCH"
    elif t < 3.0:
        # Smooth ignition ramp using sigmoid
        x = t / 3.0
        mult = x * x * (3 - 2 * x)  # smoothstep
        return mult, "IGNITION"
    elif t < 8.0:
        # Fine ramp to full thrust
        x = (t - 3.0) / 5.0
        mult = 0.6 + 0.4 * x
        return mult, "RAMP_UP"
    else:
        return 1.0, "NOMINAL"


# ─────────────────────────────────────────────
# TELEMETRY GENERATION
# ─────────────────────────────────────────────
def generate_telemetry(t: float) -> dict:
    """
    Generates a single telemetry packet for mission time t.
    Includes physics-based model + Gaussian noise + anomaly injection.
    """
    multiplier, phase = get_phase_multiplier(t)

    # --- Nominal values (physics model) ---
    pressure = NOM_PRESSURE_BAR * multiplier
    temp     = NOM_TEMP_K       * multiplier
    flow     = NOM_FLOW_KGS     * multiplier

    # --- Sensor noise ---
    pressure += random.gauss(0, NOISE_PRESSURE * (multiplier + 0.1))
    temp     += random.gauss(0, NOISE_TEMP     * (multiplier + 0.1))
    flow     += random.gauss(0, NOISE_FLOW     * (multiplier + 0.1))

    # --- Anomaly injection (V&V test case) ---
    status = phase
    if t > 10.0 and random.random() < ANOMALY_PROB:
        spike = random.uniform(*ANOMALY_MAGNITUDE)
        pressure += spike
        status = "WARNING"

    return {
        "timestamp":    round(time.time(), 4),
        "mission_time": round(t, 3),
        "sensor_data": {
            "chamber_pressure_bar": round(max(pressure, 0.0), 3),
            "chamber_temp_k":       round(max(temp, 0.0),     3),
            "propellant_flow_kgs":  round(max(flow, 0.0),     3),
        },
        "engine_status": status,
    }


# ─────────────────────────────────────────────
# MAIN LOOP
# ─────────────────────────────────────────────
def main(duration_s: float | None = None):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    start = time.perf_counter()

    print(f"🚀 Turbopump simulator → UDP {UDP_IP}:{UDP_PORT} @ {FREQ_HZ} Hz")
    if duration_s:
        print(f"   Duration: {duration_s}s")
    print("   Press Ctrl+C to stop (MECO)\n")

    try:
        while True:
            t = time.perf_counter() - start
            if duration_s and t >= duration_s:
                print(f"\n✅ Nominal burn complete at T+{t:.1f}s (MECO)")
                break

            packet  = generate_telemetry(t)
            payload = json.dumps(packet).encode("utf-8")
            sock.sendto(payload, (UDP_IP, UDP_PORT))

            # Concise console log
            sd = packet["sensor_data"]
            flag = "🚨" if packet["engine_status"] == "WARNING" else "  "
            print(
                f"{flag} T+{packet['mission_time']:06.2f}s  "
                f"P={sd['chamber_pressure_bar']:6.1f} bar  "
                f"T={sd['chamber_temp_k']:7.1f} K  "
                f"ṁ={sd['propellant_flow_kgs']:5.1f} kg/s  "
                f"[{packet['engine_status']}]"
            )

            # Drift-corrected sleep (maintains accurate frequency)
            elapsed = time.perf_counter() - start - t
            sleep_t = max(0.0, CYCLE_S - elapsed % CYCLE_S)
            time.sleep(sleep_t)

    except KeyboardInterrupt:
        print(f"\n🛑 MECO — simulation stopped by operator at T+{t:.1f}s")
    finally:
        sock.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="LOX/Kerosene engine telemetry simulator")
    parser.add_argument("--duration", type=float, default=None,
                        help="Run duration in seconds (default: infinite)")
    args = parser.parse_args()
    main(duration_s=args.duration)
