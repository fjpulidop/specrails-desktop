# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest published release | ✅ |
| All previous releases | ❌ |

We only provide security fixes for the latest release. Please upgrade to the latest version before reporting a vulnerability.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use GitHub's [private security advisory feature](https://github.com/fjpulidop/specrails-desktop/security/advisories/new) to report vulnerabilities confidentially.

Include in your report:
- A clear description of the vulnerability and its potential impact
- Steps to reproduce the issue
- The version of specrails-desktop affected (server, CLI, and/or client)
- Any relevant configuration or environment details
- Proof of concept or exploit code (if applicable)

## Response Timeline

| Step | SLA |
|------|-----|
| Initial acknowledgment | 48 hours |
| Triage and severity assessment | 7 days |
| Resolution timeline communicated | 14 days |
| Patch released (critical) | As soon as practicable |

## Responsible Disclosure Policy

We ask that you:
- Give us reasonable time to investigate and remediate before public disclosure
- Avoid accessing or modifying user data without permission
- Avoid disrupting production services during testing

In return, we commit to:
- Acknowledging your report promptly
- Keeping you informed of our progress
- Crediting you in the security advisory (unless you prefer anonymity)

## Security Updates

Security patches are released as patch releases as soon as practicable. We recommend always running the latest version:

```bash
npm update -g specrails-desktop
```

Subscribe to [GitHub security advisories](https://github.com/fjpulidop/specrails-desktop/security/advisories) for this repository to receive notifications.

## Scope

This policy covers:
- The specrails-desktop server (`server/`)
- The specrails-desktop CLI (`cli/`)
- The specrails-desktop web client (`client/`)
- The Specrails desktop application (`src-tauri/`, built on Tauri v2), including its bundled Node and Git runtimes and the auto-updater

It does not cover vulnerabilities in third-party tools invoked by the app (e.g., Claude Code, Codex CLI, GitHub CLI), or issues in the user's own project repositories managed through specrails-desktop.

## Agent Actions Audit Log

Each project database keeps an `agent_actions` table recording what agents read, wrote, executed, called over MCP or fetched (see [docs/internals/agent-actions-audit.md](docs/internals/agent-actions-audit.md)). It is designed to be safe to export and share:

- It stores targets only: file paths, commands, MCP tool names and URLs. File contents, tool outputs, diffs, MCP arguments and environment values are never stored.
- Commands are redacted before storage: `NAME=value` assignments keep only the name, secret-looking flags (`--token`, `--password`, `--api-key`, …), `Authorization`/`Bearer` values, URL credentials and common token formats are replaced by `***`. URL query strings are dropped.
- Redaction is pattern-based. A secret passed in an unusual form (for example a bare positional argument) can still appear in a command target; review exports before sharing them outside your team.
- Rows are deleted after the project's retention window (default 30 days).
- The log is only as complete as each provider's stream: it is an aid for review, not a security boundary.

## Build & Artifact Integrity

We build and publish artifacts so you can verify what you run:

- **npm packages** are published from CI with [provenance attestation](https://docs.npmjs.com/generating-provenance-statements) (`npm publish --provenance --access public`, SLSA Level 2), linking each release back to the source commit and workflow that produced it.
- **Desktop installers** are built in CI from source. The bundled Node and Git runtimes are downloaded with pinned SHA256 checksums (and Git on macOS is built from a checksum-pinned source tarball). The macOS `.dmg` is **signed and notarized** by Apple.
- **Windows installers are unsigned in v1** by design. Running them triggers a Microsoft Defender SmartScreen warning ("More info → Run anyway"). This is expected, documented behavior — not a vulnerability. See [docs/platforms/windows.md](docs/platforms/windows.md).
- A machine-readable `manifest.json` in the `latest/` release channel publishes the SHA256 hash and size of every installer. You can verify a downloaded installer against its hash before running it (see [docs/platforms/windows.md](docs/platforms/windows.md) and [docs/platforms/macos.md](docs/platforms/macos.md)).
