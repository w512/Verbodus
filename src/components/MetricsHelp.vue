<script setup>
import { ttftClass, tpotClass, tpsClass } from "../store/metrics.js";

// Live samples that visually echo what the same thresholds do in the app —
// if the thresholds in metrics.js ever change, these examples re-colour
// automatically (no duplicated source of truth).
const TTFT_SAMPLES = [120, 500, 1500];
const TPOT_SAMPLES = [15, 40, 90];
const TPS_SAMPLES = [80, 30, 8];
</script>

<template>
  <div class="help-layout">
    <div class="main-content">
      <header class="view-header">
        <div>
          <h2>📖 Metrics & Methodology</h2>
          <p class="desc">
            What every number in Verbodus actually means, how it's measured, and
            when to take it with a grain of salt.
          </p>
        </div>
      </header>

      <!-- TOC -->
      <nav class="toc card glass-card" aria-label="Table of contents">
        <a href="#latency">Latency: TTFT &amp; TPOT</a>
        <a href="#throughput">Throughput: TPS</a>
        <a href="#tokens">Token counts</a>
        <a href="#bands">Color bands</a>
        <a href="#methodology">Iterations &amp; warm-up</a>
        <a href="#streaming">Streaming vs non-streaming</a>
        <a href="#cotenancy">Co-tenancy Δ</a>
        <a href="#caveats">Caveats</a>
      </nav>

      <!-- TTFT / TPOT -->
      <section id="latency" class="card glass-card">
        <h3>Latency — TTFT &amp; TPOT</h3>

        <div class="metric-block">
          <div class="metric-head">
            <span class="metric-tag">TTFT</span>
            <span class="metric-full">Time To First Token</span>
            <span class="metric-unit">ms · lower is better</span>
          </div>
          <p>
            Wall-clock time from sending the request to receiving the
            <strong>first</strong> content token. Dominated by the
            <strong>prefill</strong> phase — the model processing your prompt — plus
            network and server-side queueing.
          </p>
          <p class="formula">
            <code>TTFT = first_token_time − request_start</code>
          </p>
          <div class="samples">
            <span class="sample" :class="ttftClass(TTFT_SAMPLES[0])">{{ TTFT_SAMPLES[0] }} ms · excellent</span>
            <span class="sample" :class="ttftClass(TTFT_SAMPLES[1])">{{ TTFT_SAMPLES[1] }} ms · good</span>
            <span class="sample" :class="ttftClass(TTFT_SAMPLES[2])">{{ TTFT_SAMPLES[2] }} ms · slow</span>
          </div>
        </div>

        <div class="metric-block">
          <div class="metric-head">
            <span class="metric-tag">TPOT</span>
            <span class="metric-full">Time Per Output Token (decode latency)</span>
            <span class="metric-unit">ms · lower is better</span>
          </div>
          <p>
            Average ms per generated token, <strong>excluding</strong> the first one.
            Reflects the model's per-token decode cost. Dominated by model size,
            quantization, KV-cache size, and GPU/CPU speed.
          </p>
          <p class="formula">
            <code>TPOT = (last_token_time − first_token_time) / (N − 1)</code>
          </p>
          <p class="muted">
            Why <code>N − 1</code>? Between N tokens there are N − 1 intervals; the
            first token's cost belongs to prefill (TTFT), not decode.
          </p>
          <div class="samples">
            <span class="sample" :class="tpotClass(TPOT_SAMPLES[0])">{{ TPOT_SAMPLES[0] }} ms · excellent</span>
            <span class="sample" :class="tpotClass(TPOT_SAMPLES[1])">{{ TPOT_SAMPLES[1] }} ms · good</span>
            <span class="sample" :class="tpotClass(TPOT_SAMPLES[2])">{{ TPOT_SAMPLES[2] }} ms · slow</span>
          </div>
        </div>
      </section>

      <!-- TPS -->
      <section id="throughput" class="card glass-card">
        <h3>Throughput — TPS</h3>
        <div class="metric-block">
          <div class="metric-head">
            <span class="metric-tag">TPS</span>
            <span class="metric-full">Tokens Per Second (decode throughput)</span>
            <span class="metric-unit">tokens/s · higher is better</span>
          </div>
          <p>
            How many tokens per second the model generates after the first one.
            TPS is essentially the reciprocal of TPOT, but reported as a rate
            because that's what most people intuit. Excludes TTFT.
          </p>
          <p class="formula">
            <code>TPS = N / (last_token_time − first_token_time)</code>
          </p>
          <p class="muted">
            The live chart in the Playground is built from this value per chunk
            during the stream; the final number on the metric card uses
            <code>usage.completion_tokens</code> when the server reports it
            (more accurate). The saved curve is rescaled to match the headline
            on completion so chart and number agree.
          </p>
          <div class="samples">
            <span class="sample" :class="tpsClass(TPS_SAMPLES[0])">{{ TPS_SAMPLES[0] }} tps · excellent</span>
            <span class="sample" :class="tpsClass(TPS_SAMPLES[1])">{{ TPS_SAMPLES[1] }} tps · good</span>
            <span class="sample" :class="tpsClass(TPS_SAMPLES[2])">{{ TPS_SAMPLES[2] }} tps · slow</span>
          </div>
        </div>
      </section>

      <!-- Token counts -->
      <section id="tokens" class="card glass-card">
        <h3>Token counts</h3>
        <p>
          The <strong>Token Auditing</strong> card shows three values:
        </p>
        <ul>
          <li><strong>P</strong> — prompt tokens (input you sent, after the model tokenizer).</li>
          <li><strong>C</strong> — completion tokens (output the model generated).</li>
          <li><strong>Total</strong> — P + C.</li>
        </ul>
        <p>
          Source priority (best → fallback):
        </p>
        <ol>
          <li>
            <code>usage.prompt_tokens</code> / <code>usage.completion_tokens</code>
            from the OpenAI-compatible response (most accurate).
          </li>
          <li>
            <code>prompt_eval_count</code> / <code>eval_count</code> from Ollama's
            non-OpenAI metadata fields.
          </li>
          <li>
            Whitespace word-count of the response text — <em>rough</em>
            approximation, used only if neither of the above is available.
          </li>
        </ol>
        <p class="muted">
          Whitespace fallback can be off by 1.3–1.5× compared to real BPE tokens.
          Treat it as a smell rather than a measurement.
        </p>
      </section>

      <!-- Color bands -->
      <section id="bands" class="card glass-card">
        <h3>Color bands</h3>
        <p>
          A single source of truth (<code>src/store/metrics.js</code>) decides the
          colour of every metric value in the app. Bands:
        </p>
        <table class="bands-table">
          <thead>
            <tr><th>Metric</th><th class="band-excellent">Excellent</th><th class="band-good">Good</th><th class="band-slow">Slow</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>TTFT (ms)</td>
              <td>&lt; 250</td>
              <td>250 – 800</td>
              <td>≥ 800</td>
            </tr>
            <tr>
              <td>TPOT (ms)</td>
              <td>&lt; 22</td>
              <td>22 – 66</td>
              <td>≥ 66</td>
            </tr>
            <tr>
              <td>TPS</td>
              <td>&gt; 45</td>
              <td>15 – 45</td>
              <td>≤ 15</td>
            </tr>
          </tbody>
        </table>
        <p class="muted">
          Thresholds are conservative defaults — what a user typing at a console
          actually feels. Cloud APIs and small quantized models on a strong GPU
          can blow past "excellent" routinely.
        </p>
      </section>

      <!-- Iterations & warm-up -->
      <section id="methodology" class="card glass-card">
        <h3>Iterations &amp; warm-up</h3>
        <p>
          Both the Playground and Co-Tenancy modes accept two knobs:
        </p>
        <ul>
          <li>
            <strong>Iterations</strong> (N): how many measured runs to perform. Each
            metric on the card shows the <strong>median</strong> with a min–max range.
            Median is robust against the occasional jittery run.
          </li>
          <li>
            <strong>Warm-up</strong>: runs done <em>first</em> and then thrown away. The
            first call to a model often pays a one-time cost (load into VRAM, JIT
            kernel selection), which would skew the average otherwise.
          </li>
        </ul>
        <p>
          One series is saved to history as <strong>one</strong> entry; the saved
          curve and output text come from the last measured run.
        </p>
      </section>

      <!-- Streaming -->
      <section id="streaming" class="card glass-card">
        <h3>Streaming vs non-streaming</h3>
        <p>
          When <strong>Enable Token Streaming</strong> is off, the server sends one
          response blob. We can't tell where prefill ended and decode began, so:
        </p>
        <ul>
          <li>TTFT and TPOT are reported as <code>--</code> / <code>N/A</code>.</li>
          <li>TPS becomes <em>aggregate</em> throughput over the whole request (still meaningful, but mixes prefill in).</li>
        </ul>
        <p>
          Use streaming whenever the endpoint supports it — that's the only way to
          get an honest TTFT / TPOT split.
        </p>
      </section>

      <!-- Co-tenancy -->
      <section id="cotenancy" class="card glass-card">
        <h3>Co-tenancy Δ</h3>
        <p>
          The Co-Tenancy view runs three phases — Solo A, Solo B, Paired A∥B — and
          reports a <strong>delta</strong> per metric per side:
        </p>
        <p class="formula">
          <code>Δ = (paired − solo) / solo</code>
        </p>
        <ul>
          <li>For <strong>latency</strong> (TTFT, TPOT): <code>Δ &gt; 0</code> means worse under contention.</li>
          <li>For <strong>throughput</strong> (TPS): <code>Δ &lt; 0</code> means worse under contention.</li>
          <li>|Δ| &lt; 5 % is treated as no-impact and shown in the "good" colour.</li>
        </ul>
        <p>
          The headline interpretation: <em>"how much does each model degrade when
          another LLM is running on the same hardware?"</em>
        </p>
      </section>

      <!-- Caveats -->
      <section id="caveats" class="card glass-card">
        <h3>Caveats</h3>
        <ul>
          <li>
            <strong>Output length skews TPS.</strong> Longer responses amortise TTFT
            and the early decode jitter, nudging TPS upward. Keep
            <code>max_tokens</code> and the prompt difficulty stable between runs you
            want to compare.
          </li>
          <li>
            <strong>Tokenizer differences.</strong> "TPS" on a model with a more
            efficient tokenizer can be lower in tokens/s while producing the same
            amount of text in the same time. Cross-model TPS isn't a pure-perf
            comparison.
          </li>
          <li>
            <strong>JS event-loop jitter</strong> in Co-Tenancy paired mode adds a few
            ms to TPOT measurements when both streams arrive rapidly (two SSE
            parsers share one thread). Negligible on local models; noticeable on
            very fast cloud APIs.
          </li>
          <li>
            <strong>Whitespace token fallback</strong> is rough — see
            <a href="#tokens">Token counts</a>.
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.help-layout {
  display: flex;
  height: 100vh;
  width: 100%;
  overflow: hidden;
}
.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 24px;
  overflow-y: auto;
  min-width: 0;
  gap: 16px;
  scroll-behavior: smooth;
  scroll-padding-top: 16px; /* leave room above the anchored section */
}
.view-header h2 { font-size: 22px; color: var(--text-primary); }
.desc {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 4px;
  max-width: 620px;
  line-height: 1.5;
}

