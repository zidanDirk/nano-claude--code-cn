#!/usr/bin/env node
/**
 * s06_context_compact.js - Compact
 *
 * Three-layer compression pipeline so the agent can work forever:
 *
 *     Every turn:
 *     +------------------+
 *     | Tool call result |
 *     +------------------+
 *             |
 *             v
 *     [Layer 1: micro_compact]        (silent, every turn)
 *       Replace tool_result content older than last 3
 *       with "[Previous: used {tool_name}]"
 *             |
 *             v
 *     [Check: tokens > 50000?]
 *        |               |
 *        no              yes
 *        |               |
 *        v               v
 *     continue    [Layer 2: auto_compact]
 *                   Save full transcript to .transcripts/
 *                   Ask LLM to summarize conversation.
 *                   Replace all messages with [summary].
 *                         |
 *                         v
 *                 [Layer 3: compact tool]
 *                   Model calls compact -> immediate summarization.
 *                   Same as auto, triggered manually.
 *
 * Key insight: "The agent can forget strategically and keep working forever."
 */

import OpenAI from "openai";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;

const THRESHOLD = 50000;
const TRANSCRIPT_DIR = resolve(WORKDIR, ".transcripts");
const KEEP_RECENT = 3;

/**
 * Rough token count: ~4 chars per token
 * @param {Array} messages - The messages array
 * @returns {number} - Estimated token count
 */
function estimateTokens(messages) {
  return Math.floor(JSON.stringify(messages).length / 4);
}

/**
 * Layer 1: micro_compact - replace old tool results with placeholders
 * @param {Array} messages - The messages array
 * @returns {Array} - The modified messages array
 */
function microCompact(messages) {
  // Collect (msg_index, tool_call_id, message) for all tool messages
  const toolResults = [];
  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (msg.role === "tool") {
      toolResults.push({ msgIdx, msg });
    }
  }

  if (toolResults.length <= KEEP_RECENT) {
    return messages;
  }

  // Find tool_name for each result by matching tool_call_id in prior assistant messages
  const toolNameMap = {};
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const toolCall of msg.tool_calls) {
        toolNameMap[toolCall.id] = toolCall.function.name;
      }
    }
  }

  // Clear old results (keep last KEEP_RECENT)
  const toClear = toolResults.slice(0, -KEEP_RECENT);
  for (const { msg } of toClear) {
    if (typeof msg.content === "string" && msg.content.length > 100) {
      const toolName = toolNameMap[msg.tool_call_id] || "unknown";
      msg.content = `[Previous: used ${toolName}]`;
    }
  }

  return messages;
}

/**
 * Layer 2: auto_compact - save transcript, summarize, replace messages
 * @param {Array} messages - The messages array
 * @returns {Array} - The compressed messages array
 */
async function autoCompact(messages) {
  // Save full transcript to disk
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = resolve(
    TRANSCRIPT_DIR,
    `transcript_${Date.now()}.jsonl`,
  );

  const lines = messages.map((msg) => JSON.stringify(msg)).join("\n");
  writeFileSync(transcriptPath, lines + "\n");
  console.log(`[transcript saved: ${transcriptPath}]`);

  // Ask LLM to summarize
  const conversationText = JSON.stringify(messages).slice(0, 80000);
  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "user",
        content:
          "Summarize this conversation for continuity. Include: " +
          "1) What was accomplished, 2) Current state, 3) Key decisions made. " +
          "Be concise but preserve critical details.\n\n" +
          conversationText,
      },
    ],
    max_tokens: 2000,
  });

  const summary = response.choices[0].message.content;

  // Replace all messages with compressed summary
  return [
    {
      role: "user",
      content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}`,
    },
    {
      role: "assistant",
      content: "Understood. I have the context from the summary. Continuing.",
    },
  ];
}

// -- Tool implementations --

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
  compact: (args) => "Manual compression requested.",
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
      name: "compact",
      description: "Trigger manual conversation compression.",
      parameters: {
        type: "object",
        properties: {
          focus: {
            type: "string",
            description: "What to preserve in the summary",
          },
        },
      },
    },
  },
];

/**
 * The agent loop with three-layer compression
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
    // Layer 1: micro_compact before each LLM call
    microCompact(openaiMessages);

    // Layer 2: auto_compact if token estimate exceeds threshold
    if (estimateTokens(openaiMessages) > THRESHOLD) {
      console.log("[auto_compact triggered]");
      const compacted = await autoCompact(openaiMessages.slice(1)); // exclude system
      openaiMessages.splice(1); // clear all except system
      openaiMessages.push(...compacted);
    }

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
    let manualCompact = false;

    for (const toolCall of assistantMessage.tool_calls) {
      const toolName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);

      if (toolName === "compact") {
        manualCompact = true;
        var output = "Compressing...";
      } else {
        const handler = TOOL_HANDLERS[toolName];
        try {
          var output = handler ? handler(args) : `Unknown tool: ${toolName}`;
        } catch (error) {
          var output = `Error: ${error.message}`;
        }
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

    // Layer 3: manual compact triggered by the compact tool
    if (manualCompact) {
      console.log("[manual compact]");
      const compacted = await autoCompact(openaiMessages.slice(1)); // exclude system
      openaiMessages.splice(1); // clear all except system
      openaiMessages.push(...compacted);
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
    prompt: "\x1b[36ms06 >> \x1b[0m",
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

    console.log(`history: \n`, JSON.stringify(history));
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

export { agentLoop, microCompact, autoCompact };
