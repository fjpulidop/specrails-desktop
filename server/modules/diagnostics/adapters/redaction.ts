/**
 * The redactor every diagnostics file goes through. It reuses the server's
 * existing redaction instead of a new pattern set:
 * - the exact values of the secrets this server knows (desktop API token,
 *   host-control token, MCP token), replaced wherever they appear;
 * - `redactProse` from the agent actions audit (PEM keys, credentials in URLs,
 *   Authorization/Cookie headers, Bearer tokens, `name=value` secrets and the
 *   GitHub/OpenAI/Anthropic/Slack/AWS/Google/GitLab/npm token shapes);
 * - `stripHome` from the mobile gateway (the home folder becomes `~`, so paths
 *   keep their shape but not the account name).
 * `buildReportFiles` adds the quoted-JSON-field rule on top.
 */
import { redactProse } from '../../audit'
import { stripHome } from '../../../mobile/mobile-redact'
import { REDACTED, type TextRedactor } from '../domain'

/** Shorter values are not distinctive enough to replace literally. */
const MIN_KNOWN_SECRET_LENGTH = 12

export function createDiagnosticRedactor(knownSecrets: () => Array<string | null | undefined>): TextRedactor {
  return (text: string) => {
    let out = text
    const secrets = knownSecrets()
      .filter((secret): secret is string => typeof secret === 'string' && secret.trim().length >= MIN_KNOWN_SECRET_LENGTH)
      .sort((a, b) => b.length - a.length)
    for (const secret of secrets) out = out.split(secret).join(REDACTED)
    return stripHome(redactProse(out))
  }
}
