#!/usr/bin/env node
/**
 * s02_tool_use.js - Tools
 * 
 * The agent loop from s01 didn't change. We just added tools to the array
 * and a dispatch map to route calls.
 * 
 *     +----------+      +-------+      +------------------+
 *     |   User   | ---> |  LLM  | ---> | Tool Dispatch    |
 *     |  prompt  |      |       |      | {                |
 *     +----------+      +---+---+      |   bash: run_bash |
 *                           ^          |   read: run_read |
 *                           |          |   write: run_wr  |
 *                           +----------+   edit: run_edit |
 *                           tool_result| }                |
 *                                      +------------------+
 * 
 * Key insight: "The loop didn't change at all. I just added tools."
 */

import OpenAI from 'openai';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as readline from 'readline';
import process from 'process';

dotenv.config({ override: true });

const WORKDIR = process.cwd();

// Initialize DeepSeek client (compatible with OpenAI SDK)
const client = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY,
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
});

const MODEL = process.env.MODEL_ID;

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

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
    
    if (dangerous.some(d => command.includes(d))) {
        return "Error: Dangerous command blocked";
    }
    
    try {
        const output = execSync(command, {
            cwd: WORKDIR,
            encoding: 'utf8',
            timeout: 120000, // 120 seconds
            maxBuffer: 50 * 1024 * 1024, // 50MB
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        const result = output.trim();
        return result.length > 0 ? result.slice(0, 50000) : "(no output)";
    } catch (error) {
        if (error.killed && error.signal === 'SIGTERM') {
            return "Error: Timeout (120s)";
        }
        
        // Combine stdout and stderr
        const stdout = error.stdout ? error.stdout.toString().trim() : '';
        const stderr = error.stderr ? error.stderr.toString().trim() : '';
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
        const text = fs.readFileSync(safePath(filePath), 'utf8');
        let lines = text.split('\n');
        
        if (limit && limit < lines.length) {
            lines = lines.slice(0, limit);
            lines.push(`... (${text.split('\n').length - limit} more lines)`);
        }
        
        return lines.join('\n').slice(0, 50000);
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
        
        fs.writeFileSync(fp, content, 'utf8');
        return `Wrote ${content.length} bytes to ${filePath}`;
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
        const content = fs.readFileSync(fp, 'utf8');
        
        if (!content.includes(oldText)) {
            return `Error: Text not found in ${filePath}`;
        }
        
        // Replace only the first occurrence
        const newContent = content.replace(oldText, newText);
        fs.writeFileSync(fp, newContent, 'utf8');
        
        return `Edited ${filePath}`;
    } catch (error) {
        return `Error: ${error.message}`;
    }
}

// -- The dispatch map: {tool_name: handler} --
const TOOL_HANDLERS = {
    "bash": (args) => runBash(args.command),
    "read_file": (args) => runRead(args.path, args.limit),
    "write_file": (args) => runWrite(args.path, args.content),
    "edit_file": (args) => runEdit(args.path, args.old_text, args.new_text),
};

const TOOLS = [
    {
        name: "bash",
        description: "Run a shell command.",
        input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"]
        }
    },
    {
        name: "read_file",
        description: "Read file contents.",
        input_schema: {
            type: "object",
            properties: {
                path: { type: "string" },
                limit: { type: "integer" }
            },
            required: ["path"]
        }
    },
    {
        name: "write_file",
        description: "Write content to file.",
        input_schema: {
            type: "object",
            properties: {
                path: { type: "string" },
                content: { type: "string" }
            },
            required: ["path", "content"]
        }
    },
    {
        name: "edit_file",
        description: "Replace exact text in file.",
        input_schema: {
            type: "object",
            properties: {
                path: { type: "string" },
                old_text: { type: "string" },
                new_text: { type: "string" }
            },
            required: ["path", "old_text", "new_text"]
        }
    }
];

/**
 * The core agent loop with tool dispatch
 * @param {Array} messages - The conversation history
 */
async function agentLoop(messages) {
    // Convert messages to OpenAI format (add system message at the beginning)
    const openaiMessages = [
        { role: "system", content: SYSTEM }
    ];
    
    // Convert history messages to OpenAI format
    for (const msg of messages) {
        if (msg.role === "user" && typeof msg.content === "string") {
            openaiMessages.push({ role: "user", content: msg.content });
        } else if (msg.role === "assistant") {
            openaiMessages.push({
                role: "assistant",
                content: msg.content || null,
                tool_calls: msg.tool_calls
            });
        } else if (msg.role === "tool") {
            openaiMessages.push(msg);
        }
    }
    
    while (true) {
        const response = await client.chat.completions.create({
            model: MODEL,
            messages: openaiMessages,
            tools: TOOLS.map(tool => ({
                type: "function",
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.input_schema
                }
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
            tool_calls: assistantMessage.tool_calls
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
            if (handler) {
                const args = JSON.parse(toolCall.function.arguments);
                output = handler(args);
            } else {
                output = `Unknown tool: ${toolName}`;
            }
            
            console.log(`> ${toolName}: ${output.slice(0, 200)}`);
            
            const toolMessage = {
                role: "tool",
                tool_call_id: toolCall.id,
                content: output
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
        prompt: '\x1b[36ms02 >> \x1b[0m'
    });
    
    rl.prompt();
    
    rl.on('line', async (query) => {
        const trimmedQuery = query.trim().toLowerCase();
        
        if (trimmedQuery === 'q' || trimmedQuery === 'exit' || trimmedQuery === '') {
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
            console.log();
        } catch (error) {
            console.error('Error:', error.message);
        }
        
        rl.prompt();
    });
    
    rl.on('close', () => {
        console.log();
        process.exit(0);
    });
    
    // Handle Ctrl+C
    rl.on('SIGINT', () => {
        rl.close();
    });
}

// Run main if this is the entry point
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export { agentLoop, runBash, runRead, runWrite, runEdit };