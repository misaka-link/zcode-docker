#!/usr/bin/env node
/**
 * index.mjs
 * ZCode 容器浏览器 MCP 服务端 (stdio JSON-RPC)
 */
import readline from 'node:readline';
import { TOOLS, executeTool } from './tools.mjs';

const SERVER_NAME = 'zcode-browser-desktop';
const SERVER_VERSION = '1.0.0';
const MCP_PROTOCOL_VERSION = '2024-11-05';

function printHelp() {
  console.log(`${SERVER_NAME} v${SERVER_VERSION}`);
  console.log('ZCode 容器浏览器与虚拟桌面 MCP Server (stdio JSON-RPC)\n');
  console.log('用法:');
  console.log('  node index.mjs [options]');
  console.log('\n选项:');
  console.log('  -h, --help     显示此帮助信息并退出');
  console.log('\n可用 MCP 工具清单:');
  for (const tool of TOOLS) {
    console.log(`  - ${tool.name}: ${tool.description}`);
  }
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printHelp();
  process.exit(0);
}

function sendJsonRpc(response) {
  process.stdout.write(JSON.stringify(response) + '\n');
}

function sendResult(id, result) {
  sendJsonRpc({
    jsonrpc: '2.0',
    id,
    result
  });
}

function sendError(id, code, message, data) {
  sendJsonRpc({
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {})
    }
  });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return sendResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION
        }
      });

    case 'notifications/initialized':
      // MCP 客户端初始化完成通知，无需回复
      return;

    case 'ping':
      return sendResult(id, {});

    case 'tools/list':
      return sendResult(id, {
        tools: TOOLS
      });

    case 'tools/call': {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      try {
        const textResult = await executeTool(toolName, toolArgs);
        return sendResult(id, {
          content: [
            {
              type: 'text',
              text: String(textResult)
            }
          ],
          isError: false
        });
      } catch (err) {
        return sendResult(id, {
          content: [
            {
              type: 'text',
              text: `操作失败: ${err.message}`
            }
          ],
          isError: true
        });
      }
    }

    default:
      if (id !== undefined && id !== null) {
        return sendError(id, -32601, `不支持的方法: ${method}`);
      }
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (parseErr) {
    return sendError(null, -32700, `JSON 解析错误: ${parseErr.message}`);
  }

  handleRequest(msg).catch((err) => {
    console.error(`[${SERVER_NAME}] 处理请求异常:`, err);
    if (msg.id !== undefined && msg.id !== null) {
      sendError(msg.id, -32603, `内部错误: ${err.message}`);
    }
  });
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
