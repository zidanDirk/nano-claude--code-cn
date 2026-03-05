#!/usr/bin/env node
/**
 * s09_agent_teams.js - Agent Teams
 * 
 * Persistent named agents with file-based JSONL inboxes. Each teammate runs
 * its own agent loop as an async function. Communication via append-only inboxes.
 * 
 *     Subagent (s04):  spawn -> execute -> return summary -> destroyed
 *     Teammate (s09):  spawn -> work -> idle -> work -> ... -> shutdown
 * 
 *     .team/config.json                   .team/inbox/
 *     +----------------------------+      +------------------+
 *     | {"team_name": "default",   |      | alice.jsonl      |
 *     |  "members": [              |      | bob.jsonl        |
 *     |    {"name":"alice",        |      | lead.jsonl       |
 *     |     "role":"coder",        |      +------------------+
 *     |     "status":"idle"}       |
 *     |  ]}                        |      send_message("alice", "fix bug"):
 *     +----------------------------+        open("alice.jsonl", "a").write(msg)
 * 
 *                                         read_inbox("alice"):
 *     spawn_teammate("alice","coder",...)   msgs = [json.loads(l) for l in ...]
 *          |                                open("alice.jsonl", "w").close()
 *          v                                return msgs  # drain
 *     Async: alice          Async: bob
 *     +------------------+      +------------------+
 *     | agent_loop       |      | agent_loop       |
 *     | status: working  |      | status: idle     |
 *     | ... runs tools   |      | ... waits ...    |
 *     | status -> idle   |      |                  |
 *     +------------------+      +------------------+
 * 
 *     5 message types (all declared, not all handled here):
 *     +-------------------------+-----------------------------------+
 *     | message                 | Normal text message               |
 *     | broadcast               | Sent to all teammates             |
 *     | shutdown_request        | Request graceful shutdown (s10)   |
 *     | shutdown_response       | Approve/reject shutdown (s10)     |
 *     | plan_approval_response  | Approve/reject plan (s10)         |
 *     +-------------------------+-----------------------------------+
 * 
 * Key insight: "Teammates that can talk to each other."
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
const TEAM_DIR = path.join(WORKDIR, '.team');
const INBOX_DIR = path.join(TEAM_DIR, 'inbox');

const SYSTEM = `You are a team lead at ${WORKDIR}. Spawn teammates and communicate via inboxes.`;

const VALID_MSG_TYPES = new Set([
    'message',
    'broadcast',
    'shutdown_request',
    'shutdown_response',
    'plan_approval_response'
]);

// -- MessageBus: JSONL inbox per teammate --
class MessageBus {
    constructor(inboxDir) {
        this.dir = inboxDir;
        if (!fs.existsSync(this.dir)) {
            fs.mkdirSync(this.dir, { recursive: true });
        }
    }

    /**
     * Send a message to a teammate's inbox
     * @param {string} sender - The sender's name
     * @param {string} to - The recipient's name
     * @param {string} content - The message content
     * @param {string} msgType - The message type
     * @param {Object} extra - Additional fields
     * @returns {string} - Success or error message
     */
    send(sender, to, content, msgType = 'message', extra = null) {
        if (!VALID_MSG_TYPES.has(msgType)) {
            return `Error: Invalid type '${msgType}'. Valid: ${Array.from(VALID_MSG_TYPES).join(', ')}`;
        }

        const msg = {
            type: msgType,
            from: sender,
            content: content,
            timestamp: Date.now() / 1000
        };

        if (extra) {
            Object.assign(msg, extra);
        }

        const inboxPath = path.join(this.dir, `${to}.jsonl`);
        try {
            fs.appendFileSync(inboxPath, JSON.stringify(msg) + '\n', 'utf8');
            return `Sent ${msgType} to ${to}`;
        } catch (error) {
            return `Error: ${error.message}`;
        }
    }

    /**
     * Read and drain a teammate's inbox
     * @param {string} name - The teammate's name
     * @returns {Array} - Array of messages
     */
    readInbox(name) {
        const inboxPath = path.join(this.dir, `${name}.jsonl`);
        
        if (!fs.existsSync(inboxPath)) {
            return [];
        }

        try {
            const content = fs.readFileSync(inboxPath, 'utf8').trim();
            const messages = [];
            
            if (content) {
                for (const line of content.split('\n')) {
                    if (line.trim()) {
                        messages.push(JSON.parse(line));
                    }
                }
            }

            // Drain the inbox
            fs.writeFileSync(inboxPath, '', 'utf8');
            return messages;
        } catch (error) {
            console.error(`Error reading inbox for ${name}:`, error.message);
            return [];
        }
    }

    /**
     * Broadcast a message to all teammates
     * @param {string} sender - The sender's name
     * @param {string} content - The message content
     * @param {Array} teammates - List of teammate names
     * @returns {string} - Success message
     */
    broadcast(sender, content, teammates) {
        let count = 0;
        for (const name of teammates) {
            if (name !== sender) {
                this.send(sender, name, content, 'broadcast');
                count++;
            }
        }
        return `Broadcast to ${count} teammates`;
    }
}

