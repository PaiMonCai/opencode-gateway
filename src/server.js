/**
 * Process layer: listening socket, managed backend and graceful shutdown.
 *
 * The backend (`opencode serve`) is only spawned when `MANAGE_BACKEND` is on; a
 * backend started elsewhere is health-checked instead. Shutdown on SIGINT/SIGTERM
 * stops accepting connections, kills a backend this process started, and removes
 * the temporary jail directories it created.
 *
 * @module server
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeConfig } from './config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Executable name of the OpenCode CLI. */
const OPENCODE_BASENAME = 'opencode';

/**
 * @typedef {import('./config/schema.js').Config} GatewayConfig
 */

/**
 * Managed-backend bookkeeping for one backend URL.
 *
 * @typedef {object} BackendState
 * @property {boolean} isStarting
 * @property {import('node:child_process').ChildProcess|null} process
 * @property {string|null} jailRoot
 */

/**
 * The logger contract this module relies on (all methods optional).
 *
 * @typedef {object} ServerLogger
 * @property {(message: string, fields?: Record<string, unknown>) => void} [info]
 * @property {(message: string, fields?: Record<string, unknown>) => void} [warn]
 * @property {(message: string, fields?: Record<string, unknown>) => void} [error]
 * @property {(message: string, fields?: Record<string, unknown>) => void} [debug]
 */

const STARTUP_WAIT_ITERATIONS = 60;
const STARTUP_WAIT_INTERVAL_MS = 2000;
const STARTING_WAIT_ITERATIONS = 120;
const STARTING_WAIT_INTERVAL_MS = 1000;

/** Backend plugin that enforces the gateway tool policy. */
const TOOL_LOCK_PLUGIN_FILE = 'opencode-gateway-tool-lock.js';
const TOOL_LOCK_PLUGIN_PATH = path.join(__dirname, '..', 'plugin', TOOL_LOCK_PLUGIN_FILE);

/** PATH entries, as a list. @returns {string[]} Directories. */
function splitPathEnv() {
    const raw = process.env.PATH || '';
    return raw.split(path.delimiter).filter(Boolean);
}

/**
 * @param {string[]} list Target list.
 * @param {string|null|undefined} dir Candidate directory.
 * @returns {void}
 */
function pushDir(list, dir) {
    if (!dir) return;
    if (!list.includes(dir)) list.push(dir);
}

/**
 * @param {string[]} list Target list.
 * @param {string|null|undefined} dir Candidate directory.
 * @returns {void}
 */
function pushExistingDir(list, dir) {
    if (!dir) return;
    if (!fs.existsSync(dir)) return;
    if (!list.includes(dir)) list.push(dir);
}

/**
 * @param {string[]} list Target list.
 * @param {string|null|undefined} baseDir Base directory holding version folders.
 * @param {string} [subpath] Sub-path appended to each version folder.
 * @returns {void}
 */
