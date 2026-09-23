# CLI ownership

[specrails-desktop.ts](specrails-desktop.ts) is the executable composition entry
and preserves existing exports for consumers/tests. Command routing and exit
handling stay there. Other responsibilities have focused modules:

- [args.ts](args.ts): pure verb/option parsing.
- [format.ts](format.ts): formatting without I/O.
- [output.ts](output.ts), [help.ts](help.ts): terminal output and package metadata.
- [desktop-client.ts](desktop-client.ts): HTTP detection, authentication and timeouts.
- [run-command.ts](run-command.ts): manager/WebSocket execution and direct fallback.
- [desktop-control.ts](desktop-control.ts): desktop lifecycle and project commands.
- [status.ts](status.ts): status/history commands.
- [win-spawn.ts](win-spawn.ts): platform-specific spawning.

Keep argument parsing independent of transports and processes. Command handlers
must not import the executable entry point. Preserve HTTP timeout, token scope,
exit codes and npm/source resource lookup semantics. Run `npx vitest run cli` and
package checks after changes to executable or resource paths.
