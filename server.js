const http = require('http');
const fs = require('fs');
const path = require('path');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

// Patient RFID card mappings (Map card UID hex strings to Patient IDs)
const CARD_PATIENT_MAPPING = {
  // Add your physical RFID card UIDs here (in uppercase HEX without spaces)
  "DEFAULT": "P001" 
};

// HTTP Static File Server & Simple API
const server = http.createServer((req, res) => {
  // API: Get connected serial status and list of COM ports
  if (req.url === '/api/serial-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      connected: activePort !== null && activePort.isOpen,
      portName: activePort ? activePort.path : null,
      lastScan: lastScannedCard
    }));
  }

  // API: List detected USB serial ports
  if (req.url === '/api/ports') {
    SerialPort.list().then(ports => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ports));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  let filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);

  // Security check: ensure path stays within PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Access Denied');
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, fallback) => {
          if (err2) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(fallback, 'utf-8');
          }
        });
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

// WebSocket Server for live push to the browser
const wss = new WebSocketServer({ server });
let wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);

  // Send current serial connection status upon connecting
  ws.send(JSON.stringify({
    type: 'STATUS',
    connected: activePort !== null && activePort.isOpen,
    port: activePort ? activePort.path : null
  }));

  ws.on('close', () => {
    wsClients.delete(ws);
  });
});

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wsClients) {
    if (client.readyState === 1) { // OPEN
      client.send(msg);
    }
  }
}

// -------------------------------------------------------------
// Auto-detect and connect to ESP32 USB Serial Port
// -------------------------------------------------------------
let activePort = null;
let parser = null;
let lastScannedCard = null;
let isScanningPorts = false;

async function autoConnectESP32() {
  if (isScanningPorts || (activePort && activePort.isOpen)) {
    return;
  }

  isScanningPorts = true;
  try {
    const ports = await SerialPort.list();

    // Look for typical ESP32 / USB-UART chipsets (Silicon Labs CP210x, CH340, FTDI, Espressif)
    const targetPort = ports.find(p => {
      const desc = `${p.manufacturer || ''} ${p.pnpId || ''} ${p.friendlyName || ''}`.toLowerCase();
      return (
        desc.includes('cp210') ||
        desc.includes('ch340') ||
        desc.includes('ftdi') ||
        desc.includes('silicon labs') ||
        desc.includes('espressif') ||
        desc.includes('usb-serial') ||
        desc.includes('wch.cn')
      );
    }) || (ports.length === 1 && !ports[0].path.includes('COM1') ? ports[0] : null);

    if (targetPort) {
      console.log(`🔌 Detected ESP32 USB Serial on ${targetPort.path} (${targetPort.manufacturer || targetPort.friendlyName || 'USB Serial'})`);
      openSerialPort(targetPort.path);
    }
  } catch (err) {
    console.error('Error scanning serial ports:', err.message);
  } finally {
    isScanningPorts = false;
  }
}

function openSerialPort(pathName) {
  if (activePort && activePort.isOpen) {
    return;
  }

  activePort = new SerialPort({
    path: pathName,
    baudRate: 115200,
    autoOpen: false
  });

  parser = activePort.pipe(new ReadlineParser({ delimiter: '\r\n' }));

  activePort.open((err) => {
    if (err) {
      console.error(`❌ Failed to open port ${pathName}:`, err.message);
      activePort = null;
      return;
    }

    console.log(`✅ ESP32 Connected on ${pathName} at 115200 baud`);
    broadcast({ type: 'STATUS', connected: true, port: pathName });

    parser.on('data', (rawLine) => {
      handleSerialLine(rawLine.trim());
    });
  });

  activePort.on('close', () => {
    console.log(`⚠️ Serial port ${pathName} disconnected.`);
    activePort = null;
    broadcast({ type: 'STATUS', connected: false, port: null });
  });

  activePort.on('error', (err) => {
    console.error(`⚠️ Serial error on ${pathName}:`, err.message);
  });
}

function handleSerialLine(line) {
  if (!line) return;
  console.log(`[ESP32]: ${line}`);

  let cardUID = null;

  // JSON format: {"type":"RFID_SCAN","uid":"A1B2C3D4"}
  if (line.startsWith('{') && line.includes('RFID_SCAN')) {
    try {
      const data = JSON.parse(line);
      cardUID = data.uid;
    } catch (e) {}
  } else if (line.startsWith('RFID:')) {
    // Prefix format: RFID:A1B2C3D4
    cardUID = line.replace('RFID:', '').trim();
  } else if (line.startsWith('CARD_ID:')) {
    // Direct patient or UID line
    cardUID = line.replace('CARD_ID:', '').trim();
  } else if (line.startsWith('Card UID:')) {
    // Default Arduino example format: Card UID: A1 B2 C3 D4
    cardUID = line.replace('Card UID:', '').replace(/\s+/g, '').toUpperCase();
  }

  if (cardUID) {
    // Match card UID to patient ID (maps to P001 by default or if registered)
    const patientId = CARD_PATIENT_MAPPING[cardUID] || CARD_PATIENT_MAPPING["DEFAULT"] || "P001";
    lastScannedCard = { cardUID, patientId, timestamp: new Date().toISOString() };

    console.log(`💳 Card Scanned! UID: [${cardUID}] -> Patient ID: [${patientId}]`);

    // Broadcast scan event to all open browser windows
    broadcast({
      type: 'RFID_SCAN',
      uid: cardUID,
      patientId: patientId
    });
  }
}

// Periodically probe for plug/unplug of USB ESP32 every 3 seconds
setInterval(autoConnectESP32, 3000);
autoConnectESP32();

server.listen(PORT, () => {
  console.log(`\n🏥 PulseCare HMS Web App running at: http://localhost:${PORT}`);
  console.log(`📡 ESP32 USB RFID Bridge Active (auto-detects COM ports)`);
  console.log(`Press Ctrl+C to stop.\n`);
});