function addVersionedDirs(list, baseDir, subpath) {
    if (!baseDir || !fs.existsSync(baseDir)) return;
    let entries;
    try {
        entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch (e) {
        return;
    }
    entries.forEach((entry) => {
        if (!entry.isDirectory()) return;
        const full = path.join(baseDir, entry.name, subpath || '');
        pushExistingDir(list, full);
    });
}

/**
 * @param {string|null|undefined} prefix Package-manager prefix.
 * @returns {string|null} Directory holding the executables, or null.
 */
function prefixToBin(prefix) {
    if (!prefix) return null;
    return process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
}

function getOpencodeCandidateNames() {
    if (process.platform === 'win32') {
        return [
            `${OPENCODE_BASENAME}.cmd`,
            `${OPENCODE_BASENAME}.exe`,
            `${OPENCODE_BASENAME}.bat`,
            OPENCODE_BASENAME
        ];
    }
    return [OPENCODE_BASENAME];
}

/**
 * @param {string[]} dirs Directories to search.
 * @param {string[]} names Candidate executable names.
 * @returns {string|null} Full path of the first hit, or null.
 */
function findExecutableInDirs(dirs, names) {
    for (const dir of dirs) {
        for (const name of names) {
            const full = path.join(dir, name);
            if (fs.existsSync(full)) {
                return full;
            }
        }
    }
    return null;
}

/**
 * @param {string|undefined} [requestedPath] Configured path or executable name.
 * @returns {{path: string|null, source: string}} Resolution result.
 */
function resolveOpencodePath(requestedPath) {
    const input = (requestedPath || '').trim();
    const names = getOpencodeCandidateNames();

    if (input) {
        const looksLikePath = path.isAbsolute(input) || input.includes('/') || input.includes('\\');
        if (looksLikePath) {
            if (fs.existsSync(input)) return { path: input, source: 'config' };
            const resolved = path.resolve(process.cwd(), input);
            if (fs.existsSync(resolved)) return { path: resolved, source: 'config' };
        }
    }

    const pathDirs = splitPathEnv();
    const fromPath = findExecutableInDirs(pathDirs, names);
    if (fromPath) return { path: fromPath, source: 'PATH' };

    /** @type {string[]} */
    const extraDirs = [];
    if (process.env.OPENCODE_HOME) {
        pushDir(extraDirs, path.join(process.env.OPENCODE_HOME, 'bin'));
    }
    if (process.env.OPENCODE_DIR) {
        pushDir(extraDirs, path.join(process.env.OPENCODE_DIR, 'bin'));
    }
    pushDir(extraDirs, prefixToBin(process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX));
    pushDir(extraDirs, process.env.PNPM_HOME);
    if (process.env.YARN_GLOBAL_FOLDER) {
        pushDir(extraDirs, path.join(process.env.YARN_GLOBAL_FOLDER, 'bin'));
    }
    if (process.env.VOLTA_HOME) {
        pushDir(extraDirs, path.join(process.env.VOLTA_HOME, 'bin'));
    }
    pushDir(extraDirs, process.env.NVM_BIN);
    pushDir(extraDirs, path.dirname(process.execPath));

    const home = os.homedir();
    if (home) {
        pushDir(extraDirs, path.join(home, '.opencode', 'bin'));
        pushDir(extraDirs, path.join(home, '.local', 'bin'));
        pushDir(extraDirs, path.join(home, '.npm-global', 'bin'));
        pushDir(extraDirs, path.join(home, '.npm', 'bin'));
        pushDir(extraDirs, path.join(home, '.pnpm-global', 'bin'));
        pushDir(extraDirs, path.join(home, '.local', 'share', 'pnpm'));
        pushDir(extraDirs, path.join(home, '.fnm', 'node-versions', 'v1', 'installations'));
        pushDir(extraDirs, path.join(home, '.asdf', 'shims'));
    }

    if (process.platform === 'win32') {
        pushDir(extraDirs, process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null);
        pushDir(extraDirs, process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'pnpm') : null);
        pushDir(extraDirs, process.env.NVM_HOME);
        pushDir(extraDirs, process.env.NVM_SYMLINK);
        pushDir(extraDirs, process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs') : null);
        pushDir(
            extraDirs,
            process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'nodejs') : null
        );
    } else {
        pushDir(extraDirs, '/usr/local/bin');
        pushDir(extraDirs, '/usr/bin');
        pushDir(extraDirs, '/bin');
        pushDir(extraDirs, '/opt/homebrew/bin');
        pushDir(extraDirs, '/snap/bin');
    }

    // nvm (unix) versions
    const nvmDir = process.env.NVM_DIR || (home ? path.join(home, '.nvm') : null);
    if (nvmDir) {
        addVersionedDirs(extraDirs, path.join(nvmDir, 'versions', 'node'), 'bin');
    }

    // asdf nodejs installs
    const asdfDir = process.env.ASDF_DATA_DIR || (home ? path.join(home, '.asdf') : null);
    if (asdfDir) {
        addVersionedDirs(extraDirs, path.join(asdfDir, 'installs', 'nodejs'), 'bin');
    }

    // fnm installs
    if (home) {
        addVersionedDirs(
            extraDirs,
            path.join(home, '.fnm', 'node-versions', 'v1'),
            'installation' + path.sep + 'bin'
        );
    }

    const fromExtras = findExecutableInDirs(extraDirs, names);
    if (fromExtras) return { path: fromExtras, source: 'known-locations' };

    return { path: null, source: 'not-found' };
}

/**
 * Robust Health Check Helper
 */
function buildBackendAuthHeaders(password = '') {
    if (!password) return undefined;
    const token = Buffer.from(`opencode:${password}`).toString('base64');
    return { Authorization: `Basic ${token}` };
}

