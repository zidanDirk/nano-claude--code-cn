#!/usr/bin/env node
/**
 * s07_task_system.js - Tasks
 *
 * Tasks persist as JSON files in .tasks/ so they survive context compression.
 * Each task has a dependency graph (blockedBy/blocks).
 *
 *     .tasks/
 *       task_1.json  {"id":1, "subject":"...", "status":"completed", ...}
 *       task_2.json  {"id":2, "blockedBy":[1], "status":"pending", ...}
 *       task_3.json  {"id":3, "blockedBy":[2], "blocks":[], ...}
 *
 *     Dependency resolution:
 *     +----------+     +----------+     +----------+
 *     | task 1   | --> | task 2   | --> | task 3   |
 *     | complete |     | blocked  |     | blocked  |
 *     +----------+     +----------+     +----------+
 *          |                ^
 *          +--- completing task 1 removes it from task 2's blockedBy
 *
 * Key insight: "State that survives compression -- because it's outside the conversation."
 */

import OpenAI from "openai";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "fs";
import { resolve, relative } from "path";
import * as dotenv from "dotenv";
import * as readline from "readline";
import process from "process";

dotenv.config({ override: true });

// Initialize DeepSeek client (compatible with OpenAI SDK)
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
});

const WORKDIR = process.cwd();
const MODEL = process.env.MODEL_ID;
const TASKS_DIR = resolve(WORKDIR, ".tasks");

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task tools to plan and track work.`;

// -- TaskManager: CRUD with dependency graph, persisted as JSON files --
class TaskManager {
  constructor(tasksDir) {
    this.dir = tasksDir;
    mkdirSync(this.dir, { recursive: true });
    this._nextId = this._maxId() + 1;
  }

  _maxId() {
    if (!existsSync(this.dir)) {
      return 0;
    }
    const files = readdirSync(this.dir).filter((f) =>
      f.match(/^task_\d+\.json$/),
    );
    if (files.length === 0) {
      return 0;
    }
    const ids = files.map((f) => parseInt(f.match(/\d+/)[0]));
    return Math.max(...ids);
  }

  _load(taskId) {
    const path = resolve(this.dir, `task_${taskId}.json`);
    if (!existsSync(path)) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(readFileSync(path, "utf8"));
  }

  _save(task) {
    const path = resolve(this.dir, `task_${task.id}.json`);
    writeFileSync(path, JSON.stringify(task, null, 2));
  }

  create(subject, description = "") {
    const task = {
      id: this._nextId,
      subject,
      description,
      status: "pending",
      blockedBy: [],
      blocks: [],
      owner: "",
    };
    this._save(task);
    this._nextId++;
    return JSON.stringify(task, null, 2);
  }

  get(taskId) {
    return JSON.stringify(this._load(taskId), null, 2);
  }

  update(taskId, status = null, addBlockedBy = null, addBlocks = null) {
    const task = this._load(taskId);

    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status;

      // When a task is completed, remove it from all other tasks' blockedBy
      if (status === "completed") {
        this._clearDependency(taskId);
      }
    }

    if (addBlockedBy) {
      task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    }

    if (addBlocks) {
      task.blocks = [...new Set([...task.blocks, ...addBlocks])];

      // Bidirectional: also update the blocked tasks' blockedBy lists
      for (const blockedId of addBlocks) {
        try {
          const blocked = this._load(blockedId);
          if (!blocked.blockedBy.includes(taskId)) {
            blocked.blockedBy.push(taskId);
            this._save(blocked);
          }
        } catch (error) {
          // Task not found, skip
        }
      }
    }

    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  _clearDependency(completedId) {
    /**
     * Remove completedId from all other tasks' blockedBy lists.
     */
    if (!existsSync(this.dir)) {
      return;
    }

    const files = readdirSync(this.dir).filter((f) =>
      f.match(/^task_\d+\.json$/),
    );

    for (const file of files) {
      const path = resolve(this.dir, file);
      const task = JSON.parse(readFileSync(path, "utf8"));

      if (task.blockedBy && task.blockedBy.includes(completedId)) {
        task.blockedBy = task.blockedBy.filter((id) => id !== completedId);
        this._save(task);
      }
    }
  }

  listAll() {
    if (!existsSync(this.dir)) {
      return "No tasks.";
    }

    const files = readdirSync(this.dir)
      .filter((f) => f.match(/^task_\d+\.json$/))
      .sort();

    if (files.length === 0) {
      return "No tasks.";
    }

    const tasks = files.map((f) =>
      JSON.parse(readFileSync(resolve(this.dir, f), "utf8")),
    );

    const lines = [];
    for (const t of tasks) {
      const markers = {
        pending: "[ ]",
        in_progress: "[>]",
        completed: "[x]",
      };
      const marker = markers[t.status] || "[?]";
      const blocked =
        t.blockedBy && t.blockedBy.length > 0
          ? ` (blocked by: ${t.blockedBy.join(", ")})`
          : "";
      lines.push(`${marker} #${t.id}: ${t.subject}${blocked}`);
    }

    return lines.join("\n");
  }
}

