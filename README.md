# personal-context-mcp

A lightweight [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives AI assistants (like Claude) access to a set of personal context files — things like your bio, preferences, career background, and communication style — stored as local Markdown files.

Instead of re-explaining who you are at the start of every conversation, this server lets the AI load exactly the context it needs, on demand.

## How it works

The server reads `.md` files from a `context/` directory and exposes them through MCP tools and resources. The AI can list available files, load specific ones, or update them as your information evolves.

## Tools

| Tool | Description |
|------|-------------|
| `get_index` | Returns `index.md` — a table of contents describing what each context file contains. Call this first. |
| `get_context_file` | Loads a single context file by name (without the `.md` extension). |
| `get_all_context` | Returns all context files concatenated. Use when full context is needed. |
| `update_context_file` | Overwrites a context file with new content. |
| `append_to_context_file` | Appends content to a context file without overwriting it. |

## Resources

Context files are also exposed as MCP resources via the `context://` URI scheme (e.g. `context://bio.md`), making them accessible to MCP clients that prefer resource-based access.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Create your context files

Create a `context/` directory in the project root and populate it with `.md` files. At minimum, create an `index.md` that describes what each file contains — the AI will read this first.

Example structure:

```
context/
  index.md        # Table of contents — describes each file
  bio.md          # Who you are
  preferences.md  # Communication style, tool preferences
  career.md       # Work history and current role
```

The `context/` directory is listed in `.gitignore` to keep your personal data private.

### 4. Configure in Claude Desktop (or any MCP client)

Add the server to your MCP client configuration. For Claude Desktop, edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "personal-context": {
      "command": "node",
      "args": ["/absolute/path/to/personal-context-mcp/dist/index.js"]
    }
  }
}
```

To use a custom context directory, set the `CONTEXT_DIR` environment variable:

```json
{
  "mcpServers": {
    "personal-context": {
      "command": "node",
      "args": ["/absolute/path/to/personal-context-mcp/dist/index.js"],
      "env": {
        "CONTEXT_DIR": "/absolute/path/to/your/context"
      }
    }
  }
}
```

### 5. Inspect (optional)

```bash
npm run inspect
```

Opens the MCP inspector to test tools interactively.

## Development

Run without building:

```bash
npm run dev
```

## Security

Path traversal is blocked — file names containing `/`, `\`, or `..` are rejected before any filesystem access.
