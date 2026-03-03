#!/usr/bin/env node
/**
 * s08_background_tasks.js - Background Tasks
 *
 * Run commands in background threads. A notification queue is drained
 * before each LLM call to deliver results.
 *
 *     Main thread                Background thread
 *     +-----------------+        +-----------------+
 *     | agent loop      |        | task executes   |
 *     | ...             |        | ...             |
 *     | [LLM call] <---+------- | enqueue(result) |
 *     |  ^drain queue   |        +-----------------+
 *     +-----------------+
 *
 *     Timeline:
 *     Agent ----[spawn A]----[spawn B]----[other work]----
 *                  |              |
 *                  v              v
 *               [A runs]      [B runs]        (parallel)
 *                  |              |
 *                  +-- notification queue --> [results injected]
 *
 * Key insight: "Fire and forget -- the agent doesn't block while the command runs."
 */

import OpenAI from "openai";
import { exec } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, relative, dirname } from "path";
import * as dotenv from "dotenv";
import * as readline from "readline";
import process from "process";
import { randomUUID } from "crypto";

dotenv.config({ override: true });

// Initialize DeepSeek client (compatible with OpenAI SDK)
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
});

const WORKDIR = process.cwd();
const MODEL = process.env.MODEL_ID;

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use background_run for long-running commands.`;

// -- BackgroundManager: threaded execution + notification queue --
/**
 * BackgroundManager 类 - 后台任务管理器
 * 
 * 核心功能：
 * 1. 在后台线程中执行命令，不阻塞主线程
 * 2. 维护任务状态（running/completed/timeout/error）
 * 3. 使用通知队列收集完成的任务结果
 * 4. 在每次 LLM 调用前排空通知队列
 * 
 * 设计模式：
 * - Fire and forget：启动任务后立即返回，不等待完成
 * - 异步通知：任务完成时推送到通知队列
 * - 批量处理：在 LLM 调用前一次性处理所有通知
 */
class BackgroundManager {
  constructor() {
    /**
     * tasks: 存储所有任务的状态
     * 格式: { task_id: { status, result, command } }
     */
    this.tasks = {};
    
    /**
     * _notificationQueue: 已完成任务的通知队列
     * 格式: [{ task_id, status, command, result }, ...]
     */
    this._notificationQueue = [];
  }

  /**
   * run - 启动后台任务（公共方法）
   * 
   * @param {string} command - 要执行的 shell 命令
   * @returns {string} - 任务启动确认消息，包含 task_id
   * 
   * 执行流程：
   * 1. 生成唯一的任务 ID（UUID 前 8 位）
   * 2. 初始化任务状态为 "running"
   * 3. 在后台异步执行命令
   * 4. 立即返回任务 ID，不等待命令完成
   * 
   * Fire and forget 模式：
   * - 主线程不会被阻塞
   * - 可以同时运行多个后台任务
   * - 任务完成时会自动推送到通知队列
   */
  run(command) {
    // 生成短 UUID 作为任务 ID
    const taskId = randomUUID().substring(0, 8);
    
    // 初始化任务状态
    this.tasks[taskId] = {
      status: "running",
      result: null,
      command: command,
    };
    
    // 异步执行命令（不阻塞）
    this._execute(taskId, command);
    
    // 立即返回，不等待命令完成
    return `Background task ${taskId} started: ${command.substring(0, 80)}`;
  }

  /**
   * _execute - 执行后台命令（私有方法）
   * 
   * @param {string} taskId - 任务 ID
   * @param {string} command - 要执行的命令
   * 
   * 执行逻辑：
   * 1. 使用 child_process.exec 执行命令
   * 2. 设置 300 秒超时
   * 3. 捕获 stdout 和 stderr
   * 4. 命令完成后更新任务状态
   * 5. 将结果推送到通知队列
   * 
   * 错误处理：
   * - 超时：status = "timeout"
   * - 执行错误：status = "error"
   * - 正常完成：status = "completed"
   * 
   * 输出限制：
   * - 最多保留 50000 字符
   * - 通知队列中只保留前 500 字符
   */
  _execute(taskId, command) {
    exec(
      command,
      {
        cwd: WORKDIR,
        timeout: 300000, // 300 seconds
        maxBuffer: 50 * 1024 * 1024, // 50MB
      },
      (error, stdout, stderr) => {
        let output;
        let status;

        if (error) {
          // 检查是否超时
          if (error.killed && error.signal === "SIGTERM") {
            output = "Error: Timeout (300s)";
            status = "timeout";
          } else {
            // 其他错误
            output = `Error: ${error.message}`;
            status = "error";
          }
        } else {
          // 命令成功执行
          output = (stdout + stderr).trim();
          status = "completed";
        }

        // 限制输出长度
        const result = output || "(no output)";
        
        // 更新任务状态
        this.tasks[taskId].status = status;
        this.tasks[taskId].result = result.substring(0, 50000);

        // 推送到通知队列
        this._notificationQueue.push({
          task_id: taskId,
          status: status,
          command: command.substring(0, 80),
          result: result.substring(0, 500), // 通知中只保留前 500 字符
        });
      }
    );
  }

  /**
   * check - 检查任务状态（公共方法）
   * 
   * @param {string|null} taskId - 任务 ID（可选）
   * @returns {string} - 任务状态信息或所有任务列表
   * 
   * 两种使用模式：
   * 1. 指定 taskId：返回该任务的详细状态
   * 2. 不指定 taskId：返回所有任务的摘要列表
   * 
   * 输出格式：
   * - 单个任务：[status] command\nresult
   * - 所有任务：task_id: [status] command（每行一个）
   */
  check(taskId = null) {
    if (taskId) {
      // 检查单个任务
      const task = this.tasks[taskId];
      if (!task) {
        return `Error: Unknown task ${taskId}`;
      }
      return `[${task.status}] ${task.command.substring(0, 60)}\n${task.result || "(running)"}`;
    }

    // 列出所有任务
    const lines = [];
    for (const [tid, task] of Object.entries(this.tasks)) {
      lines.push(`${tid}: [${task.status}] ${task.command.substring(0, 60)}`);
    }

    return lines.length > 0 ? lines.join("\n") : "No background tasks.";
  }

  /**
   * drainNotifications - 排空通知队列（公共方法）
   * 
   * @returns {Array} - 所有待处理的通知
   * 
   * 功能说明：
   * - 返回队列中的所有通知
   * - 清空通知队列
   * - 这个方法在每次 LLM 调用前被调用
   * 
   * 为什么需要排空队列：
   * - 将后台任务的结果注入到对话中
   * - 让 LLM 知道哪些任务已经完成
   * - 避免通知堆积
   * 
   * 返回格式：
   * [
   *   { task_id, status, command, result },
   *   ...
   * ]
   */
  drainNotifications() {
    const notifications = [...this._notificationQueue];
    this._notificationQueue = [];
    return notifications;
  }
}

const BG = new BackgroundManager();

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
 * Execute a bash command with safety checks (blocking)
 * @param {string} command - The command to execute
 * @returns {string} - The command output or error message
 */
function runBash(command) {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];

  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }

  try {
    const { execSync } = require("child_process");
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
    const dir = dirname(fp);
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
  background_run: (args) => BG.run(args.command),
  check_background: (args) => BG.check(args.task_id),
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command (blocking).",
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
      name: "background_run",
      description:
        "Run command in background thread. Returns task_id immediately.",
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
      name: "check_background",
      description: "Check background task status. Omit task_id to list all.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string" },
        },
      },
    },
  },
];

/**
 * The agent loop with background task notification injection
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
    // Drain background notifications and inject as user message before LLM call
    const notifications = BG.drainNotifications();
    if (notifications.length > 0 && messages.length > 0) {
      const notifText = notifications
        .map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`)
        .join("\n");

      openaiMessages.push({
        role: "user",
        content: `<background-results>\n${notifText}\n</background-results>`,
      });
      openaiMessages.push({
        role: "assistant",
        content: "Noted background results.",
      });

      messages.push({
        role: "user",
        content: `<background-results>\n${notifText}\n</background-results>`,
      });
      messages.push({
        role: "assistant",
        content: "Noted background results.",
      });
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
    prompt: "\x1b[36ms08 >> \x1b[0m",
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

export { agentLoop, BackgroundManager };