const TASKS = new TaskManager(TASKS_DIR);

// -- Base tool implementations --

/**
 * Validate path is within workspace
 * @param {string} p - The path to validate
 * @returns {string} - The resolved path
 */
function safePath(p) {
  const path = resolve(WORKDIR, p);
  const relPath = relative(WORKDIR, path);

  if (relPath.startsWith("..") || resolve(relPath) === relPath) {
    throw new Error(`Path escapes workspace: ${p}`);
  }

  return path;
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
      timeout: 120000,
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const result = (output || "").trim();
    return result.length > 0 ? result.slice(0, 50000) : "(no output)";
  } catch (error) {
    if (error.killed && error.signal === "SIGTERM") {
      return "Error: Timeout (120s)";
    }

    const stdout = error.stdout ? error.stdout.toString().trim() : "";
    const stderr = error.stderr ? error.stderr.toString().trim() : "";
    const combined = (stdout + stderr).trim();

    return combined.length > 0 ? combined.slice(0, 50000) : "(no output)";
  }
}

/**
 * Read file contents
 * @param {string} path - The file path
 * @param {number} limit - Optional line limit
 * @returns {string} - The file contents or error message
 */
function runRead(path, limit = null) {
  try {
    const content = readFileSync(safePath(path), "utf8");
    let lines = content.split("\n");

    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit);
      lines.push(`... (${content.split("\n").length - limit} more)`);
    }

    return lines.join("\n").slice(0, 50000);
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

/**
 * Write content to file
 * @param {string} path - The file path
 * @param {string} content - The content to write
 * @returns {string} - Success message or error
 */
function runWrite(path, content) {
  try {
    const fp = safePath(path);
    const dir = resolve(fp, "..");
    mkdirSync(dir, { recursive: true });
    writeFileSync(fp, content);
    return `Wrote ${content.length} bytes`;
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

/**
 * Edit file by replacing text
 * @param {string} path - The file path
 * @param {string} oldText - Text to find
 * @param {string} newText - Text to replace with
 * @returns {string} - Success message or error
 */
function runEdit(path, oldText, newText) {
  try {
    const fp = safePath(path);
    const content = readFileSync(fp, "utf8");

    if (!content.includes(oldText)) {
      return `Error: Text not found in ${path}`;
    }

    const updatedContent = content.replace(oldText, newText);
    writeFileSync(fp, updatedContent);
    return `Edited ${path}`;
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

const TOOL_HANDLERS = {
  bash: (args) => runBash(args.command),
  read_file: (args) => runRead(args.path, args.limit),
  write_file: (args) => runWrite(args.path, args.content),
  edit_file: (args) => runEdit(args.path, args.old_text, args.new_text),
  task_create: (args) => TASKS.create(args.subject, args.description || ""),
  task_update: (args) =>
    TASKS.update(
      args.task_id,
      args.status,
      args.addBlockedBy,
      args.addBlocks,
    ),
  task_list: (args) => TASKS.listAll(),
  task_get: (args) => TASKS.get(args.task_id),
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read file contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          limit: { type: "integer" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace exact text in file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_create",
      description: "Create a new task.",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string" },
          description: { type: "string" },
        },
        required: ["subject"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_update",
      description: "Update a task's status or dependencies.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "integer" },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "completed"],
          },
          addBlockedBy: {
            type: "array",
            items: { type: "integer" },
          },
          addBlocks: {
            type: "array",
            items: { type: "integer" },
          },
        },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_list",
      description: "List all tasks with status summary.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_get",
      description: "Get full details of a task by ID.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "integer" },
        },
        required: ["task_id"],
      },
    },
  },
];

/**
 * The agent loop with task management
 * @param {Array} messages - The conversation history
 */
async function agentLoop(messages) {
  // Convert messages to OpenAI format
  const openaiMessages = [{ role: "system", content: SYSTEM }];

  for (const msg of messages) {
    if (msg.role === "system") {
      continue; // Skip, already added
    }
    openaiMessages.push(msg);
  }

  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: openaiMessages,
      tools: TOOLS,
      max_tokens: 8000,
    });

    const choice = response.choices[0];
    const assistantMessage = choice.message;

    // Append assistant turn
    openaiMessages.push({
      role: "assistant",
      content: assistantMessage.content || "",
      tool_calls: assistantMessage.tool_calls,
    });

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
      const args = JSON.parse(toolCall.function.arguments);

      const handler = TOOL_HANDLERS[toolName];
      let output;
      try {
        output = handler ? handler(args) : `Unknown tool: ${toolName}`;
      } catch (error) {
        output = `Error: ${error.message}`;
      }

      console.log(`> ${toolName}: ${String(output).slice(0, 200)}`);

      const toolMessage = {
        role: "tool",
        tool_call_id: toolCall.id,
        content: String(output),
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
    prompt: "\x1b[36ms07 >> \x1b[0m",
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
    } catch (error) {
      console.error("Error:", error.message);
    }

    console.log();
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

export { agentLoop, TaskManager };
