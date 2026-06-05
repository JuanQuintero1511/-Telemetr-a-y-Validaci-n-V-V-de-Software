# Telemetry Acquisition & V&V Software Simulator

A full-stack platform for real-time telemetry acquisition and automated software Validation & Verification (V&V), designed to replicate the data flows and testing workflows present in launch vehicle avionics systems.

Built as a portfolio project oriented toward the **new space sector**, with architecture and testing philosophy inspired by ESA's **ECSS-E-ST-40C** software engineering standard.

---

## Overview

This system simulates the complete pipeline of a flight software V&V campaign:

1. A **data generator** emits continuous telemetry frames (temperature, pressure, acceleration, valve states) over a real-time connection, simulating sensor output from a launch vehicle.
2. A **backend server** receives, processes, and stores telemetry data, while running automated validation checks against defined operational limits.
3. A **React dashboard** visualizes live telemetry streams, anomaly alerts, and V&V test results in real time.

---

## Architecture

```
┌─────────────────────┐        WebSocket / Socket.io        ┌──────────────────────┐
│   Data Generator    │ ──────────────────────────────────► │   Backend Server     │
│   (Python)          │                                      │   (Node.js)          │
│                     │                                      │                      │
│  · Telemetry sim    │                                      │  · Data ingestion    │
│  · Sensor models    │                                      │  · V&V engine        │
│  · Fault injection  │                                      │  · Anomaly detection │
└─────────────────────┘                                      │  · Results storage   │
                                                             └──────────┬───────────┘
                                                                        │
                                                                        │ Socket.io
                                                                        ▼
                                                             ┌──────────────────────┐
                                                             │   React Dashboard    │
                                                             │   (Vite + Recharts)  │
                                                             │                      │
                                                             │  · Live telemetry    │
                                                             │  · V&V test results  │
                                                             │  · Anomaly alerts    │
                                                             └──────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Data Generator | Python 3.x |
| Backend | Node.js · Socket.io |
| Frontend | React 19 · Vite · Recharts |
| Real-time comms | WebSocket (Socket.io) |
| Linting | ESLint |

---

## Key Features

### Telemetry simulation
- Continuous generation of multi-parameter telemetry (temperature, pressure, acceleration, system states)
- Configurable nominal ranges and fault injection for anomaly testing
- Real-time transmission via WebSocket

### Automated V&V engine
- Rule-based validation of incoming telemetry against operational limits
- Anomaly detection with severity classification
- Structured test result logging inspired by ECSS V&V campaign documentation

### Live dashboard
- Real-time charts for each telemetry parameter using Recharts
- Visual anomaly alerts with parameter identification
- V&V status panel showing pass/fail state per validation rule

---

## Project Structure

```
├── Data-generator/       # Python telemetry simulator
├── backend/              # Node.js server — data ingestion and V&V engine
├── src/                  # React frontend — dashboard components
├── public/               # Static assets
├── index.html
├── vite.config.js
└── package.json
```

---

## Getting Started

### Prerequisites
- Node.js 18+
- Python 3.9+

### Installation

```bash
# Clone the repository
git clone https://github.com/JuanQuintero1511/-Telemetr-a-y-Validaci-n-V-V-de-Software.git
cd -Telemetr-a-y-Validaci-n-V-V-de-Software

# Install frontend and backend dependencies
npm install

# Install Python dependencies
cd Data-generator
pip install -r requirements.txt
```

### Running the system

```bash
# 1. Start the backend server
cd backend
node server.js

# 2. Start the telemetry data generator
cd Data-generator
python generator.py

# 3. Start the React dashboard
npm run dev
```

Open `http://localhost:5173` to view the dashboard.

---

## Aerospace Context

This project was built with the operational reality of launch vehicle software teams in mind:

- **V&V philosophy** follows the principles of ECSS-E-ST-40C, the ESA software engineering standard used across European space programs, covering test traceability, anomaly reporting, and validation campaign structure.
- **Real-time telemetry** architecture mirrors the TM/TC data flows present in ground support systems during static fire and flight campaigns.
- **Fault injection** capability allows validation of the V&V engine's response to out-of-range sensor data, replicating the kind of stress testing performed on flight software before launch.

---

## Author

**Juan Manuel Rodríguez Quintero**  
Mechatronics Engineer · Full Stack Developer  
[GitHub](https://github.com/JuanQuintero1511) · juanrodriguezq2711@gmail.com  
Available for relocation to Elche, Spain