const BUS = new MessageBus(INBOX_DIR);

// -- TeammateManager: persistent named agents with config.json --
class TeammateManager {
    constructor(teamDir) {
        this.dir = teamDir;
        if (!fs.existsSync(this.dir)) {
            fs.mkdirSync(this.dir, { recursive: true });
        }
        this.configPath = path.join(this.dir, 'config.json');
        this.config = this._loadConfig();
        this.runningAgents = new Map(); // name -> Promise
    }

    /**
     * Load team configuration from file
     * @returns {Object} - Team configuration
     */
    _loadConfig() {
        if (fs.existsSync(this.configPath)) {
            try {
                return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            } catch (error) {
                console.error('Error loading config:', error.message);
            }
        }
        return { team_name: 'default', members: [] };
    }

    /**
     * Save team configuration to file
     */
    _saveConfig() {
        try {
            fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
        } catch (error) {
            console.error('Error saving config:', error.message);
        }
    }

    /**
     * Find a member by name
     * @param {string} name - The member's name
     * @returns {Object|null} - The member object or null
     */
    _findMember(name) {
        return this.config.members.find(m => m.name === name) || null;
    }

    /**
     * Spawn a new teammate
     * @param {string} name - The teammate's name
     * @param {string} role - The teammate's role
     * @param {string} prompt - The initial prompt
     * @returns {string} - Success or error message
     */
    spawn(name, role, prompt) {
        let member = this._findMember(name);
        
        if (member) {
            if (member.status !== 'idle' && member.status !== 'shutdown') {
                return `Error: '${name}' is currently ${member.status}`;
            }
            member.status = 'working';
            member.role = role;
        } else {
            member = { name, role, status: 'working' };
            this.config.members.push(member);
        }

        this._saveConfig();

        // Start the teammate loop as an async function
        const agentPromise = this._teammateLoop(name, role, prompt);
        this.runningAgents.set(name, agentPromise);

        // Handle completion
        agentPromise.then(() => {
            this.runningAgents.delete(name);
            const m = this._findMember(name);
            if (m && m.status !== 'shutdown') {
                m.status = 'idle';
                this._saveConfig();
            }
        }).catch(error => {
            console.error(`Error in ${name}'s loop:`, error.message);
            this.runningAgents.delete(name);
        });

        return `Spawned '${name}' (role: ${role})`;
    }

