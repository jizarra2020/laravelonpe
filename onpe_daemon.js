import http from 'http';
import puppeteer from 'puppeteer-core';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findChromeExecutable() {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
        return process.env.CHROME_PATH;
    }
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const platform = process.platform;
    const candidates = [];

    if (platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || '';
        const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
        const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

        candidates.push(
            path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        );
    } else if (platform === 'linux') {
        try {
            const checkDirs = [
                path.join(__dirname, '..', '..', '..', '..', 'storage', 'app', 'bin', 'chrome-portable'),
                path.join(__dirname, '..', '..', '..', '..', 'chrome-bin')
            ];
            for (const rootDir of checkDirs) {
                if (fs.existsSync(rootDir)) {
                    const findInDir = (dir) => {
                        const entries = fs.readdirSync(dir, { withFileTypes: true });
                        for (const entry of entries) {
                            const full = path.join(dir, entry.name);
                            if (entry.isDirectory()) {
                                const found = findInDir(full);
                                if (found) return found;
                            } else if (entry.name === 'chrome' && !entry.name.includes('.')) {
                                return full;
                            }
                        }
                        return null;
                    };
                    const found = findInDir(rootDir);
                    if (found) candidates.push(found);
                }
            }
        } catch (e) {}

        candidates.push(
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
            '/usr/bin/google-chrome-unstable'
        );
    } else if (platform === 'darwin') {
        candidates.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium'
        );
    }

    for (const p of candidates) {
        if (p && fs.existsSync(p)) {
            return p;
        }
    }

    return platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome';
}

const chromePath = findChromeExecutable();
const PORT = process.env.ONPE_DAEMON_PORT || 3199;

class DedicatedWarmedOnpeDaemon {
    constructor() {
        this.browser = null;
        this.page = null;
        this.isReady = false;
        this.isInitializing = false;
        this.queue = Promise.resolve();
        this.lastRefresh = 0;
        this.queryCount = 0;
    }

