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
/**
 * TaskManager 类 - 任务管理器
 *
 * 核心功能：
 * 1. 将任务持久化为 JSON 文件存储在 .tasks/ 目录中
 * 2. 管理任务之间的依赖关系图（blockedBy/blocks）
 * 3. 提供完整的 CRUD 操作（创建、读取、更新、列表）
 * 4. 自动维护双向依赖关系
 * 5. 任务状态变更时自动更新依赖链
 *
 * 设计理念：
 * - 状态外部化：任务数据存储在文件系统中，独立于对话上下文
 * - 上下文压缩友好：即使对话历史被压缩，任务状态依然保留
 * - 依赖图管理：自动处理任务完成时的依赖解除
 */
class TaskManager {
  /**
   * 构造函数 - 初始化任务管理器
   *
   * @param {string} tasksDir - 任务文件存储目录的路径
   *
   * 初始化流程：
   * 1. 保存任务目录路径
   * 2. 递归创建目录（如果不存在）
   * 3. 扫描现有任务文件，计算下一个可用的任务 ID
   *
   * 为什么需要 _nextId：
   * - 确保每个新任务都有唯一的 ID
   * - 即使程序重启，ID 也不会重复
   * - 通过扫描现有文件来恢复 ID 计数器
   */
  constructor(tasksDir) {
    this.dir = tasksDir;
    // 递归创建目录，确保任务存储路径存在
    mkdirSync(this.dir, { recursive: true });
    // 计算下一个可用的任务 ID（当前最大 ID + 1）
    this._nextId = this._maxId() + 1;
  }

  /**
   * _maxId - 获取当前最大的任务 ID（私有方法）
   *
   * @returns {number} 当前存在的最大任务 ID，如果没有任务则返回 0
   *
   * 实现逻辑：
   * 1. 检查任务目录是否存在，不存在返回 0
   * 2. 读取目录中所有文件
   * 3. 过滤出符合 task_数字.json 格式的文件
   * 4. 从文件名中提取数字 ID
   * 5. 返回所有 ID 中的最大值
   *
   * 文件名格式：task_1.json, task_2.json, task_123.json
   * 正则表达式：^task_\d+\.json$
   * - ^ 表示字符串开始
   * - task_ 是固定前缀
   * - \d+ 表示一个或多个数字
   * - \.json$ 表示以 .json 结尾
   *
   * 为什么需要这个方法：
   * - 程序重启后需要恢复 ID 计数器
   * - 避免创建重复的任务 ID
   * - 支持任务的持久化和恢复
   */
  _maxId() {
    // 如果目录不存在，说明还没有任何任务
    if (!existsSync(this.dir)) {
      return 0;
    }
    // 读取目录中的所有文件，过滤出任务文件
    const files = readdirSync(this.dir).filter((f) =>
      f.match(/^task_\d+\.json$/),
    );
    // 如果没有任务文件，返回 0
    if (files.length === 0) {
      return 0;
    }
    // 从文件名中提取 ID 数字，例如 "task_5.json" -> 5
    const ids = files.map((f) => parseInt(f.match(/\d+/)[0]));
    // 返回最大的 ID
    return Math.max(...ids);
  }

  /**
   * _load - 从文件系统加载指定任务（私有方法）
   *
   * @param {number} taskId - 要加载的任务 ID
   * @returns {Object} 任务对象，包含所有任务属性
   * @throws {Error} 如果任务文件不存在
   *
   * 任务对象结构：
   * {
   *   id: number,           // 任务唯一标识
   *   subject: string,      // 任务主题/标题
   *   description: string,  // 任务详细描述
   *   status: string,       // 状态：pending/in_progress/completed
   *   blockedBy: number[],  // 阻塞此任务的其他任务 ID 列表
   *   blocks: number[],     // 此任务阻塞的其他任务 ID 列表
   *   owner: string         // 任务负责人
   * }
   *
   * 实现细节：
   * 1. 构造任务文件的完整路径
   * 2. 检查文件是否存在
   * 3. 读取文件内容（UTF-8 编码）
   * 4. 解析 JSON 并返回任务对象
   *
   * 错误处理：
   * - 如果文件不存在，抛出明确的错误信息
   * - JSON 解析错误会自动向上传播
   */
  _load(taskId) {
    // 构造任务文件路径：.tasks/task_1.json
    const path = resolve(this.dir, `task_${taskId}.json`);
    // 检查文件是否存在
    if (!existsSync(path)) {
      throw new Error(`Task ${taskId} not found`);
    }
    // 读取并解析 JSON 文件
    return JSON.parse(readFileSync(path, "utf8"));
  }

