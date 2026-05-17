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

interface FileMeta {
  summary: string;
  tags: string[];
  related: string[];
  load: "always" | "selective" | "never" | "keyword";
  keywords: string[];
}

function validateName(name: string): void {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid file name: "${name}". Path traversal is not allowed.`
    );
  }
}

function parseFrontmatter(content: string): { meta: FileMeta; body: string } {
  const meta: FileMeta = {
    summary: "",
    tags: [],
    related: [],
    load: "selective",
    keywords: [],
  };
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta, body: content };

  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    const value = raw.trim();

    if (key === "summary") {
      meta.summary = value.replace(/^["']|["']$/g, "");
    } else if (key === "load") {
      meta.load = value as FileMeta["load"];
    } else if (key === "tags" || key === "related" || key === "keywords") {
      meta[key] = value
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
  }

  return { meta, body: match[2] };
}

async function listMdFiles(): Promise<string[]> {
  const entries = await fs.readdir(CONTEXT_DIR);
  return entries.filter((f: string) => f.endsWith(".md")).sort();
}

async function readFileWithMeta(
  name: string
): Promise<{ meta: FileMeta; body: string; filename: string }> {
  const filename = name.endsWith(".md") ? name : `${name}.md`;
  const filePath = path.join(CONTEXT_DIR, filename);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const { meta, body } = parseFrontmatter(raw);
    return { meta, body, filename };
  } catch {
    throw new McpError(
      ErrorCode.InvalidParams,
      `File not found: "${filename}". Use get_index to see available files.`
    );
  }
}

async function buildGraphManifest(): Promise<string> {
  const files = await listMdFiles();
  const parsed = await Promise.all(
    files.map(async (file) => {
      const raw = await fs.readFile(path.join(CONTEXT_DIR, file), "utf-8");
      return { file, ...parseFrontmatter(raw) };
    })
  );

  const lines = parsed
    .filter(({ meta }) => meta.load !== "never")
    .map(({ file, meta }) => {
      const name = file.replace(".md", "");
      const tags = meta.tags.join(",") || "—";
      const related = meta.related.length ? ` →${meta.related.join(",")}` : "";
      const loadMarker =
        meta.load === "always"
          ? "[always]"
          : meta.load === "keyword"
          ? `[keyword:${meta.keywords.join(",")}]`
          : "";
      const summary = meta.summary || "(no summary)";
      return `${name}${loadMarker} | ${tags}${related} | ${summary}`;
    });

  return lines.join("\n");
}

const server = new Server(
  { name: "personal-context", version: "2.0.0" },
  { capabilities: { resources: {}, tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_index",
      description:
        "Call first in every new conversation. Returns the compact context graph manifest — all nodes with tags, edges (→related), and one-liner summaries — plus always-loaded preferences. Use this to orient before loading any file.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "query_context",
      description:
        "Retrieve context by keyword matching against file tags and summaries. Returns full content of all matching files in one call. Prefer this over get_context_file when you know the topic but not the exact file name.",
      inputSchema: {
        type: "object",
        properties: {
          keywords: {
            type: "array",
            items: { type: "string" },
            description:
              'Topic keywords matched against tags and summaries (e.g. ["linkedin", "writing"] or ["career", "reply"])',
          },
        },
        required: ["keywords"],
      },
    },
    {
      name: "get_context_graph",
      description:
        "Graph traversal: returns full content of seed nodes + one-liner summaries of their direct neighbors (depth=1 by default). Use when you want a file plus awareness of adjacent nodes without loading everything.",
      inputSchema: {
        type: "object",
        properties: {
          seeds: {
            type: "array",
            items: { type: "string" },
            description: "File names (without .md) to use as traversal seeds",
          },
          depth: {
            type: "number",
            description:
              "0 = seeds only, 1 = seeds + neighbor summaries (default: 1)",
          },
        },
        required: ["seeds"],
      },
    },
    {
      name: "get_context_file",
      description:
        "Load a single context file by exact name. Use query_context when you know the topic but not the file name.",
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
        "Load multiple context files in one call. Preferred over get_context_file when loading 2+ files by exact name.",
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
        "Overwrite a context file body. Existing frontmatter is preserved automatically — pass body content only. To update frontmatter, include the full ---...--- block at the top of content.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Filename without the .md extension",
          },
          content: {
            type: "string",
            description:
              "New file content. Pass body only — frontmatter is auto-preserved.",
          },
        },
        required: ["name", "content"],
      },
    },
    {
      name: "append_to_context_file",
      description:
        "Append content to a context file without overwriting it. Use for append-only files (log, business-ideas entries).",
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
        const [manifest, prefsFile] = await Promise.all([
          buildGraphManifest(),
          readFileWithMeta("preferences"),
        ]);
        const text = [
          "## CONTEXT GRAPH",
          "Format: name[load] | tags →related | summary",
          "",
          manifest,
          "",
          "---",
          "",
          "## PREFERENCES",
          prefsFile.body,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      }

      case "query_context": {
        const { keywords } = args as { keywords: string[] };
        const files = await listMdFiles();
        const parsed = await Promise.all(
          files.map(async (file) => {
            const raw = await fs.readFile(
              path.join(CONTEXT_DIR, file),
              "utf-8"
            );
            return { file, ...parseFrontmatter(raw) };
          })
        );

        const scored = parsed
          .filter(({ meta }) => meta.load !== "never")
          .map(({ file, meta, body }) => {
            const searchable = [
              ...meta.tags,
              ...meta.keywords,
              meta.summary,
              file.replace(".md", ""),
            ]
              .join(" ")
              .toLowerCase();
            const score = keywords.filter((k) =>
              searchable.includes(k.toLowerCase())
            ).length;
            return { file, body, score };
          })
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score);

        if (scored.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No matching context files found for the given keywords.",
              },
            ],
          };
        }

        const parts = scored.map(({ file, body }) => `## ${file}\n\n${body}`);
        return {
          content: [{ type: "text", text: parts.join("\n\n---\n\n") }],
        };
      }

      case "get_context_graph": {
        const { seeds, depth = 1 } = args as {
          seeds: string[];
          depth?: number;
        };
        const parts: string[] = [];
        const neighborSummaries: string[] = [];
        const loaded = new Set<string>(seeds);

        const seedData = await Promise.all(
          seeds.map(async (seed) => {
            validateName(seed);
            return { seed, ...(await readFileWithMeta(seed)) };
          })
        );

        for (const { seed, meta, body } of seedData) {
          parts.push(`## ${seed}.md\n\n${body}`);

          if (depth >= 1) {
            const neighbors = meta.related.filter((r) => !loaded.has(r));
            const neighborData = await Promise.all(
              neighbors.map(async (rel) => {
                try {
                  const { meta: relMeta } = await readFileWithMeta(rel);
                  return `${rel} | ${relMeta.tags.join(",")} | ${relMeta.summary}`;
                } catch {
                  return null;
                }
              })
            );
            neighborSummaries.push(
              ...neighborData.filter((n): n is string => n !== null)
            );
          }
        }

        if (neighborSummaries.length > 0) {
          parts.push(
            `## Adjacent nodes (summaries only — load with get_context_file if needed)\n${neighborSummaries.join("\n")}`
          );
        }

        return {
          content: [{ type: "text", text: parts.join("\n\n---\n\n") }],
        };
      }

      case "get_context_file": {
        const { name: fileName } = args as { name: string };
        validateName(fileName);
        const { body } = await readFileWithMeta(fileName);
        return { content: [{ type: "text", text: body }] };
      }

      case "get_context_files": {
        const { names } = args as { names: string[] };
        const results = await Promise.all(
          names.map(async (n) => {
            validateName(n);
            const { body } = await readFileWithMeta(n);
            return `## ${n}.md\n\n${body}`;
          })
        );
        return {
          content: [{ type: "text", text: results.join("\n\n---\n\n") }],
        };
      }

      case "get_all_context": {
        const files = await listMdFiles();
        const results = await Promise.all(
          files.map(async (file) => {
            const raw = await fs.readFile(
              path.join(CONTEXT_DIR, file),
              "utf-8"
            );
            const { body } = parseFrontmatter(raw);
            return `## ${file}\n\n${body}`;
          })
        );
        return {
          content: [{ type: "text", text: results.join("\n\n---\n\n") }],
        };
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

        // Preserve existing frontmatter if the incoming content has none
        let newContent = content;
        if (!content.startsWith("---\n")) {
          try {
            const existing = await fs.readFile(filePath, "utf-8");
            const fmMatch = existing.match(/^(---\n[\s\S]*?\n---\n)/);
            if (fmMatch) newContent = fmMatch[1] + content;
          } catch {
            // new file, no frontmatter to preserve
          }
        }

        await fs.writeFile(filePath, newContent, "utf-8");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                file: path.basename(filePath),
              }),
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
              text: JSON.stringify({
                success: true,
                file: path.basename(filePath),
              }),
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
    const raw = await fs.readFile(filePath, "utf-8");
    const { body } = parseFrontmatter(raw);
    return { contents: [{ uri, mimeType: "text/markdown", text: body }] };
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