    async init() {
        if (this.isInitializing) return;
        this.isInitializing = true;
        try {
            console.log(`[ONPE Engine] Starting dedicated Chrome engine using: ${chromePath}...`);
            this.browser = await puppeteer.launch({
                executablePath: chromePath,
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-infobars',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--disable-extensions',
                    '--disable-component-update',
                    '--disable-background-networking',
                    '--blink-settings=imagesEnabled=false',
                    '--disable-remote-fonts',
                    '--mute-audio',
                    '--no-first-run',
                    '--no-default-browser-check',
                    '--window-size=1366,768'
                ],
                ignoreDefaultArgs: ['--enable-automation']
            });

            await this.refreshWafSession();

            this.isReady = true;
            this.isInitializing = false;
            console.log(`[ONPE Engine] READY on http://127.0.0.1:${PORT}`);

            // Keep-alive every 2 minutes
            setInterval(() => {
                const now = Date.now();
                if (now - this.lastRefresh > 120000 && this.isReady) {
                    this.queue = this.queue.then(() => this.refreshWafSession().catch(() => {}));
                }
            }, 30000);

        } catch (e) {
            console.error('[ONPE Engine] Init error:', e);
            this.isInitializing = false;
            this.isReady = false;
        }
    }

    async restartBrowser() {
        try {
            if (this.browser) {
                try { await this.browser.close(); } catch (e) {}
                this.browser = null;
            }
            this.page = null;
            this.isReady = false;
            this.isInitializing = false;
            await this.init();
        } catch (e) {
            console.error('[ONPE Engine] Browser restart error:', e);
        }
    }

    async refreshWafSession() {
        try {
            if (this.page) {
                try { await this.page.close(); } catch (e) {}
                this.page = null;
            }

            const newPage = await this.browser.newPage();
            await newPage.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                window.chrome = { runtime: {} };
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                Object.defineProperty(navigator, 'languages', { get: () => ['es-PE', 'es-419', 'es', 'en'] });
            });

            await newPage.setRequestInterception(true);
            newPage.on('request', (req) => {
                const url = req.url();
                const rt = req.resourceType();
                if (url.includes('google-analytics') || url.includes('analytics.google') || url.includes('googletagmanager')) {
                    req.abort();
                } else if (['image', 'stylesheet', 'font', 'media'].includes(rt)) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            await newPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
            await newPage.setViewport({ width: 1366, height: 768 });

            await newPage.goto('https://consultaelectoral.onpe.gob.pe/inicio', {
                waitUntil: 'networkidle2',
                timeout: 15000
            });
            await newPage.waitForFunction(() => typeof window.AwsWafIntegration !== 'undefined', { timeout: 5000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 600));

            this.page = newPage;
            this.lastRefresh = Date.now();
            this.queryCount = 0;
        } catch (e) {
            console.error('[ONPE Engine] Session refresh warning:', e.message);
        }
    }

    async executeQueryOnPage(dniToQuery) {
        if (!this.page) return { success: false, retryable: true, error: 'No page' };

        return await this.page.evaluate(async (targetDni) => {
            try {
                const fetchFn = (window.AwsWafIntegration && typeof window.AwsWafIntegration.fetch === 'function')
                    ? window.AwsWafIntegration.fetch
                    : window.fetch;

                // Step 1: busqueda/dni
                const r1 = await fetchFn('https://consultaelectoral.onpe.gob.pe/v1/api/busqueda/dni', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json, text/plain, */*'
                    },
                    body: JSON.stringify({ numeroDocumento: targetDni })
                });

                if (!r1.ok) {
                    const text1 = await r1.text();
                    return { success: false, retryable: true, status: r1.status, error: text1.substring(0, 100) };
                }

                const j1 = await r1.json();
                const token = j1?.data?.token;

                if (!token) {
                    return {
                        success: false,
                        retryable: false,
                        notParticipating: true,
                        error: j1?.message || 'El DNI no participa en este proceso electoral o no existe en el registro.',
                        j1: j1
                    };
                }

                // Step 2: consulta/definitiva
                const r2 = await fetchFn('https://consultaelectoral.onpe.gob.pe/v1/api/consulta/definitiva', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json, text/plain, */*',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({})
                });

                if (!r2.ok) {
                    const text2 = await r2.text();
                    return { success: false, retryable: true, status: r2.status, error: text2.substring(0, 100) };
                }

                const j2 = await r2.json();
                const data = j2?.data;
                if (!data) {
                    return { success: false, retryable: false, error: j2?.message || 'Sin datos definitivos en ONPE', j2 };
                }

                const nombres = (data.nombres || '').trim();
                const apellidos = (data.apellidos || '').trim();
                const nombreCompleto = `${nombres} ${apellidos}`.trim().toUpperCase();

                let distrito = null;
                let region = 'LIMA';
                let provincia = 'LIMA';
                if (data.ubigeo) {
                    const parts = data.ubigeo.split('/').map(p => p.trim());
                    if (parts.length >= 3) {
                        region = parts[0].toUpperCase();
                        provincia = parts[1].toUpperCase();
                        distrito = parts[2].toUpperCase();
                    } else if (parts.length > 0) {
                        distrito = parts[parts.length - 1].toUpperCase();
                    }
                }

                let ref = (data.referencia || '').trim();
                if (ref && !ref.toUpperCase().startsWith('REFERENCIA:')) {
                    ref = `Referencia: ${ref}`;
                }

                return {
                    success: true,
                    dni: targetDni,
                    nombre: nombreCompleto,
                    region: region,
                    provincia: provincia,
                    distrito: distrito,
                    contenedor_local: data.ubigeo || null,
                    txtCenter: (data.localVotacion || '').trim().toUpperCase() || null,
                    direccion_local: (data.direccion || '').trim().toUpperCase() || null,
                    txtReferencia: ref || null,
                    nro_mesa: String(data.mesaSufragio || '').trim() || null,
                    has_electoral_data: true,
                    manual_entry: false
                };
            } catch (err) {
                return { success: false, retryable: true, error: err.toString() };
            }
        }, dniToQuery);
    }

    async query(targetDni) {
        if (!this.isReady || !this.browser) {
            return { success: false, error: 'Engine initializing' };
        }

        return new Promise((resolve) => {
            this.queue = this.queue.then(async () => {
                try {
                    this.queryCount++;
                    if (!this.page) {
                        await this.refreshWafSession();
                    }

                    let res = await this.executeQueryOnPage(targetDni);

                    // Si falló por sesión WAF bloqueada/expirada, reiniciar y reintentar 1 vez
                    if (!res || (!res.success && res.retryable)) {
                        console.log(`[ONPE Engine] Recycling session due to retryable response for ${targetDni}...`);
                        await this.restartBrowser();
                        res = await this.executeQueryOnPage(targetDni);
                    }

                    await new Promise(r => setTimeout(r, 40));
                    resolve(res);
                } catch (e) {
                    resolve({ success: false, error: e.toString() });
                }
            });
        });

    }
}

const daemon = new DedicatedWarmedOnpeDaemon();

const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/health') {
        res.writeHead(200);
        res.end(JSON.stringify({ 
            status: daemon.isReady ? 'ready' : (daemon.isInitializing ? 'initializing' : 'stopped'),
            uptime: Math.round(process.uptime())
        }));
        return;
    }

    const dniMatch = url.pathname.match(/\/dni\/(\d{8})/);
    const dni = dniMatch ? dniMatch[1] : (url.searchParams.get('dni') || '').trim();

    if (!dni || dni.length !== 8 || !/^\d{8}$/.test(dni)) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'DNI inválido' }));
        return;
    }

    try {
        const result = await daemon.query(dni);
        res.writeHead(200);
        res.end(JSON.stringify(result));
    } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: e.toString() }));
    }
});

server.listen(PORT, '127.0.0.1', async () => {
    console.log(`[ONPE Engine] Listening on http://127.0.0.1:${PORT}`);
    await daemon.init();
});
