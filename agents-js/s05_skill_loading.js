#!/usr/bin/env node
/**
 * s05_skill_loading.js - Skills
 *
 * Two-layer skill injection that avoids bloating the system prompt:
 *
 *     Layer 1 (cheap): skill names in system prompt (~100 tokens/skill)
 *     Layer 2 (on demand): full skill body in tool_result
 *
 *     skills/
 *       pdf/
 *         SKILL.md          <-- frontmatter (name, description) + body
 *       code-review/
 *         SKILL.md
 *
 *     System prompt:
 *     +--------------------------------------+
 *     | You are a coding agent.              |
 *     | Skills available:                    |
 *     |   - pdf: Process PDF files...        |  <-- Layer 1: metadata only
 *     |   - code-review: Review code...      |
 *     +--------------------------------------+
 *
 *     When model calls load_skill("pdf"):
 *     +--------------------------------------+
 *     | tool_result:                         |
 *     | <skill>                              |
 *     |   Full PDF processing instructions   |  <-- Layer 2: full body
 *     |   Step 1: ...                        |
 *     |   Step 2: ...                        |
 *     | </skill>                             |
 *     +--------------------------------------+
 *
 * Key insight: "Don't put everything in the system prompt. Load on demand."
 */

import OpenAI from "openai";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import * as readline from "readline";
import process from "process";

dotenv.config({ override: true });

const WORKDIR = process.cwd();

// Initialize DeepSeek client (compatible with OpenAI SDK)
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
});

const MODEL = process.env.MODEL_ID;
const SKILLS_DIR = path.join(WORKDIR, "skills");

/**
 * SkillLoader: scan skills/<name>/SKILL.md with YAML frontmatter
 */
class SkillLoader {
  constructor(skillsDir) {
    this.skillsDir = skillsDir;
    this.skills = {};
    this._loadAll();
  }

  /**
   * Load all SKILL.md files from the skills directory
   */
  _loadAll() {
    if (!fs.existsSync(this.skillsDir)) {
      return;
    }

    const findSkillFiles = (dir) => {
      const files = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...findSkillFiles(fullPath));
        } else if (entry.name === "SKILL.md") {
          files.push(fullPath);
        }
      }

      return files;
    };

    const skillFiles = findSkillFiles(this.skillsDir).sort();

    for (const filePath of skillFiles) {
      const text = fs.readFileSync(filePath, "utf8");
      const { meta, body } = this._parseFrontmatter(text);
      const name = meta.name || path.basename(path.dirname(filePath));
      this.skills[name] = { meta, body, path: filePath };
    }
  }

  /**
   * Parse YAML frontmatter between --- delimiters
   * @param {string} text - The file content
   * @returns {Object} - Object with meta and body properties
   */
  _parseFrontmatter(text) {
    const match = text.match(/^---\n(.*?)\n---\n(.*)/s);

    if (!match) {
      return { meta: {}, body: text };
    }

    const meta = {};
    const frontmatter = match[1].trim();

    for (const line of frontmatter.split("\n")) {
      if (line.includes(":")) {
        const [key, ...valueParts] = line.split(":");
        meta[key.trim()] = valueParts.join(":").trim();
      }
    }

    return { meta, body: match[2].trim() };
  }

  /**
   * Layer 1: short descriptions for the system prompt
   * @returns {string} - Formatted list of skills
   */
  getDescriptions() {
    if (Object.keys(this.skills).length === 0) {
      return "(no skills available)";
    }

    const lines = [];
    for (const [name, skill] of Object.entries(this.skills)) {
      const desc = skill.meta.description || "No description";
      const tags = skill.meta.tags || "";
      let line = `  - ${name}: ${desc}`;
      if (tags) {
        line += ` [${tags}]`;
      }
      lines.push(line);
    }

    return lines.join("\n");
  }

  /**
   * Layer 2: full skill body returned in tool_result
   * @param {string} name - The skill name
   * @returns {string} - The skill content or error message
   */
  getContent(name) {
    console.log(`开始获取 skill ${name} 内容...`);
    const skill = this.skills[name];
    if (!skill) {
      const available = Object.keys(this.skills).join(", ");
      return `Error: Unknown skill '${name}'. Available: ${available}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

const SKILL_LOADER = new SkillLoader(SKILLS_DIR);

// Layer 1: skill metadata injected into system prompt
const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use load_skill to access specialized knowledge before tackling unfamiliar topics.

Skills available:
${SKILL_LOADER.getDescriptions()}`;

console.log(`system prompt`, SYSTEM);

/**
 * Ensure path is within workspace
 * @param {string} p - The path to check
 * @returns {string} - The resolved absolute path
 */
function safePath(p) {
  const resolvedPath = path.resolve(WORKDIR, p);
  if (!resolvedPath.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolvedPath;
}

/**
 * Execute a bash command with safety checks
 * @param {string} command - The command to execute
 * @returns {string} - The command output or error message
 */
function runBash(command) {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];

  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }

  try {
    const output = execSync(command, {
      cwd: WORKDIR,
      encoding: "utf8",
      timeout: 120000, // 120 seconds
      maxBuffer: 50 * 1024 * 1024, // 50MB
      stdio: ["pipe", "pipe", "pipe"],
    });

    const result = output.trim();
    return result.length > 0 ? result.slice(0, 50000) : "(no output)";
  } catch (error) {
    if (error.killed && error.signal === "SIGTERM") {
      return "Error: Timeout (120s)";
    }

    // Combine stdout and stderr
    const stdout = error.stdout ? error.stdout.toString().trim() : "";
    const stderr = error.stderr ? error.stderr.toString().trim() : "";
    const combined = (stdout + stderr).trim();

    return combined.length > 0 ? combined.slice(0, 50000) : "(no output)";
  }
}

/**
 * Read file contents
 * @param {string} filePath - The file path to read
 * @param {number} limit - Optional line limit
 * @returns {string} - The file contents or error message
 */
function runRead(filePath, limit = null) {
  try {
    const text = fs.readFileSync(safePath(filePath), "utf8");
    let lines = text.split("\n");

    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit);
      lines.push(`... (${text.split("\n").length - limit} more lines)`);
    }

    return lines.join("\n").slice(0, 50000);
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

/**
 * Write content to file
 * @param {string} filePath - The file path to write
 * @param {string} content - The content to write
 * @returns {string} - Success or error message
 */
function runWrite(filePath, content) {
  try {
    const fp = safePath(filePath);
    const dir = path.dirname(fp);

    // Create directory if it doesn't exist
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fp, content, "utf8");
    return `Wrote ${content.length} bytes`;
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

/**
 * Edit file by replacing text
 * @param {string} filePath - The file path to edit
 * @param {string} oldText - The text to find
 * @param {string} newText - The text to replace with
 * @returns {string} - Success or error message
 */
function runEdit(filePath, oldText, newText) {
  try {
    const fp = safePath(filePath);
    const content = fs.readFileSync(fp, "utf8");

    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }

    // Replace only the first occurrence
    const newContent = content.replace(oldText, newText);
    fs.writeFileSync(fp, newContent, "utf8");

    return `Edited ${filePath}`;
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

// -- The dispatch map: {tool_name: handler} --
const TOOL_HANDLERS = {
  bash: (args) => runBash(args.command),
  read_file: (args) => runRead(args.path, args.limit),
  write_file: (args) => runWrite(args.path, args.content),
  edit_file: (args) => runEdit(args.path, args.old_text, args.new_text),
  load_skill: (args) => SKILL_LOADER.getContent(args.name),
};

const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "load_skill",
    description: "Load specialized knowledge by name.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name to load",
        },
      },
      required: ["name"],
    },
  },
];

