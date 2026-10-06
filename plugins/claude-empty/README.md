# Claude Empty Plugin

Minimal starter plugin for Claude with support for:

- **Skills**: place skill files in `skills/`
- **MCP**: configure MCP servers via `claude_desktop_config.json`

## Structure

- `skills/` — skill definitions (starter example included)
- `mcp/server.js` — minimal MCP server stub command target
- `claude_desktop_config.json` — example Claude Desktop MCP configuration

## Quick start

1. Edit `mcp/server.js` to implement your MCP tools/resources.
2. Add or replace files in `skills/` with your own skills.
3. Merge the `mcpServers` entry from `claude_desktop_config.json` into your Claude Desktop config.