    /**
     * Teammate agent loop
     * @param {string} name - The teammate's name
     * @param {string} role - The teammate's role
     * @param {string} prompt - The initial prompt
     */
    async _teammateLoop(name, role, prompt) {
        const sysPrompt = `You are '${name}', role: ${role}, at ${WORKDIR}. Use send_message to communicate. Complete your task.`;
        
        const messages = [
            { role: 'system', content: sysPrompt },
            { role: 'user', content: prompt }
        ];

        const tools = this._teammateTools();

        // Safety limit
        for (let i = 0; i < 50; i++) {
            // Check inbox for new messages
            const inbox = BUS.readInbox(name);
            if (inbox.length > 0) {
                messages.push({
                    role: 'user',
                    content: JSON.stringify(inbox, null, 2)
                });
            }

            let response;
            try {
                response = await client.chat.completions.create({
                    model: MODEL,
                    messages: messages,
                    tools: tools.map(tool => ({
                        type: 'function',
                        function: {
                            name: tool.name,
                            description: tool.description,
                            parameters: tool.input_schema
                        }
                    })),
                    max_tokens: 8000
                });
            } catch (error) {
                console.error(`[${name}] API error:`, error.message);
                break;
            }

            const choice = response.choices[0];
            const assistantMessage = choice.message;

            messages.push({
                role: 'assistant',
                content: assistantMessage.content || '',
                tool_calls: assistantMessage.tool_calls
            });

            if (choice.finish_reason !== 'tool_calls' || !assistantMessage.tool_calls) {
                break;
            }

            // Execute tools
            for (const toolCall of assistantMessage.tool_calls) {
                const args = JSON.parse(toolCall.function.arguments);
                const output = this._exec(name, toolCall.function.name, args);
                
                console.log(`  [${name}] ${toolCall.function.name}: ${String(output).slice(0, 120)}`);

                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: String(output)
                });
            }
        }
    }

    /**
     * Execute a tool for a teammate
     * @param {string} sender - The teammate's name
     * @param {string} toolName - The tool name
     * @param {Object} args - The tool arguments
     * @returns {string} - The tool result
     */
    _exec(sender, toolName, args) {
        // Base tools (unchanged from s02)
        if (toolName === 'bash') {
            return runBash(args.command);
        }
        if (toolName === 'read_file') {
            return runRead(args.path);
        }
        if (toolName === 'write_file') {
            return runWrite(args.path, args.content);
        }
        if (toolName === 'edit_file') {
            return runEdit(args.path, args.old_text, args.new_text);
        }
        if (toolName === 'send_message') {
            return BUS.send(sender, args.to, args.content, args.msg_type || 'message');
        }
        if (toolName === 'read_inbox') {
            return JSON.stringify(BUS.readInbox(sender), null, 2);
        }
        return `Unknown tool: ${toolName}`;
    }

    /**
     * Get tools available to teammates
     * @returns {Array} - Array of tool definitions
     */
    _teammateTools() {
        return [
            {
                name: 'bash',
                description: 'Run a shell command.',
                input_schema: {
                    type: 'object',
                    properties: { command: { type: 'string' } },
                    required: ['command']
                }
            },
            {
                name: 'read_file',
                description: 'Read file contents.',
                input_schema: {
                    type: 'object',
                    properties: { path: { type: 'string' } },
                    required: ['path']
                }
            },
            {
                name: 'write_file',
                description: 'Write content to file.',
                input_schema: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        content: { type: 'string' }
                    },
                    required: ['path', 'content']
                }
            },
            {
                name: 'edit_file',
                description: 'Replace exact text in file.',
                input_schema: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        old_text: { type: 'string' },
                        new_text: { type: 'string' }
                    },
                    required: ['path', 'old_text', 'new_text']
                }
            },
            {
                name: 'send_message',
                description: 'Send message to a teammate.',
                input_schema: {
                    type: 'object',
                    properties: {
                        to: { type: 'string' },
                        content: { type: 'string' },
                        msg_type: {
                            type: 'string',
                            enum: Array.from(VALID_MSG_TYPES)
                        }
                    },
                    required: ['to', 'content']
                }
            },
            {
                name: 'read_inbox',
                description: 'Read and drain your inbox.',
                input_schema: {
                    type: 'object',
                    properties: {}
                }
            }
        ];
    }

    /**
     * List all teammates
     * @returns {string} - Formatted list of teammates
     */
    listAll() {
        if (this.config.members.length === 0) {
            return 'No teammates.';
        }

        const lines = [`Team: ${this.config.team_name}`];
        for (const m of this.config.members) {
            lines.push(`  ${m.name} (${m.role}): ${m.status}`);
        }
        return lines.join('\n');
    }

    /**
     * Get list of member names
     * @returns {Array} - Array of member names
     */
    memberNames() {
        return this.config.members.map(m => m.name);
    }
}

const TEAM = new TeammateManager(TEAM_DIR);

