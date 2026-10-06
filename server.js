const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const BACKUP_DIR = path.join(ROOT, 'backups');
const MAX_BACKUPS_PER_FILE = 100;
const DATA_FILES = {
    '/api/letture': path.join(ROOT, 'letture.json'),
    '/api/periods': path.join(ROOT, 'periods.json')
};

// MIME types
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.ics': 'text/calendar; charset=utf-8'
};

const sendJSON = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
        body += chunk;
        if (body.length > 5e6) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
});

// Indirizzi raggiungibili dagli altri dispositivi di casa (es. il telefono)
const lanUrls = () => Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => `http://${i.address}:${PORT}`);

// ---------- Backup ----------
// Prima di ogni scrittura che cambia i dati, il file attuale viene copiato in backups/
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const backupFile = (file) => {
    if (!fs.existsSync(file)) return null;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const base = path.basename(file, '.json');
    const name = `${base}-${stamp()}.json`;
    fs.copyFileSync(file, path.join(BACKUP_DIR, name));
    // Mantiene solo i backup più recenti per ciascun file
    fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith(`${base}-`)).sort().reverse()
        .slice(MAX_BACKUPS_PER_FILE).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
    return name;
};

const writeData = (file, data) => {
    const json = JSON.stringify(data, null, 2);
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (current === json) return false; // nessun cambiamento: niente backup né scrittura
    if (current) backupFile(file);
    fs.writeFileSync(file, json, 'utf8');
    return true;
};

const listBackups = () => {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR).filter(f => /^(letture|periods)-.*\.json$/.test(f)).sort().reverse().map(name => {
        const full = path.join(BACKUP_DIR, name);
        let count = null;
        try { count = JSON.parse(fs.readFileSync(full, 'utf8')).length; } catch { /* file illeggibile */ }
        return { name, kind: name.split('-')[0], size: fs.statSync(full).size, count };
    });
};

const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
        res.writeHead(400);
        res.end('Bad request');
        return;
    }

    // API: GET/POST /api/letture, /api/periods
    const dataFile = DATA_FILES[pathname];
    if (dataFile) {
        if (req.method === 'GET') {
            fs.readFile(dataFile, 'utf8', (err, data) => sendJSON(res, 200, err ? '[]' : data));
            return;
        }
        if (req.method === 'POST') {
            try {
                const data = JSON.parse(await readBody(req));
                if (!Array.isArray(data)) throw new Error('not an array');
                const changed = writeData(dataFile, data);
                sendJSON(res, 200, { success: true, count: data.length, changed });
            } catch (e) {
                sendJSON(res, 400, { error: 'JSON non valido' });
            }
            return;
        }
        sendJSON(res, 405, { error: 'Metodo non supportato' });
        return;
    }

    if (pathname === '/api/info' && req.method === 'GET') {
        sendJSON(res, 200, { lanUrls: lanUrls(), backups: listBackups().length });
        return;
    }

    if (pathname === '/api/backups' && req.method === 'GET') {
        sendJSON(res, 200, listBackups());
        return;
    }

    // Ripristino: il file attuale viene a sua volta salvato in backup prima di essere sostituito
    if (pathname === '/api/backups/restore' && req.method === 'POST') {
        try {
            const { name } = JSON.parse(await readBody(req));
            if (!/^(letture|periods)-[\w-]+\.json$/.test(name || '')) throw new Error('bad name');
            const src = path.join(BACKUP_DIR, name);
            const data = JSON.parse(fs.readFileSync(src, 'utf8'));
            if (!Array.isArray(data)) throw new Error('not an array');
            const target = DATA_FILES[`/api/${name.split('-')[0]}`];
            writeData(target, data);
            sendJSON(res, 200, { success: true, count: data.length });
        } catch (e) {
            sendJSON(res, 400, { error: 'Ripristino non riuscito' });
        }
        return;
    }

    // Serve file statici (solo dentro la cartella del progetto, mai i backup)
    const filePath = path.normalize(path.join(ROOT, pathname === '/' ? '/index.html' : pathname));
    if (!filePath.startsWith(ROOT + path.sep) || filePath.startsWith(BACKUP_DIR)) {
        res.writeHead(403);
        res.end('Accesso negato');
        return;
    }

    const contentType = MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(err.code === 'ENOENT' ? 404 : 500);
            res.end(err.code === 'ENOENT' ? 'File non trovato' : 'Errore server');
            return;
        }
        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-store, no-cache, must-revalidate'
        });
        res.end(content);
    });
});

server.listen(PORT, () => {
    const lan = lanUrls();
    console.log(`
🔥 Server Contabilizzatori avviato!
📊 Dashboard: http://localhost:${PORT}
📱 Dal telefono (stessa rete Wi-Fi): ${lan.length ? lan.join(', ') : 'nessuna rete trovata'}
📁 Dati: ${DATA_FILES['/api/letture']}
🗄  Backup: ${BACKUP_DIR}

Premi Ctrl+C per fermare il server
    `);
});
