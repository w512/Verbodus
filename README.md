# ⚡ Verbodus (LLM Speedometer)

**Verbodus** is a fast and lightweight desktop application designed to benchmark the performance and generation latency of Large Language Models (LLMs) in real time. It connects to any OpenAI-compatible API endpoint (such as local engines like Ollama, LM Studio, and vLLM, or remote cloud services) to evaluate throughput, prefill latency, and decode speed with high precision.

Built with **Tauri v2**, **Vue 3**, and **Chart.js**, Verbodus features a modern glassmorphism user interface designed for developers who want to inspect and compare model execution speeds locally on their machines.

---

## ✨ Key Features

- **Performance Playground**: Execute custom prompts and watch streaming responses generate in real time with an interactive caret and live telemetry stats.
- **KPI Metrics Dashboard**: Tracks standard industry benchmarks with color-coded performance indicators:
  - **TTFT (Time to First Token / Prefill Latency)**: Measures prompt processing responsiveness.
  - **TPOT (Time Per Output Token / Decode Latency)**: Measures average token-by-token generation latency.
  - **TPS (Tokens Per Second / Throughput)**: Measures overall streaming generation speed.
  - **Token Auditing**: Displays counts for Prompt, Completion, and Total tokens.
- **Real-Time Throughput Curve**: Renders a dynamic line chart of generation throughput (TPS over time) as token chunks stream in.
- **Engine Comparison Dashboard**:
  - Compare up to 4 historical benchmark runs side-by-side.
  - Dual-axis bar chart contrasting TTFT (ms) against Average TPS.
  - Detailed metadata inspector displaying prompt parameters and exact token breakdowns.
- **Custom API Profiles**: Setup and save configuration presets for local or remote servers. Adjust generation properties like Temperature, Max Tokens, System Prompts, and toggle between Streaming and Non-Streaming modes.
- **Persistent Storage**: All runs history and API profiles are persisted locally in browser-native storage.

---

## 📊 Performance Thresholds

Verbodus automatically color-codes your benchmark results based on latency and throughput thresholds:

| Metric | 🟢 Excellent | 🟡 Good | 🔴 Slow |
| :--- | :--- | :--- | :--- |
| **TTFT** (Time to First Token) | `< 250 ms` | `250 ms - 800 ms` | `> 800 ms` |
| **TPOT** (Time per Output Token) | `< 22 ms` | `22 ms - 66 ms` | `> 66 ms` |
| **Throughput** (Tokens/Second) | `> 45 tps` | `15 tps - 45 tps` | `< 15 tps` |

---

## 🛠️ Technology Stack

- **Frontend**: Vue 3 (Composition API / `<script setup>`)
- **Styling**: Vanilla CSS (Custom properties, CSS variables, glassmorphic filters)
- **Charts**: Chart.js (Dual-axis charts & real-time line charts)
- **Desktop Runtime**: Tauri v2 (utilizing native macOS WebKit / WebViews)
- **Build System**: Vite

---

## 🚀 Getting Started

### Prerequisites

To run Verbodus locally, ensure you have:
1. **Node.js** (v18 or higher recommended)
2. **Rust & Cargo** (required for compiling the Tauri desktop client)
3. **Local LLM Engine** (any OpenAI-compatible API running locally):
   - **Ollama**: [Download & Install](https://ollama.com) (Default API port: `11434`)
   - **LM Studio**: [Download & Install](https://lmstudio.ai) (Default API port: `1234`)
   - **vLLM**: [Documentation](https://docs.vllm.ai) (Default API port: `8000`)

### Installation

1. Clone the repository and navigate to the project directory:
   ```bash
   cd "LLM Speedometer"
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

### Running the Application

#### 🌐 Running in the Web Browser (Vite Dev Server)
To run a fast-loading web-only preview in your default browser:
```bash
npm run dev
```
Open `http://localhost:1420` in your browser.

#### 🖥️ Running as a Desktop App (Tauri Development Mode)
To compile the Tauri Rust backend and launch the native desktop window:
```bash
npm run tauri dev
```

#### 📦 Building the Production Binary
To package the final, production-ready desktop bundle:
```bash
npm run tauri build
```
This compiles the Rust backend in release mode and bundles the Vue assets. The final `.app` or installer will be located in `src-tauri/target/release/bundle/`.

---

## ⚙️ Configuration & Presets

Verbodus comes pre-configured with popular local LLM defaults:

- **Ollama**:
  - API URL: `http://localhost:11434/v1`
  - Default Model: `llama3`
- **LM Studio**:
  - API URL: `http://localhost:1234/v1`
  - Default Model: `lmstudio-community`
- **vLLM / Local Engine**:
  - API URL: `http://localhost:8000/v1`
  - Default Model: `meta-llama/Meta-Llama-3-8B-Instruct`

*Note: For engines requiring authentication (such as remote OpenAI, Anthropic-compatible proxies, or Groq), you can enter your API Key directly in the profile parameters panel.*

## 📄 License

This project is licensed under the GNU General Public License v3 - see the [LICENSE](LICENSE.txt) file for details.