// `/global/health` is OpenCode's real health endpoint. `/health` is not an API
// route: it falls through to the web UI handler, which may proxy to
// app.opencode.ai and answers 200 even when the API is not usable.
/**
 * Probe the backend's `/global/health` endpoint.
 *
 * @param {string} serverUrl Backend base URL.
 * @param {string} [password] Backend password, when one is configured.
 * @returns {Promise<boolean>} Resolves when the backend reports healthy.
 */
export function checkHealth(serverUrl, password = '') {
    return new Promise((resolve, reject) => {
        const headers = buildBackendAuthHeaders(password);
        /** @type {import('node:http').RequestOptions} */
        const options = headers ? { headers } : {};
        const req = http.get(`${serverUrl}/global/health`, options, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`Status ${res.statusCode}`));
                return;
            }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => {
                try {
                    if (JSON.parse(body)?.healthy === true) resolve(true);
                    else reject(new Error('Backend reported unhealthy'));
                } catch (e) {
                    reject(new Error('Unexpected health response'));
                }
            });
        });
        req.on('error', (e) => reject(e));
        req.setTimeout(2000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

/**
 * Cleanup temporary directories
 */
function cleanupTempDirs() {
    // Only cleanup jail directories on non-Windows platforms
    // On Windows, we don't use isolated jail to avoid path issues
    if (process.platform === 'win32') return;

    const jailRoot = path.join(os.tmpdir(), 'opencode-proxy-jail');
    try {
        if (fs.existsSync(jailRoot)) {
            fs.rmSync(jailRoot, { recursive: true, force: true });
        }
    } catch (e) {
        console.error('[Cleanup] Failed to remove temp dirs:', e instanceof Error ? e.message : String(e));
    }
}

// Register cleanup on exit
process.on('exit', cleanupTempDirs);

// Handle signals - Unix-like systems
if (process.platform !== 'win32') {
    process.on('SIGINT', () => {
        console.log('\n[Shutdown] Received SIGINT, cleaning up...');
        cleanupTempDirs();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        console.log('\n[Shutdown] Received SIGTERM, cleaning up...');
        cleanupTempDirs();
        process.exit(0);
    });
}
// Note: Windows signal handling is limited, cleanup is handled via process.on('exit')

/**
 * Create Express app with proper configuration
 */
/** @type {Map<string, BackendState>} */
const backendState = new Map();

// Merges the tool-lock plugin into OPENCODE_CONFIG_CONTENT for the backend the
// proxy spawns, keeping any config the operator already passes that way.
/**
 * Merge the tool-lock plugin into `OPENCODE_CONFIG_CONTENT`.
 *
 * @param {string} [existing] Config content the operator already passes.
 * @returns {string} Config content for the backend process.
 */
export function buildBackendConfigContent(existing = process.env.OPENCODE_CONFIG_CONTENT) {
    /** @type {Record<string, unknown>} */
    let base = {};
    if (existing) {
        try {
            const parsed = JSON.parse(existing);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                base = /** @type {Record<string, unknown>} */ (parsed);
            }
        } catch (e) {
            console.warn(
                '[Proxy] Ignoring invalid OPENCODE_CONFIG_CONTENT:',
                e instanceof Error ? e.message : String(e)
            );
        }
    }
    const plugins = Array.isArray(base.plugin) ? [...base.plugin] : [];
    if (!plugins.includes(TOOL_LOCK_PLUGIN_PATH)) plugins.push(TOOL_LOCK_PLUGIN_PATH);
    return JSON.stringify({ ...base, plugin: plugins });
}

/**
 * Backend Lifecycle Management
 */
/**
 * Make sure a backend is reachable, spawning and supervising one when allowed.
 *
 * @param {GatewayConfig} config Resolved gateway config.
 * @param {ServerLogger} [logger] Logger dependency.
 * @returns {Promise<void>}
 */
