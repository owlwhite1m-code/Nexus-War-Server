const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const rooms = new Map(); // roomId -> { clients: Set<WebSocket> }

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function normalizeRoomId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
}

function createRoom(roomId, ws) {
  if (rooms.has(roomId)) return false;
  rooms.set(roomId, { clients: new Set([ws]) });
  ws.roomId = roomId;
  ws.roomRole = 'host';
  return true;
}

function joinRoom(roomId, ws) {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, message: 'ไม่พบห้องนี้ หรือห้องถูกปิดแล้ว' };
  if (room.clients.size >= 2) return { ok: false, message: 'ห้องนี้มีผู้เล่นครบ 2 คนแล้ว' };
  room.clients.add(ws);
  ws.roomId = roomId;
  ws.roomRole = 'guest';
  return { ok: true, room };
}

function leaveRoom(ws) {
  const roomId = ws.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;
  room.clients.delete(ws);
  for (const client of room.clients) send(client, { type: 'OPPONENT_LEFT' });
  if (room.clients.size === 0) rooms.delete(roomId);
  ws.roomId = null;
}

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname); }
  catch { res.writeHead(400); return res.end('Bad Request'); }
  if (urlPath === '/') urlPath = '/index.html';
  const safePath = path.normalize(urlPath).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    const ext = path.extname(filePath).toLowerCase();
    const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  send(ws, { type: 'SERVER_READY', message: 'Game Server พร้อมใช้งาน' });

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'ROOM_ERROR', message: 'ข้อมูลจากเกมไม่ถูกต้อง' }); }
    if (!data || !data.type) return;

    if (data.type === 'CREATE_ROOM') {
      if (ws.roomId) leaveRoom(ws);
      const roomId = normalizeRoomId(data.roomId);
      if (!/^[a-z0-9]{6,12}$/.test(roomId)) return send(ws, { type: 'ROOM_ERROR', message: 'รหัสห้องไม่ถูกต้อง' });
      if (!createRoom(roomId, ws)) return send(ws, { type: 'ROOM_ERROR', message: 'รหัสห้องซ้ำ กรุณาสร้างใหม่' });
      send(ws, { type: 'ROOM_CREATED', roomId, role: 'host' });
      return;
    }

    if (data.type === 'JOIN_ROOM') {
      if (ws.roomId) leaveRoom(ws);
      const roomId = normalizeRoomId(data.roomId);
      const result = joinRoom(roomId, ws);
      if (!result.ok) return send(ws, { type: 'ROOM_ERROR', message: result.message });
      send(ws, { type: 'ROOM_JOINED', roomId, role: 'guest' });
      for (const client of result.room.clients) send(client, { type: 'OPPONENT_CONNECTED', roomId });
      return;
    }

    // All other game messages are relayed only to the other player in the same 2-player room.
    if (ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (!room) return send(ws, { type: 'ROOM_ERROR', message: 'ห้องนี้ไม่มีอยู่แล้ว' });
      for (const client of room.clients) {
        if (client !== ws) send(client, data);
      }
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.on('close', () => clearInterval(heartbeat));
server.listen(PORT, '0.0.0.0', () => console.log(`Nexus War server running on port ${PORT}`));