.card {
  border-radius: 12px;
  padding: 20px 24px;
}
.card h3 {
  font-size: 16px;
  color: var(--text-primary);
  margin-bottom: 14px;
  font-weight: 700;
}
.card p, .card ul, .card ol { line-height: 1.6; }
.card p { margin: 0 0 0.6em; }
.card ul, .card ol {
  margin: 0 0 0.6em;
  padding-left: 1.4em;
  color: var(--text-secondary);
  font-size: 13px;
}
.card li { margin: 0.2em 0; }
.card li strong { color: var(--text-primary); }

/* TOC */
.toc {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 14px 20px;
}
.toc a {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-decoration: none;
  padding: 6px 10px;
  background: var(--surface-1);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  transition: all 0.15s;
}
.toc a:hover {
  background: var(--surface-2);
  color: var(--accent-cyan);
  border-color: var(--border-color-hover);
}

/* Metric blocks */
.metric-block {
  padding: 14px 0;
  border-top: 1px solid var(--border-color);
}
.metric-block:first-of-type { border-top: none; padding-top: 0; }
.metric-block:last-of-type { padding-bottom: 0; }

.metric-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.metric-tag {
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  font-weight: 700;
  background: rgba(6, 182, 212, 0.12);
  color: var(--accent-cyan);
  padding: 3px 8px;
  border-radius: 4px;
  letter-spacing: 0.04em;
}
.metric-full {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.metric-unit {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-muted);
  font-style: italic;
}

.formula {
  background: var(--surface-1);
  border-left: 3px solid var(--accent-indigo);
  padding: 8px 12px;
  border-radius: 0 6px 6px 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12.5px;
  color: var(--text-primary);
  margin: 8px 0 !important;
}
.formula code { background: transparent; padding: 0; }

.samples {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.sample {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 700;
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--surface-1);
  border: 1px solid var(--border-color);
}

.muted {
  color: var(--text-muted);
  font-size: 12px;
}

/* Bands table */
.bands-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  margin-top: 4px;
}
.bands-table th, .bands-table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  text-align: left;
}
.bands-table tbody tr:last-child td { border-bottom: none; }
.bands-table th {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}
.bands-table th.band-excellent { color: var(--color-success); }
.bands-table th.band-good { color: var(--color-warning); }
.bands-table th.band-slow { color: var(--color-danger); }
.bands-table td:first-child { color: var(--text-primary); font-weight: 600; }

/* Inline code */
.card code {
  background: rgba(110, 118, 129, 0.2);
  color: var(--text-primary);
  padding: 0.1em 0.4em;
  border-radius: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.9em;
}

/* Anchor links inside body */
.card a {
  color: var(--accent-cyan);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.card a:hover { filter: brightness(1.2); }

</style>
