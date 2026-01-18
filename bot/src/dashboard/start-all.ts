/**
 * 一键启动 Dashboard (后端 + React 前端)
 */

import { spawn, ChildProcess } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendDir = join(__dirname, 'frontend');
const botDir = join(__dirname, '..', '..');

const BACKEND_PORT = process.env.DASHBOARD_PORT || 3002;
const FRONTEND_PORT = 5173;

let backendProcess: ChildProcess | null = null;
let frontendProcess: ChildProcess | null = null;

function log(tag: string, message: string) {
    const time = new Date().toLocaleTimeString();
    console.log(`[${time}] [${tag}] ${message}`);
}

function startBackend(): Promise<void> {
    return new Promise((resolve, reject) => {
        log('BACKEND', `启动后端服务 (端口 ${BACKEND_PORT})...`);

        backendProcess = spawn('npx', ['tsx', 'src/dashboard/start-dashboard.ts'], {
            cwd: botDir,
            shell: true,
            stdio: ['inherit', 'pipe', 'pipe'],
            env: { ...process.env, DASHBOARD_PORT: String(BACKEND_PORT) }
        });

        let resolved = false;

        backendProcess.stdout?.on('data', (data) => {
            const text = data.toString().trim();
            if (text) {
                for (const line of text.split('\n')) {
                    log('BACKEND', line);
                }
            }
            // 检测后端启动成功
            if (!resolved && text.includes('Dashboard 运行在')) {
                resolved = true;
                resolve();
            }
        });

        backendProcess.stderr?.on('data', (data) => {
            const text = data.toString().trim();
            if (text && !text.includes('ExperimentalWarning')) {
                log('BACKEND', `[ERR] ${text}`);
            }
        });

        backendProcess.on('error', (err) => {
            log('BACKEND', `启动失败: ${err.message}`);
            if (!resolved) reject(err);
        });

        backendProcess.on('exit', (code) => {
            log('BACKEND', `进程退出 (code: ${code})`);
            backendProcess = null;
        });

        // 超时检测
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                resolve(); // 即使没检测到也继续
            }
        }, 10000);
    });
}

function startFrontend(): Promise<void> {
    return new Promise((resolve, reject) => {
        // 检查 frontend 目录是否存在
        if (!existsSync(frontendDir)) {
            log('FRONTEND', '前端目录不存在，跳过');
            resolve();
            return;
        }

        // 检查 node_modules
        if (!existsSync(join(frontendDir, 'node_modules'))) {
            log('FRONTEND', '正在安装依赖...');
            const installProcess = spawn('npm', ['install'], {
                cwd: frontendDir,
                shell: true,
                stdio: 'inherit'
            });

            installProcess.on('close', (code) => {
                if (code !== 0) {
                    log('FRONTEND', '依赖安装失败');
                    resolve(); // 继续，不阻断
                    return;
                }
                launchFrontend();
            });
        } else {
            launchFrontend();
        }

        function launchFrontend() {
            log('FRONTEND', `启动 React 前端 (端口 ${FRONTEND_PORT})...`);

            frontendProcess = spawn('npm', ['run', 'dev'], {
                cwd: frontendDir,
                shell: true,
                stdio: ['inherit', 'pipe', 'pipe'],
            });

            let resolved = false;

            frontendProcess.stdout?.on('data', (data) => {
                const text = data.toString().trim();
                if (text) {
                    for (const line of text.split('\n')) {
                        log('FRONTEND', line);
                    }
                }
                if (!resolved && (text.includes('Local:') || text.includes('localhost'))) {
                    resolved = true;
                    resolve();
                }
            });

            frontendProcess.stderr?.on('data', (data) => {
                const text = data.toString().trim();
                if (text) {
                    log('FRONTEND', `[ERR] ${text}`);
                }
            });

            frontendProcess.on('error', (err) => {
                log('FRONTEND', `启动失败: ${err.message}`);
                if (!resolved) {
                    resolved = true;
                    resolve();
                }
            });

            frontendProcess.on('exit', (code) => {
                log('FRONTEND', `进程退出 (code: ${code})`);
                frontendProcess = null;
            });

            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    resolve();
                }
            }, 15000);
        }
    });
}

function cleanup() {
    log('MAIN', '正在关闭...');

    if (frontendProcess) {
        frontendProcess.kill();
        frontendProcess = null;
    }

    if (backendProcess) {
        backendProcess.kill();
        backendProcess = null;
    }

    process.exit(0);
}

async function main() {
    console.log('');
    console.log('═'.repeat(60));
    console.log('  Arb Scanner Dashboard 一键启动');
    console.log('═'.repeat(60));
    console.log('');

    // 注册退出处理
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    try {
        // 1. 启动后端
        await startBackend();

        // 2. 启动前端
        await startFrontend();

        console.log('');
        console.log('─'.repeat(60));
        console.log('  ✅ Dashboard 已启动');
        console.log('─'.repeat(60));
        console.log(`  📊 后端 API:   http://localhost:${BACKEND_PORT}`);
        console.log(`  🎨 React 前端: http://localhost:${FRONTEND_PORT}`);
        console.log(`  📡 SSE 流:     http://localhost:${BACKEND_PORT}/api/stream`);
        console.log('─'.repeat(60));
        console.log('  按 Ctrl+C 停止所有服务');
        console.log('─'.repeat(60));
        console.log('');

    } catch (error: any) {
        log('MAIN', `启动失败: ${error.message}`);
        cleanup();
    }
}

main();
