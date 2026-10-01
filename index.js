import http from 'http';
import puppeteer from 'puppeteer';

const PORT = process.env.PORT || 10000;
const ONPE_URL = 'https://consultaelectoral.onpe.gob.pe/main/local-de-votacion';

let browser = null;
let page = null;
let lastInit = 0;

async function getBrowserSession() {
  const now = Date.now();
  if (browser && page && (now - lastInit < 15 * 60 * 1000)) {
    return { browser, page };
  }

  if (browser) {
    try { await browser.close(); } catch(e) {}
  }

  console.log('[ONPE Service] Iniciando Chromium headless...');
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  });

  page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 800 });

  console.log('[ONPE Service] Cargando sesión WAF ONPE...');
  await page.goto(ONPE_URL, { waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('input#documento, input[type="text"]', { timeout: 15000 }).catch(() => null);
  
  lastInit = Date.now();
  console.log('[ONPE Service] Sesión ONPE activa y lista.');
  return { browser, page };
}

async function consultarDniOnpe(dni) {
  const { page } = await getBrowserSession();
  
  return await page.evaluate(async (dniParam) => {
    try {
      const storageSession = sessionStorage.getItem('token') || localStorage.getItem('token');
      const headers = {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json'
      };
      if (storageSession) {
        headers['Authorization'] = `Bearer ${storageSession}`;
      }

      // Paso 1: Búsqueda inicial
      const respPaso1 = await fetch('https://consultaelectoral.onpe.gob.pe/api/v1/busqueda/dni', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ dni: dniParam })
      });

      if (!respPaso1.ok) {
        return { success: false, error: `Error ONPE Paso 1: HTTP ${respPaso1.status}` };
      }

      const dataPaso1 = await respPaso1.json();
      if (!dataPaso1 || !dataPaso1.data) {
        return { success: false, error: 'DNI no encontrado en padrón electoral' };
      }

      // Paso 2: Consulta definitiva completa
      const respPaso2 = await fetch('https://consultaelectoral.onpe.gob.pe/api/v1/consulta/definitiva', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          dni: dniParam,
          codigo: dataPaso1.data.codigo || dataPaso1.data.token || ''
        })
      });

      if (!respPaso2.ok) {
        return { success: true, data: dataPaso1.data, source: 'onpe_oficial_parcial' };
      }

      const dataPaso2 = await respPaso2.json();
      return { 
        success: true, 
        data: { ...(dataPaso1.data || {}), ...(dataPaso2.data || {}) },
        source: 'onpe_oficial_web' 
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }, dni);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  
  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', service: 'ONPE Microservice' }));
    return;
  }

  const match = url.pathname.match(/^\/dni\/(\d{8})$/);
  if (match) {
    const dni = match[1];
    try {
      const resultado = await consultarDniOnpe(dni);
      res.writeHead(resultado.success ? 200 : 404);
      res.end(JSON.stringify(resultado));
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Endpoint no encontrado. Use /dni/{8_digitos}' }));
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[ONPE Service] Servidor escuchando en puerto ${PORT}`);
  try {
    await getBrowserSession();
    console.log('[ONPE Service] Listo para recibir consultas.');
  } catch (err) {
    console.error('[ONPE Service] Error inicializando Chromium:', err.message);
  }
});
