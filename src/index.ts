import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONTEXT_DIR =
  process.env.CONTEXT_DIR ?? path.join(__dirname, "../context");

function validateName(name: string): void {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid file name: "${name}". Path traversal is not allowed.`
    );
  }
}

async function readMdFile(name: string): Promise<string> {
  const filename = name.endsWith(".md") ? name : `${name}.md`;
  const filePath = path.join(CONTEXT_DIR, filename);
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    throw new McpError(
      ErrorCode.InvalidParams,
      `File not found: "${filename}". Use get_index to see available files.`
    );
  }
}

async function listMdFiles(): Promise<string[]> {
  const entries = await fs.readdir(CONTEXT_DIR);
  return entries.filter((f) => f.endsWith(".md")).sort();
}

const server = new Server(
  { name: "personal-context", version: "1.0.0" },
  { capabilities: { resources: {}, tools: {} } }
);

// Tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_index",
      description:
        "Call this first in every conversation. Returns the routing index and preferences.md (always-loaded behavior rules) in a single call.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "get_context_file",
      description:
        "Load a single context file by name. Use get_context_files instead when loading 2 or more files.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Filename without the .md extension",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "get_context_files",
      description:
        "Load multiple context files in one call. Preferred over get_context_file when loading 2 or more files.",
      inputSchema: {
        type: "object",
        properties: {
          names: {
            type: "array",
            items: { type: "string" },
            description: "Filenames without the .md extension",
          },
        },
        required: ["names"],
      },
    },
    {
      name: "get_all_context",
      description:
        "Returns all context files concatenated. Use only when full context is needed.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "update_context_file",
      description:
        "Overwrite a context file with new content. Use to update preferences, project status, or any personal context that has changed during the conversation.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Filename without the .md extension",
          },
          content: {
            type: "string",
            description: "New file content",
          },
        },
        required: ["name", "content"],
      },
    },
    {
      name: "append_to_context_file",
      description:
        "Append content to a context file without overwriting it. Use to add new entries without losing existing data.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Filename without the .md extension",
          },
          content: {
            type: "string",
            description: "Content to append",
          },
        },
        required: ["name", "content"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "get_index": {
        const [indexContent, prefsContent] = await Promise.all([
          readMdFile("index"),
          readMdFile("preferences"),
        ]);
        return {
          content: [{ type: "text", text: `${indexContent}\n\n---\n\n${prefsContent}` }],
        };
      }

      case "get_context_files": {
        const { names } = args as { names: string[] };
        const parts: string[] = [];
        for (const n of names) {
          validateName(n);
          const content = await readMdFile(n);
          parts.push(`## ${n}.md\n\n${content}`);
        }
        return { content: [{ type: "text", text: parts.join("\n\n---\n\n") }] };
      }

      case "get_context_file": {
        const { name: fileName } = args as { name: string };
        validateName(fileName);
        const content = await readMdFile(fileName);
        return { content: [{ type: "text", text: content }] };
      }

      case "get_all_context": {
        const files = await listMdFiles();
        const parts: string[] = [];
        for (const file of files) {
          const content = await fs.readFile(
            path.join(CONTEXT_DIR, file),
            "utf-8"
          );
          parts.push(`## ${file}\n\n${content}`);
        }
        return { content: [{ type: "text", text: parts.join("\n\n---\n\n") }] };
      }

      case "update_context_file": {
        const { name: fileName, content } = args as {
          name: string;
          content: string;
        };
        validateName(fileName);
        const filePath = path.join(
          CONTEXT_DIR,
          fileName.endsWith(".md") ? fileName : `${fileName}.md`
        );
        await fs.writeFile(filePath, content, "utf-8");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, file: path.basename(filePath) }),
            },
          ],
        };
      }

      case "append_to_context_file": {
        const { name: fileName, content } = args as {
          name: string;
          content: string;
        };
        validateName(fileName);
        const filePath = path.join(
          CONTEXT_DIR,
          fileName.endsWith(".md") ? fileName : `${fileName}.md`
        );
        await fs.appendFile(filePath, `\n${content}`, "utf-8");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, file: path.basename(filePath) }),
            },
          ],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError(
      ErrorCode.InternalError,
      error instanceof Error ? error.message : String(error)
    );
  }
});

// Resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const files = await listMdFiles();
  return {
    resources: files.map((file) => ({
      uri: `context://${file}`,
      name: file,
      mimeType: "text/markdown",
    })),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  if (!uri.startsWith("context://")) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid URI scheme. Expected context://<filename>`
    );
  }
  const fileName = uri.slice("context://".length);
  if (!fileName.endsWith(".md")) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Resource URI must end with .md`
    );
  }
  validateName(fileName.replace(/\.md$/, ""));
  const filePath = path.join(CONTEXT_DIR, fileName);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return {
      contents: [{ uri, mimeType: "text/markdown", text: content }],
    };
  } catch {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Resource not found: ${uri}`
    );
  }
});

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
