import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_URL = process.env.SPX_SCREENSHOT_URL || 'http://127.0.0.1:4174/app/src/main/assets/index.html';
const OUTPUT_DIR = __dirname;
const PROFILE_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'spx-play-screenshots-'));
const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
].filter(Boolean);
const CHROME_PATH = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));

if (!CHROME_PATH) {
    throw new Error('Chrome ou Edge não encontrado. Defina CHROME_PATH.');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(filePath, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            return await fsp.readFile(filePath, 'utf8');
        } catch (_) {
            await sleep(150);
        }
    }
    throw new Error(`Arquivo de depuração não criado: ${filePath}`);
}

class Cdp {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 0;
        this.pending = new Map();
        ws.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            if (!message.id || !this.pending.has(message.id)) return;
            const { resolve, reject } = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
            else resolve(message.result);
        });
    }

    send(method, params = {}, sessionId) {
        const id = ++this.nextId;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        this.ws.send(JSON.stringify(payload));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }

    async evaluate(sessionId, expression) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true
        }, sessionId);
        if (result.exceptionDetails) {
            const message = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
            throw new Error(message);
        }
        return result.result.value;
    }
}

async function setViewport(cdp, sessionId, width, height, scale) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: scale,
        mobile: true,
        screenWidth: width,
        screenHeight: height
    }, sessionId);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
}

async function capture(cdp, sessionId, name) {
    const result = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false
    }, sessionId);
    const filePath = path.join(OUTPUT_DIR, name);
    await fsp.writeFile(filePath, Buffer.from(result.data, 'base64'));
    const data = await fsp.readFile(filePath);
    console.log(`${name}: ${data.readUInt32BE(16)}x${data.readUInt32BE(20)}, ${data.length} bytes`);
    return filePath;
}

const demoRows = [
    ['Rua das Acácias, 120', 'Vila Nova', -22.3245, -49.0920, 'Cliente Demonstração 01', 'Compartimento traseiro', 'A1', 'Normal'],
    ['Av. Nações Unidas, 850', 'Centro', -22.3198, -49.0874, 'Cliente Demonstração 02', 'Porta-malas esquerdo', 'B2', 'Alta'],
    ['Av. Nações Unidas, 872', 'Centro', -22.3201, -49.0879, 'Cliente Demonstração 02', 'Porta-malas esquerdo', 'B3', 'Alta'],
    ['Rua Araújo Leite, 245', 'Jardim América', -22.3290, -49.0970, 'Cliente Demonstração 03', 'Banco traseiro', 'C1', 'Normal'],
    ['Av. Getúlio Vargas, 1320', 'Vila Industrial', -22.3390, -49.0865, 'Cliente Demonstração 04', 'Porta-malas direito', 'D1', 'Urgente'],
    ['Av. Getúlio Vargas, 1368', 'Vila Industrial', -22.3396, -49.0859, 'Cliente Demonstração 04', 'Porta-malas direito', 'D2', 'Urgente'],
    ['Rua Rio Branco, 77', 'Centro', -22.3225, -49.0895, 'Cliente Demonstração 05', 'Banco dianteiro', 'E1', 'Normal'],
    ['Rua Vergílio Guimarães, 460', 'Jardim Panorama', -22.3520, -49.0990, 'Cliente Demonstração 06', 'Compartimento traseiro', 'A2', 'Normal'],
    ['Av. Maringá, 920', 'Jardim Maringá', -22.3470, -49.0820, 'Cliente Demonstração 07', 'Porta-malas esquerdo', 'B1', 'Normal'],
    ['Rua Alcides Costa, 310', 'Parque Xerém', -22.3590, -49.1060, 'Cliente Demonstração 08', 'Compartimento traseiro', 'A3', 'Normal']
].map((row, index) => ({
    'AT ID': 'DEMO-ROUTE-01',
    'Sequence': index + 1,
    'Stop': String([1, 2, 2, 3, 4, 4, 5, 6, 7, 8][index]),
    'SPX TN': `BRDEMO${String(index + 1).padStart(9, '0')}`,
    'Destination Address': row[0],
    'Bairro': row[1],
    'City': 'Bauru',
    'Zipcode/Postal code': '17000-000',
    'Latitude': row[2],
    'Longitude': row[3],
    'Recipient': row[4],
    'Phone': '(14) 0000-0000',
    'Priority': row[7],
    'Service Minutes': row[7] === 'Urgente' ? 6 : 4,
    'Window Start': index === 4 ? '11:30' : '',
    'Window End': index === 4 ? '12:00' : '',
    'Window Type': 'chegada',
    'Vehicle Position': `${row[5]} · ${row[6]}`,
    'Notes': 'Dados fictícios para demonstração'
}));

