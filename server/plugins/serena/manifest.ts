import type { PluginManifest } from '../../types'

export const serenaManifest: PluginManifest = {
  name: 'serena',
  version: '1.0.0',
  description: 'Semantic code navigation via Language Server Protocol. Lets agents look up symbols, references, and definitions instead of grepping or reading whole files — typically cutting input tokens 40–60% on real workloads.',
  whatItDoes: [
    'Adds a Serena MCP server backed by uvx (Python).',
    'Exposes find_symbol, find_referencing_symbols, find_declaration, find_implementations, get_symbols_overview, and replace_symbol_body to all agents.',
    'Auto-detects project language; supports TS/JS, Python, Go, Rust, Java, and more.',
    'Runs locally — your code never leaves your machine.',
  ],
  platformNotes: {
    'darwin-arm64': 'On Apple Silicon, macOS may prompt to install Rosetta the first time Serena runs. Some Python language-server dependencies ship x86_64 only; click "Install" on the Apple prompt — it is safe and only happens once.',
  },
  category: 'code-navigation',
  requirements: [
    { name: 'uv', minVersion: '0.1.0' },
  ],
  owns: {
    mcpServers: ['serena'],
    agentFragments: ['.claude/agents/custom-serena.md'],
  },
  providerSupport: {
    // claude: project-json `.mcp.json` merge (existing path).
    claude: {
      mcpEntry: {
        command: 'uvx',
        args: [
          '--from',
          'git+https://github.com/oraios/serena',
          'serena',
          'start-mcp-server',
          '--context',
          'ide-assistant',
          '--project',
          '.',
          '--enable-web-dashboard',
          'false',
        ],
      },
    },
    // Codex records installation in its per-project home; actual invocations
    // receive this descriptor as -c overrides and retain the user's auth home.
    codex: {
      mcpEntry: {
        command: 'uvx',
        args: [
          '--from',
          'git+https://github.com/oraios/serena',
          'serena',
          'start-mcp-server',
          '--context',
          'ide-assistant',
          '--project',
          '.',
          '--enable-web-dashboard',
          'false',
        ],
      },
    },
    kimi: {
      mcpEntry: {
        command: 'uvx',
        args: [
          '--from',
          'git+https://github.com/oraios/serena',
          'serena',
          'start-mcp-server',
          '--context',
          'ide-assistant',
          '--project',
          '.',
          '--enable-web-dashboard',
          'false',
        ],
      },
    },
  },
  // Format: structured "when / tools / why / fallback" block. Lets generic
  // agent prompts (specrails-core sr-* "Tool Selection — Honor Project-
  // Documented MCP Tools" section) match the right entry to the task.
  //
  // Tool names below are verified against Serena's actual exposed MCP tools.
  // Keep this list aligned
  // with upstream — wrong names cause agents to mistrust the whole block.
  claudeMdInstructions: `## Plugin: serena (semantic code navigation)

**When to use**: Locating symbols, references, definitions, or implementations in source code; renaming or refactoring a single function in place; getting a file-level symbol skeleton without reading the whole file.

**Tools** (all prefixed \`mcp__serena__\`):
- \`find_symbol\` — locate a class, function, or method by name path.
- \`find_referencing_symbols\` — list every caller / usage of a symbol.
- \`find_declaration\` — jump to where a symbol is defined.
- \`find_implementations\` — find concrete implementations of an interface or abstract method.
- \`get_symbols_overview\` — file-level symbol skeleton (signatures only, no bodies).
- \`replace_symbol_body\` — replace one function's body without re-reading or re-writing the rest of the file.
- \`insert_before_symbol\` / \`insert_after_symbol\` — splice new code adjacent to a known symbol without rewriting the file.
- \`rename_symbol\` — rename a symbol and update its references.
- \`safe_delete_symbol\` — remove a symbol and its references.
- \`replace_content\` — surgical text replace inside a single file when symbol-aware tools don't fit.
- \`get_diagnostics_for_file\` — language-server diagnostics for a file.

**Why prefer over built-ins**: Serena returns only the relevant symbol body, not whole files. Empirically cuts input tokens 40–60% on real workloads compared with whole-file reads or broad text search.

**Fallback to the provider's built-in file/search tools for**: binary files, free-form prose, structured data without symbols (logs, JSON without schema, plain Markdown).

**Delegated agents**: when the active provider supports delegation, tell the delegated role to use these Serena tools. MCP inheritance is provider-owned, so verify availability in the delegated context and fall back to built-in file/search tools when needed.`,
}

export const SERENA_MCP_ENTRY = {
  command: 'uvx',
  args: [
    '--from',
    'git+https://github.com/oraios/serena',
    'serena',
    'start-mcp-server',
    '--context',
    'ide-assistant',
    '--project',
    '.',
    // Suppress the auto-opened web dashboard. Serena defaults to launching a
    // local browser tab on start; users running rail jobs find the popup
    // disruptive.
    '--enable-web-dashboard',
    'false',
  ],
}