  /**
   * _save - 将任务对象保存到文件系统（私有方法）
   *
   * @param {Object} task - 要保存的任务对象
   *
   * 保存格式：
   * - 文件名：task_{id}.json
   * - 内容：格式化的 JSON（缩进 2 个空格）
   * - 编码：UTF-8
   *
   * JSON.stringify 参数说明：
   * - task: 要序列化的对象
   * - null: replacer 函数（这里不需要）
   * - 2: 缩进空格数，使文件易读
   *
   * 为什么使用格式化的 JSON：
   * - 便于人工查看和调试
   * - 便于版本控制系统追踪变更
   * - 文件大小增加可以忽略不计
   *
   * 原子性考虑：
   * - writeFileSync 是原子操作（在大多数文件系统上）
   * - 如果写入失败，原文件不会被破坏
   */
  _save(task) {
    // 构造任务文件路径
    const path = resolve(this.dir, `task_${task.id}.json`);
    // 将任务对象序列化为格式化的 JSON 并写入文件
    writeFileSync(path, JSON.stringify(task, null, 2));
  }

  /**
   * create - 创建新任务（公共方法）
   *
   * @param {string} subject - 任务主题/标题（必需）
   * @param {string} description - 任务详细描述（可选，默认为空字符串）
   * @returns {string} 格式化的任务 JSON 字符串
   *
   * 创建流程：
   * 1. 构造新任务对象，使用当前的 _nextId
   * 2. 初始化所有必需字段
   * 3. 保存到文件系统
   * 4. 递增 ID 计数器，为下一个任务做准备
   * 5. 返回格式化的任务 JSON
   *
   * 初始状态：
   * - status: "pending" - 新任务默认为待处理状态
   * - blockedBy: [] - 初始没有依赖
   * - blocks: [] - 初始不阻塞其他任务
   * - owner: "" - 初始没有负责人
   *
   * 返回值说明：
   * - 返回 JSON 字符串而不是对象，便于直接展示给用户
   * - 格式化输出（缩进 2 空格）提高可读性
   *
   * 使用示例：
   * const result = taskManager.create("实现登录功能", "需要支持邮箱和手机号登录");
   */
  create(subject, description = "") {
    // 构造新任务对象
    const task = {
      id: this._nextId,           // 使用当前 ID 计数器
      subject,                     // 任务标题
      description,                 // 任务描述
      status: "pending",           // 初始状态：待处理
      blockedBy: [],               // 依赖列表：空
      blocks: [],                  // 阻塞列表：空
      owner: "",                   // 负责人：空
    };
    // 保存到文件系统
    this._save(task);
    // 递增 ID 计数器
    this._nextId++;
    // 返回格式化的 JSON 字符串
    return JSON.stringify(task, null, 2);
  }