const chrome = spawn(CHROME_PATH, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    '--remote-debugging-port=0',
    `--user-data-dir=${PROFILE_DIR}`,
    'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });

let chromeErrors = '';
chrome.stderr.on('data', (chunk) => { chromeErrors += chunk.toString(); });

try {
    const activePort = await waitForFile(path.join(PROFILE_DIR, 'DevToolsActivePort'));
    const port = Number(activePort.split(/\r?\n/)[0]);
    if (!Number.isInteger(port)) throw new Error('Porta de depuração inválida.');
    const versionResponse = await fetch(`http://127.0.0.1:${port}/json/version`);
    const browserVersion = await versionResponse.json();
    const ws = new WebSocket(browserVersion.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
    });
    const cdp = new Cdp(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await setViewport(cdp, sessionId, 360, 640, 3);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `try { localStorage.setItem('spx_update_checked_at', String(Date.now())); } catch (_) {}`
    }, sessionId);
    await cdp.send('Page.navigate', { url: APP_URL }, sessionId);

    const readyDeadline = Date.now() + 45000;
    while (Date.now() < readyDeadline) {
        const ready = await cdp.evaluate(sessionId, `document.readyState === 'complete' && !!window.SPXLogistics && typeof normalizeAndGroupSPXRows === 'function'`);
        if (ready) break;
        await sleep(500);
    }
    const ready = await cdp.evaluate(sessionId, `document.readyState === 'complete' && !!window.SPXLogistics && typeof normalizeAndGroupSPXRows === 'function'`);
    if (!ready) throw new Error('A interface do aplicativo não carregou a tempo.');

    const setup = await cdp.evaluate(sessionId, `(async () => {
        const originalBuildMatrix = SPXRouteEngine.buildMatrix;
        SPXRouteEngine.buildMatrix = async (points, options = {}) => originalBuildMatrix(points, { ...options, provider: 'fallback' });
        if (typeof closeUpdateModal === 'function') closeUpdateModal();
        const rows = ${JSON.stringify(demoRows)};
        const summary = await normalizeAndGroupSPXRows(rows, 'Demonstração');
        const firstPackage = groupedStops[0].packages[0];
        const secondPackage = groupedStops[1].packages[0];
        firstPackage.status = 'Entregue';
        secondPackage.status = 'Entregue';
        refreshAllViews(true);
        document.getElementById('updateModalOverlay')?.classList.add('hidden');
        document.getElementById('toastContainer')?.replaceChildren();
        window.scrollTo(0, 0);
        return { summary, firstPackage: firstPackage.spxTn, stops: groupedStops.length };
    })()`);
    console.log(`Rota fictícia: ${setup.stops} paradas, pacote ${setup.firstPackage}`);
    await sleep(6000);

    await cdp.evaluate(sessionId, `switchMobileTab('list'); window.scrollTo(0, 0); document.querySelectorAll('[data-action="close-modal"], [data-action="modal-backdrop"]').forEach(el => el.classList.add('hidden'));`);
    await sleep(900);
    await capture(cdp, sessionId, 'spx-route-os-phone-01-rota.png');

    await cdp.evaluate(sessionId, `switchMobileTab('map'); fitMapToBounds();`);
    await sleep(1800);
    await capture(cdp, sessionId, 'spx-route-os-phone-02-mapa.png');

    await cdp.evaluate(sessionId, `SPXLogistics.openPackageFinder(); const input = document.getElementById('spxFinderSearch'); input.value = '${setup.firstPackage}'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#spxLogisticsRoot > div')?.scrollTo?.(0, 0);`);
    await sleep(900);
    await capture(cdp, sessionId, 'spx-route-os-phone-03-localizador.png');

    await cdp.evaluate(sessionId, `SPXLogistics.openLoad(); document.querySelector('#spxLogisticsRoot > div')?.scrollTo?.(0, 0);`);
    await sleep(900);
    await capture(cdp, sessionId, 'spx-route-os-phone-04-carga.png');

    ws.close();
} catch (error) {
    console.error(error);
    if (chromeErrors) console.error(chromeErrors.slice(-4000));
    process.exitCode = 1;
} finally {
    chrome.kill();
    await Promise.race([
        new Promise((resolve) => chrome.once('exit', resolve)),
        sleep(2500)
    ]);
    await fsp.rm(PROFILE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
