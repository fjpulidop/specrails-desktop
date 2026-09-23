import type { ProviderId } from './types'

// ─── Telemetry env helpers ────────────────────────────────────────────────────

/** Build the OTLP/telemetry environment variable block for a spawned AI-CLI
 * process. Extracted as a pure function so it is unit-testable without a full
 * spawn.
 *
 * Provider-aware: claude and codex honour the standard `OTEL_*` env-var
 * convention (plus claude's `CLAUDE_CODE_ENABLE_TELEMETRY=1` master switch),
 * but the Gemini CLI does NOT — it reads its own `GEMINI_TELEMETRY_*` prefixed
 * vars (verified against google-gemini/gemini-cli docs/cli/telemetry.md) and
 * defaults to gRPC, so gemini rails need `GEMINI_TELEMETRY_OTLP_PROTOCOL=http`
 * and the OTLP endpoint pointed at our loopback receiver. Resource attributes
 * still flow via the standard `OTEL_RESOURCE_ATTRIBUTES` (read by the OTel JS
 * SDK that the Gemini CLI uses), so the receiver can route by job/project id.
 *
 * The `providerId` argument defaults to `'claude'` so existing claude/codex
 * call paths stay byte-identical. */
export function buildTelemetryEnv(
  jobId: string,
  projectId: string,
  desktopPort: number,
  extraResourceAttributes: Record<string, string | number> = {},
  providerId: ProviderId = 'claude',
): Record<string, string> {
  const baseAttrs: Array<[string, string]> = [
    ['specrails.job_id', jobId],
    ['specrails.project_id', projectId],
  ]
  for (const [k, v] of Object.entries(extraResourceAttributes)) {
    baseAttrs.push([k, String(v)])
  }
  const resourceAttributes = baseAttrs.map(([k, v]) => `${k}=${v}`).join(',')
  const endpoint = `http://127.0.0.1:${desktopPort}/otlp`

  if (providerId === 'gemini') {
    // Gemini CLI uses its own env contract (not OTEL_*). Defaults to gRPC, so we
    // must force the http transport to reach our OTLP/HTTP JSON receiver, and
    // target the `local` backend (not gcp). OTEL_RESOURCE_ATTRIBUTES is still
    // honoured by the underlying OTel SDK for job/project routing.
    return {
      GEMINI_TELEMETRY_ENABLED: 'true',
      GEMINI_TELEMETRY_TARGET: 'local',
      GEMINI_TELEMETRY_OTLP_ENDPOINT: endpoint,
      GEMINI_TELEMETRY_OTLP_PROTOCOL: 'http',
      GEMINI_TELEMETRY_TRACES_ENABLED: 'true',
      OTEL_RESOURCE_ATTRIBUTES: resourceAttributes,
    }
  }

  // claude (master switch + OTEL_*) and codex (OTEL_* only) — byte-identical to
  // the pre-fix block for both.
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_RESOURCE_ATTRIBUTES: resourceAttributes,
  }
}

