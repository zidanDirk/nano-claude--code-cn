#!/usr/bin/env node
/**
 * s01_agent_loop.js - The Agent Loop
 *
 * The entire secret of an AI coding agent in one pattern:
 *
 *     while stop_reason == "tool_use":
 *         response = LLM(messages, tools)
 *         execute tools
 *         append results
 *
 *     +----------+      +-------+      +---------+
 *     |   User   | ---> |  LLM  | ---> |  Tool   |
 *     |  prompt  |      |       |      | execute |
 *     +----------+      +---+---+      +----+----+
 *                           ^               |
 *                           |   tool_result |
 *                           +---------------+
 *                           (loop continues)
 *
 * This is the core loop: feed tool results back to the model
 * until the model decides to stop. Production agents layer
 * policy, hooks, and lifecycle controls on top.
 */

import OpenAI from "openai";
import { execSync } from "child_process";
import * as dotenv from "dotenv";
import * as readline from "readline";
import process from "process";

dotenv.config({ override: true });

// Initialize DeepSeek client (compatible with OpenAI SDK)
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
});

const MODEL = process.env.MODEL_ID;

const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`;

const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
  },
];

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
      cwd: process.cwd(),
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
 * The core pattern: a while loop that calls tools until the model stops
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
      if (toolCall.function.name === "bash") {
        const args = JSON.parse(toolCall.function.arguments);
        console.log(`\x1b[33m$ ${args.command}\x1b[0m`);
        const output = runBash(args.command);
        console.log(output.slice(0, 200));

        const toolMessage = {
          role: "tool",
          tool_call_id: toolCall.id,
          content: output,
        };

        openaiMessages.push(toolMessage);
        messages.push(toolMessage);
      }
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
    prompt: "\x1b[36ms01 >> \x1b[0m",
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
      console.log(`history`, history);
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

export { agentLoop, runBash };