async function ensureManagedBackend(config, logger = {}) {
    const {
        OPENCODE_SERVER_URL,
        OPENCODE_PATH,
        USE_ISOLATED_HOME,
        ZEN_API_KEY,
        OPENCODE_SERVER_PASSWORD,
        MANAGE_BACKEND,
        PROMPT_MODE
    } = config;
    const stateKey = OPENCODE_SERVER_URL;

    if (!backendState.has(stateKey)) {
        backendState.set(stateKey, {
            isStarting: false,
            process: null,
            jailRoot: null
        });
    }

    const state = /** @type {BackendState} */ (backendState.get(stateKey));

    if (state.isStarting) {
        // Wait for startup to complete
        for (let i = 0; i < STARTING_WAIT_ITERATIONS; i++) {
            await new Promise((r) => setTimeout(r, STARTING_WAIT_INTERVAL_MS));
            try {
                await checkHealth(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
                return;
            } catch {
                // Best effort: the backend is being replaced anyway.
            }
        }
        throw new Error('Backend startup timeout');
    }

    try {
        await checkHealth(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
    } catch (err) {
        if (!MANAGE_BACKEND) {
            for (let i = 0; i < STARTUP_WAIT_ITERATIONS; i++) {
                await new Promise((r) => setTimeout(r, STARTUP_WAIT_INTERVAL_MS));
                try {
                    await checkHealth(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
                    return;
                } catch {
                    // Best effort: the backend is being replaced anyway.
                }
            }
            throw err;
        }

        state.isStarting = true;
        logger.info?.(`[Proxy] OpenCode backend not found at ${OPENCODE_SERVER_URL}. Starting...`);

        // Kill existing process if any
        if (state.process) {
            try {
                state.process.kill();
            } catch {
                // Best effort: the backend is being replaced anyway.
            }
        }

        // Cleanup old temp dir
        if (state.jailRoot && fs.existsSync(state.jailRoot)) {
            try {
                fs.rmSync(state.jailRoot, { recursive: true, force: true });
            } catch {
                // Best effort: the backend is being replaced anyway.
            }
        }

        // The tool-lock plugin keeps Zen free models usable (see plugin/), the
        // server password protects the backend API, and the Zen key unlocks
        // paid models. `opencode serve` reads all three from the environment.
        const backendEnv = {
            OPENCODE_CONFIG_CONTENT: buildBackendConfigContent(),
            ...(OPENCODE_SERVER_PASSWORD ? { OPENCODE_SERVER_PASSWORD } : {}),
            ...(ZEN_API_KEY ? { OPENCODE_API_KEY: ZEN_API_KEY } : {})
        };

        const isWindows = process.platform === 'win32';
        const useIsolatedHome =
            typeof USE_ISOLATED_HOME === 'boolean'
                ? USE_ISOLATED_HOME
                : String(process.env.OPENCODE_USE_ISOLATED_HOME || '').toLowerCase() === 'true' ||
                  process.env.OPENCODE_USE_ISOLATED_HOME === '1';

        // On Windows, don't use isolated fake-home to avoid path issues
        // On Unix-like systems, use jail for isolation
        const salt = Math.random().toString(36).substring(7);
        const jailRoot = path.join(os.tmpdir(), 'opencode-proxy-jail', salt);
        state.jailRoot = jailRoot;
        // The jail root lives on the backend state, not on `config`: the config is
        // frozen (mutating it throws in strict mode) and the engine reads its own
        // copy at construction time anyway. Removal is covered by
        // `killManagedBackend` (this jail) and `cleanupTempDirs` (the jail root).
        const workspace = path.join(jailRoot, 'empty-workspace');

        let envVars;
        let cwd;

        if (isWindows) {
            // Windows: use normal user home to avoid opencode storage path issues
            fs.mkdirSync(workspace, { recursive: true });
            cwd = workspace;
            envVars = {
                ...process.env,
                ...backendEnv,
                OPENCODE_PROJECT_DIR: workspace
            };
            console.log('[Proxy] Running on Windows, using standard user home directory');
        } else {
            fs.mkdirSync(workspace, { recursive: true });
            cwd = workspace;

            if (useIsolatedHome) {
                // Unix-like: use isolated fake-home
                const fakeHome = path.join(jailRoot, 'fake-home');

                // Create necessary opencode directories
                const opencodeDir = path.join(fakeHome, '.local', 'share', 'opencode');
                const storageDir = path.join(opencodeDir, 'storage');
                const messageDir = path.join(storageDir, 'message');
                const sessionDir = path.join(storageDir, 'session');

                [fakeHome, opencodeDir, storageDir, messageDir, sessionDir].forEach((d) => {
                    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
                });

                envVars = {
                    ...process.env,
                    HOME: fakeHome,
                    USERPROFILE: fakeHome,
                    ...backendEnv,
                    OPENCODE_PROJECT_DIR: workspace
                };

                if (PROMPT_MODE === 'plugin-inject') {
                    const configDir = path.join(fakeHome, '.config', 'opencode');
                    const pluginDir = path.join(configDir, 'plugin', 'opencode-gateway-empty');
                    fs.mkdirSync(pluginDir, { recursive: true });
                    fs.writeFileSync(
                        path.join(pluginDir, 'index.js'),
                        `export const OpencodeGatewayEmptyPlugin = async () => ({})\nexport default OpencodeGatewayEmptyPlugin\n`,
                        'utf8'
                    );
                    fs.writeFileSync(
                        path.join(configDir, 'opencode.json'),
                        JSON.stringify(
                            {
                                plugin: [path.join(pluginDir, 'index.js')],
                                instructions: [],
                                theme: 'system'
                            },
                            null,
                            2
                        ),
                        'utf8'
                    );
                    console.log('[Proxy] Using plugin-inject prompt mode');
                }
                console.log('[Proxy] Using isolated home for OpenCode');
            } else {
                envVars = {
                    ...process.env,
                    ...backendEnv,
                    OPENCODE_PROJECT_DIR: workspace
                };
                console.log('[Proxy] Using real HOME for OpenCode (isolation disabled)');
            }
        }

        const [, , portStr] = OPENCODE_SERVER_URL.split(':');
        const port = portStr ? portStr.split('/')[0] : '10001';
        const resolved = resolveOpencodePath(OPENCODE_PATH);
        const opencodeBin = resolved.path || OPENCODE_PATH || OPENCODE_BASENAME;
        if (resolved.path) {
            logger.info?.(`[Proxy] Using OpenCode binary: ${opencodeBin} (source: ${resolved.source})`);
        } else {
            logger.warn?.(`[Proxy] Unable to resolve OpenCode binary for '${OPENCODE_PATH}'. Using as-is.`);
        }

        // Cross-platform spawn options
        const useShell =
            process.platform === 'win32' ||
            !resolved.path ||
            opencodeBin.endsWith('.cmd') ||
            opencodeBin.endsWith('.bat');
        /** @type {import('node:child_process').SpawnOptions} */
        const spawnOptions = {
            stdio: 'inherit',
            cwd,
            env: envVars,
            shell: useShell // Use shell only when needed (e.g., Windows .cmd or unresolved PATH)
        };

        const spawnArgs = ['serve', '--port', port, '--hostname', '127.0.0.1'];
        state.process = spawn(opencodeBin, spawnArgs, spawnOptions);

        // Handle spawn errors
        state.process.on(
            'error',
            /** @param {Error & {code?: string}} err */ (err) => {
                console.error(`[Proxy] Failed to spawn OpenCode: ${err.message}`);
                if (err.code === 'ENOENT') {
                    console.error(
                        `[Proxy] Command '${OPENCODE_PATH}' not found. Please ensure OpenCode is installed and in your PATH.`
                    );
                    console.error(
                        `[Proxy] You can specify the full path in config.json using 'OPENCODE_PATH'`
                    );
                }
            }
        );

        // Wait for backend to be ready
        let started = false;
        for (let i = 0; i < STARTUP_WAIT_ITERATIONS; i++) {
            await new Promise((r) => setTimeout(r, STARTUP_WAIT_INTERVAL_MS));
            try {
                await checkHealth(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
                console.log('[Proxy] OpenCode backend ready.');
                started = true;
                break;
            } catch {
                // Best effort: the backend is being replaced anyway.
            }
        }

        state.isStarting = false;

        if (!started) {
            logger.warn?.('[Proxy] Backend start timed out.');
            // Keep the caught error as the cause so the failure chain survives
            // (the lint rule and diagnostics both want the real error here).
            throw new Error('Backend start timeout', { cause: err });
        }
    }
}

/**
 * Starts the OpenCode-to-OpenAI Proxy server.
 */

/**
 * Backend manager: lazy start plus health check of the OpenCode runtime.
 *
 * @param {object} options Manager options.
 * @param {GatewayConfig} options.config Resolved gateway config.
 * @param {ServerLogger} [options.logger] Logger dependency.
 * @returns {{ensureBackend: () => Promise<void>, killBackend: () => void, backendState: Map<string, BackendState>}}
 *   Manager; `killBackend` stops a backend this process spawned.
 */
/**
 * @param {object} options Manager options.
 * @param {GatewayConfig} options.config Resolved gateway config.
 * @param {ServerLogger|null} [options.logger] Logger dependency.
 * @returns {{ensureBackend: () => Promise<void>, killBackend: () => void, backendState: Map<string, BackendState>}}
 */
export function createBackendManager({ config, logger = null }) {
    const ensureBackend = () => ensureManagedBackend(config, logger || {});
    return {
        ensureBackend,
        killBackend: () => {
            killManagedBackend(config);
        },
        backendState
    };
}

/**
 * Start listening, and register the graceful-shutdown handlers.
 *
 * @param {object} options Listen options.
 * @param {import('express').Application} options.app Express application.
 * @param {GatewayConfig} options.config Resolved gateway config.
 * @param {ServerLogger|null} [options.logger] Logger dependency.
 * @param {Map<string, BackendState>} [options.backendState] Managed-backend state map.
 * @param {boolean} [options.installSignalHandlers] Register SIGINT/SIGTERM handlers.
 * @param {(() => Promise<void>)|null} [options.ensureBackend] Warms the managed backend
 *   up once the socket is listening.
 * @returns {import('node:http').Server & {shutdown: (signal: string) => Promise<void>}} The listening server.
 */
export function startServer({
    app,
    config,
    logger = null,
    backendState: state = backendState,
    installSignalHandlers = true,
    ensureBackend = null
}) {
    /** @type {Required<ServerLogger>} */
    const log = /** @type {Required<ServerLogger>} */ (
        logger || {
            info() {},
            warn() {},
            error() {},
            debug() {}
        }
    );
    const server = http.createServer(app);

    server.listen(config.PORT, config.BIND_HOST, () => {
        log.info(`[Proxy] Active at http://${config.BIND_HOST}:${config.PORT}`);
        if (ensureBackend) {
            Promise.resolve()
                .then(() => ensureBackend())
                .catch((error) => {
                    log.error?.('Backend warmup failed', {
                        error: error instanceof Error ? error.message : String(error)
                    });
                });
        }
    });

    /**
     * Stop accepting connections, kill a managed backend and remove jail dirs.
     *
     * @param {string} signal Signal name that triggered the shutdown.
     * @returns {Promise<void>}
     */
    const shutdown = async (signal) => {
        log.info(`[Proxy] Received ${signal}; shutting down`);
        const closed = new Promise((/** @type {(value?: void) => void} */ resolve) =>
            server.close(() => resolve())
        );
        killManagedBackend(config, state);
        try {
            app.locals?.engine?.close?.();
        } catch (error) {
            log.debug?.('Engine close failed', {
                error: error instanceof Error ? error.message : String(error)
            });
        }
        try {
            await app.locals?.engine?.cleanup?.();
        } catch (error) {
            log.debug?.('Temp cleanup failed', {
                error: error instanceof Error ? error.message : String(error)
            });
        }
        await closed;
    };

    if (installSignalHandlers) {
        for (const signal of ['SIGINT', 'SIGTERM']) {
            process.once(signal, () => {
                shutdown(signal)
                    .catch((error) => {
                        log.error('Shutdown failed', {
                            error: error instanceof Error ? error.message : String(error)
                        });
                    })
                    .finally(() => {
                        process.exit(0);
                    });
            });
        }
    }

    const withShutdown =
        /** @type {import('node:http').Server & {shutdown: (signal: string) => Promise<void>}} */ (server);
    withShutdown.shutdown = shutdown;
    return withShutdown;
}

/**
 * Print the documented startup banner (one line per setting, secrets redacted).
 *
 * @param {GatewayConfig} config Resolved gateway config.
 * @param {(line: string) => void} [write] Sink, defaults to stdout.
 * @returns {void}
 */
export function printBanner(config, write = (line) => console.log(line)) {
    describeConfig(config).forEach((entry) => write(entry.line));
}

/**
 * Stop a backend this process spawned and remove its jail directory.
 *
 * @param {GatewayConfig} config Resolved gateway config.
 * @param {Map<string, BackendState>} [state] Managed-backend state map.
 * @returns {void}
 */
export function killManagedBackend(config, state = backendState) {
    const entry = state.get(config.OPENCODE_SERVER_URL);
    if (!entry) return;
    if (entry.process) {
        try {
            entry.process.kill();
        } catch {
            // Already gone.
        }
    }
    if (entry.jailRoot && process.platform !== 'win32') {
        try {
            fs.rmSync(entry.jailRoot, { recursive: true, force: true });
        } catch {
            // Best effort.
        }
    }
    state.delete(config.OPENCODE_SERVER_URL);
}