/**
 * The core agent loop with tool dispatch
 * @param {Array} messages - The conversation history
 */
async function agentLoop(messages) {
  // Convert messages to OpenAI format (add system message at the beginning)
  const openaiMessages = [{ role: "system", content: SYSTEM }];

  // Convert history messages to OpenAI format
  for (const msg of messages) {
    if (msg.role === "user" && typeof msg.content === "string") {
      openaiMessages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      openaiMessages.push({
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.tool_calls,
      });
    } else if (msg.role === "tool") {
      openaiMessages.push(msg);
    }
  }

  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: openaiMessages,
      tools: TOOLS.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      })),
      max_tokens: 8000,
    });

    const choice = response.choices[0];
    const assistantMessage = choice.message;

    // Append assistant turn
    openaiMessages.push(assistantMessage);
    messages.push({
      role: "assistant",
      content: assistantMessage.content || "",
      tool_calls: assistantMessage.tool_calls,
    });

    // If the model didn't call a tool, we're done
    if (choice.finish_reason !== "tool_calls" || !assistantMessage.tool_calls) {
      return;
    }

    // Execute each tool call, collect results
    for (const toolCall of assistantMessage.tool_calls) {
      const toolName = toolCall.function.name;
      const handler = TOOL_HANDLERS[toolName];

      let output;
      try {
        if (handler) {
          const args = JSON.parse(toolCall.function.arguments);
          output = handler(args);
        } else {
          output = `Unknown tool: ${toolName}`;
        }
      } catch (error) {
        output = `Error: ${error.message}`;
      }

      console.log(`> ${toolName}: ${output.toString().slice(0, 200)}`);

      const toolMessage = {
        role: "tool",
        tool_call_id: toolCall.id,
        content: output.toString(),
      };

      openaiMessages.push(toolMessage);
      messages.push(toolMessage);
    }
  }
}

/**
 * Main interactive loop
 */
async function main() {
  const history = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[36ms05 >> \x1b[0m",
  });

  rl.prompt();

  rl.on("line", async (query) => {
    const trimmedQuery = query.trim().toLowerCase();

    if (
      trimmedQuery === "q" ||
      trimmedQuery === "exit" ||
      trimmedQuery === ""
    ) {
      rl.close();
      return;
    }

    history.push({ role: "user", content: query });

    try {
      await agentLoop(history);

      const lastMessage = history[history.length - 1];
      if (lastMessage.role === "assistant" && lastMessage.content) {
        console.log(lastMessage.content);
      }
      console.log(JSON.stringify(history));
    } catch (error) {
      console.error("Error:", error.message);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    console.log();
    process.exit(0);
  });

  // Handle Ctrl+C
  rl.on("SIGINT", () => {
    rl.close();
  });
}

// Run main if this is the entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { agentLoop, SkillLoader };