// -- Base tool implementations (these base tools are unchanged from s02) --

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
    const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot'];
    
    if (dangerous.some(d => command.includes(d))) {
        return 'Error: Dangerous command blocked';
    }
    
    try {
        const output = execSync(command, {
            cwd: WORKDIR,
            encoding: 'utf8',
            timeout: 120000,
            maxBuffer: 50 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        const result = output.trim();
        return result.length > 0 ? result.slice(0, 50000) : '(no output)';
    } catch (error) {
        if (error.killed && error.signal === 'SIGTERM') {
            return 'Error: Timeout (120s)';
        }
        
        const stdout = error.stdout ? error.stdout.toString().trim() : '';
        const stderr = error.stderr ? error.stderr.toString().trim() : '';
        const combined = (stdout + stderr).trim();
        
        return combined.length > 0 ? combined.slice(0, 50000) : '(no output)';
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
        
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(fp, content, 'utf8');
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
        const content = fs.readFileSync(fp, 'utf8');
        
        if (!content.includes(oldText)) {
            return `Error: Text not found in ${filePath}`;
        }
        
        const newContent = content.replace(oldText, newText);
        fs.writeFileSync(fp, newContent, 'utf8');
        
        return `Edited ${filePath}`;
    } catch (error) {
        return `Error: ${error.message}`;
    }
}

// -- Lead tool dispatch (9 tools) --
const TOOL_HANDLERS = {
    'bash': (args) => runBash(args.command),
    'read_file': (args) => runRead(args.path, args.limit),
    'write_file': (args) => runWrite(args.path, args.content),
    'edit_file': (args) => runEdit(args.path, args.old_text, args.new_text),
    'spawn_teammate': (args) => TEAM.spawn(args.name, args.role, args.prompt),
    'list_teammates': () => TEAM.listAll(),
    'send_message': (args) => BUS.send('lead', args.to, args.content, args.msg_type || 'message'),
    'read_inbox': () => JSON.stringify(BUS.readInbox('lead'), null, 2),
    'broadcast': (args) => BUS.broadcast('lead', args.content, TEAM.memberNames())
};

// These base tools are unchanged from s02
const TOOLS = [
    {
        name: 'bash',
        description: 'Run a shell command.',
        input_schema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command']
        }
    },
    {
        name: 'read_file',
        description: 'Read file contents.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                limit: { type: 'integer' }
            },
            required: ['path']
        }
    },
    {
        name: 'write_file',
        description: 'Write content to file.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                content: { type: 'string' }
            },
            required: ['path', 'content']
        }
    },
    {
        name: 'edit_file',
        description: 'Replace exact text in file.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                old_text: { type: 'string' },
                new_text: { type: 'string' }
            },
            required: ['path', 'old_text', 'new_text']
        }
    },
    {
        name: 'spawn_teammate',
        description: 'Spawn a persistent teammate that runs in its own async loop.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                role: { type: 'string' },
                prompt: { type: 'string' }
            },
            required: ['name', 'role', 'prompt']
        }
    },
    {
        name: 'list_teammates',
        description: 'List all teammates with name, role, status.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'send_message',
        description: "Send a message to a teammate's inbox.",
        input_schema: {
            type: 'object',
            properties: {
                to: { type: 'string' },
                content: { type: 'string' },
                msg_type: {
                    type: 'string',
                    enum: Array.from(VALID_MSG_TYPES)
                }
            },
            required: ['to', 'content']
        }
    },
    {
        name: 'read_inbox',
        description: "Read and drain the lead's inbox.",
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'broadcast',
        description: 'Send a message to all teammates.',
        input_schema: {
            type: 'object',
            properties: {
                content: { type: 'string' }
            },
            required: ['content']
        }
    }
];

/**
 * Lead agent loop
 * @param {Array} messages - The conversation history
 */
async function agentLoop(messages) {
    while (true) {
        // Check inbox
        const inbox = BUS.readInbox('lead');
        if (inbox.length > 0) {
            messages.push({
                role: 'user',
                content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`
            });
            messages.push({
                role: 'assistant',
                content: 'Noted inbox messages.'
            });
        }

        const response = await client.chat.completions.create({
            model: MODEL,
            messages: messages,
            tools: TOOLS.map(tool => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.input_schema
                }
            })),
            max_tokens: 8000
        });

        const choice = response.choices[0];
        const assistantMessage = choice.message;

        messages.push({
            role: 'assistant',
            content: assistantMessage.content || '',
            tool_calls: assistantMessage.tool_calls
        });

        if (choice.finish_reason !== 'tool_calls' || !assistantMessage.tool_calls) {
            return;
        }

        // Execute tools
        for (const toolCall of assistantMessage.tool_calls) {
            const toolName = toolCall.function.name;
            const handler = TOOL_HANDLERS[toolName];
            
            let output;
            try {
                const args = JSON.parse(toolCall.function.arguments);
                output = handler ? handler(args) : `Unknown tool: ${toolName}`;
            } catch (error) {
                output = `Error: ${error.message}`;
            }

            console.log(`> ${toolName}: ${String(output).slice(0, 200)}`);

            messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: String(output)
            });
        }
    }
}

/**
 * Main interactive loop
 */
async function main() {
    const history = [
        { role: 'system', content: SYSTEM }
    ];

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '\x1b[36ms09 >> \x1b[0m'
    });

    rl.prompt();

    rl.on('line', async (query) => {
        const trimmedQuery = query.trim().toLowerCase();

        if (trimmedQuery === 'q' || trimmedQuery === 'exit' || trimmedQuery === '') {
            rl.close();
            return;
        }

        // Special commands
        if (trimmedQuery === '/team') {
            console.log(TEAM.listAll());
            rl.prompt();
            return;
        }

        if (trimmedQuery === '/inbox') {
            console.log(JSON.stringify(BUS.readInbox('lead'), null, 2));
            rl.prompt();
            return;
        }

        history.push({ role: 'user', content: query });

        try {
            await agentLoop(history);

            const lastMessage = history[history.length - 1];
            if (lastMessage.role === 'assistant' && lastMessage.content) {
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

export { MessageBus, TeammateManager, agentLoop, runBash, runRead, runWrite, runEdit };