  /**
   * get - 获取指定任务的完整信息（公共方法）
   *
   * @param {number} taskId - 任务 ID
   * @returns {string} 格式化的任务 JSON 字符串
   * @throws {Error} 如果任务不存在
   *
   * 功能说明：
   * - 从文件系统加载任务
   * - 返回格式化的 JSON 字符串
   *
   * 与 _load 的区别：
   * - _load 返回对象（内部使用）
   * - get 返回 JSON 字符串（外部使用）
   *
   * 使用场景：
   * - 查看任务详情
   * - 检查任务状态和依赖关系
   * - 调试和日志记录
   */
  get(taskId) {
    // 加载任务并转换为格式化的 JSON 字符串
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

  /**
   * _clearDependency - 清理已完成任务的依赖关系（私有方法）
   *
   * @param {number} completedId - 已完成任务的 ID
   *
   * 功能说明：
   * - 当一个任务完成时，需要从所有其他任务的 blockedBy 列表中移除它
   * - 这样依赖此任务的其他任务就可以继续执行了
   *
   * 实现逻辑：
   * 1. 检查任务目录是否存在
   * 2. 读取所有任务文件
   * 3. 遍历每个任务
   * 4. 检查该任务的 blockedBy 列表是否包含已完成的任务
   * 5. 如果包含，从列表中移除并保存
   *
   * 依赖解除示例：
   * 假设有以下依赖关系：
   * - Task 1: 实现登录 API (completed)
   * - Task 2: 实现前端登录页面 (blockedBy: [1])
   * - Task 3: 编写登录测试 (blockedBy: [1, 2])
   *
   * 当 Task 1 完成时：
   * - Task 2.blockedBy 变为 []（可以开始了）
   * - Task 3.blockedBy 变为 [2]（还需要等 Task 2）
   *
   * 性能考虑：
   * - 需要遍历所有任务文件（O(n)）
   * - 对于大量任务可能较慢
   * - 但通常任务数量不会太多，可以接受
   *
   * 为什么不在 blocks 列表中记录：
   * - blockedBy 是主要的依赖信息
   * - blocks 只是反向引用，用于查询
   * - 清理 blockedBy 就足够了
   */
  _clearDependency(completedId) {
    // 检查任务目录是否存在
    if (!existsSync(this.dir)) {
      return;
    }

    // 读取所有任务文件
    const files = readdirSync(this.dir).filter((f) =>
      f.match(/^task_\d+\.json$/),
    );

    // 遍历每个任务文件
    for (const file of files) {
      const path = resolve(this.dir, file);
      // 读取并解析任务
      const task = JSON.parse(readFileSync(path, "utf8"));

      // 检查此任务是否依赖已完成的任务
      if (task.blockedBy && task.blockedBy.includes(completedId)) {
        // 从 blockedBy 列表中移除已完成的任务
        task.blockedBy = task.blockedBy.filter((id) => id !== completedId);
        // 保存更新后的任务
        this._save(task);
      }
    }
  }

  /**
   * listAll - 列出所有任务的摘要信息（公共方法）
   *
   * @returns {string} 格式化的任务列表字符串
   *
   * 输出格式：
   * [ ] #1: 实现登录功能
   * [>] #2: 实现注册功能 (blocked by: 1)
   * [x] #3: 设计数据库表
   *
   * 状态标记说明：
   * - [ ] : pending（待处理）
   * - [>] : in_progress（进行中）
   * - [x] : completed（已完成）
   * - [?] : 未知状态（不应该出现）
   *
   * 依赖信息显示：
   * - 如果任务有依赖（blockedBy 不为空），显示 "(blocked by: id1, id2)"
   * - 如果没有依赖，不显示额外信息
   *
   * 实现细节：
   * 1. 检查任务目录是否存在
   * 2. 读取所有任务文件并排序
   * 3. 解析每个任务的 JSON
   * 4. 为每个任务生成一行摘要
   * 5. 组合成多行字符串返回
   *
   * 排序说明：
   * - 文件名排序（task_1.json, task_2.json, ...）
   * - 确保任务按 ID 顺序显示
   *
   * 空状态处理：
   * - 目录不存在：返回 "No tasks."
   * - 目录为空：返回 "No tasks."
   *
   * 使用场景：
   * - 查看所有任务的概览
   * - 了解任务的整体进度
   * - 识别被阻塞的任务
   * - 规划下一步工作
   *
   * 输出示例：
   * [x] #1: 设计数据库表
   * [x] #2: 实现用户模型
   * [>] #3: 实现登录 API (blocked by: 2)
   * [ ] #4: 实现前端登录页面 (blocked by: 3)
   * [ ] #5: 编写测试用例 (blocked by: 3, 4)
   */
  listAll() {
    // 检查任务目录是否存在
    if (!existsSync(this.dir)) {
      return "No tasks.";
    }

    // 读取所有任务文件并排序
    const files = readdirSync(this.dir)
      .filter((f) => f.match(/^task_\d+\.json$/))
      .sort();

    // 如果没有任务文件
    if (files.length === 0) {
      return "No tasks.";
    }

    // 加载所有任务对象
    const tasks = files.map((f) =>
      JSON.parse(readFileSync(resolve(this.dir, f), "utf8")),
    );

    // 为每个任务生成一行摘要
    const lines = [];
    for (const t of tasks) {
      // 状态标记映射
      const markers = {
        pending: "[ ]",      // 待处理
        in_progress: "[>]",  // 进行中
        completed: "[x]",    // 已完成
      };
      // 获取状态标记，未知状态使用 [?]
      const marker = markers[t.status] || "[?]";
      
      // 构造依赖信息字符串
      const blocked =
        t.blockedBy && t.blockedBy.length > 0
          ? ` (blocked by: ${t.blockedBy.join(", ")})`
          : "";
      
      // 组合成一行：[标记] #ID: 主题 (依赖信息)
      lines.push(`${marker} #${t.id}: ${t.subject}${blocked}`);
    }

    // 将所有行用换行符连接
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
