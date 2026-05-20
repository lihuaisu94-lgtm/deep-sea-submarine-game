const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');

// ── Load continent data from index.html ──
const html = fs.readFileSync('./index.html', 'utf8');
const m = html.match(/const continents = (\[[\s\S]*?\]);/);
if (!m) { console.error('FATAL: Could not extract continents from index.html'); process.exit(1); }
const continents = eval(m[1]);
console.log(`[Map] Loaded ${continents.length} continent polygons`);

// ═══════════════════════════════════════════
//  SERVER PHYSICS ENGINE
// ═══════════════════════════════════════════
const WORLD_W = 4800, WORLD_H = 2400;

function wrapX(x) { while (x < 0) x += WORLD_W; while (x >= WORLD_W) x -= WORLD_W; return x; }
function wrappedDistX(a, b) { let dx = b - a; if (dx > WORLD_W/2) dx -= WORLD_W; else if (dx < -WORLD_W/2) dx += WORLD_W; return dx; }

function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function checkLandCollision(cx, cy, radius) {
  const wx = wrapX(cx);
  for (const c of continents) { if (pointInPolygon(wx, cy, c.points)) return true; }
  for (let i = 0; i < 8; i++) {
    const a = (i/8)*Math.PI*2, sx = wrapX(wx + Math.cos(a)*radius), sy = cy + Math.sin(a)*radius;
    for (const c of continents) { if (pointInPolygon(sx, sy, c.points)) return true; }
  }
  return false;
}

function isPointOnLand(x, y) { const wx = wrapX(x); for (const c of continents) { if (pointInPolygon(wx, y, c.points)) return true; } return false; }

// ── Find spawnable ocean position ──
function randomOceanPos() {
  for (let a = 0; a < 100; a++) { const sx = Math.random()*WORLD_W, sy = Math.random()*WORLD_H; if (!isPointOnLand(sx, sy)) return { x: sx, y: sy }; }
  return { x: 2400, y: 1200 };
}

// ═══════════════════════════════════════════
//  SUBMARINE PHYSICS (per-tick)
// ═══════════════════════════════════════════
function updateSubPhysics(p, dt) {
  if (!p.alive) { p.respawnTimer -= dt; if (p.respawnTimer <= 0) respawnPlayer(p); return; }
  // Rotation
  let turn = 0; if (p.input.a) turn = -1; if (p.input.d) turn = 1;
  p.angularVel += turn * 3.5 * dt;
  p.angularVel = Math.max(-1.8, Math.min(1.8, p.angularVel));
  if (turn === 0) p.angularVel *= (1 - Math.min(3.0 * dt, 1));
  p.heading += p.angularVel * dt;
  // Thrust
  let thrust = 0; if (p.input.w) thrust = 1; if (p.input.s) thrust = -1;
  if (thrust !== 0) { p.speed += thrust * 180 * dt; p.speed = Math.max(-140, Math.min(280, p.speed)); }
  else { if (Math.abs(p.speed) < 0.5) p.speed = 0; else p.speed *= (1 - Math.min(0.36 * dt, 1)); }
  // Movement
  const dx = Math.cos(p.heading) * p.speed * dt, dy = Math.sin(p.heading) * p.speed * dt;
  let nx = p.x + dx, ny = p.y + dy;
  ny = Math.max(16, Math.min(WORLD_H - 16, ny)); nx = wrapX(nx);
  if (checkLandCollision(nx, ny, 16)) {
    const cX = !checkLandCollision(nx, p.y, 16), cY = !checkLandCollision(p.x, ny, 16);
    if (cX) { p.x = nx; p.speed *= 0.9; } if (cY) { p.y = ny; p.speed *= 0.9; }
  } else { p.x = nx; p.y = ny; }
  p.x = wrapX(p.x);
}

function respawnPlayer(p) {
  const pos = randomOceanPos(); p.x = pos.x; p.y = pos.y; p.speed = 0; p.heading = 0; p.angularVel = 0;
  p.alive = true; p.hp = 100; p.respawnTimer = 0;
}

// ═══════════════════════════════════════════
//  SERVER MISSILE
// ═══════════════════════════════════════════
class SvrMissile {
  constructor(x, y, heading, ownerId) {
    this.x = x; this.y = y; this.heading = heading; this.ownerId = ownerId;
    this.speed = 840; this.life = 4.0; this.age = 0; this.alive = true;
  }
  update(dt) {
    this.age += dt; if (this.age >= this.life) { this.alive = false; return; }
    this.x += Math.cos(this.heading) * this.speed * dt;
    this.y += Math.sin(this.heading) * this.speed * dt;
    if (this.y < -50 || this.y > WORLD_H + 50) { this.alive = false; return; }
    this.x = wrapX(this.x);
    if (isPointOnLand(this.x, this.y)) this.alive = false;
  }
}

// ═══════════════════════════════════════════
//  SKILL SKELETONS (server spawns in ocean)
// ═══════════════════════════════════════════
const ALL_SKILL_TYPES = ['MISSILE_BIG','MISSILE_FAST','MULTI_HEAD','STEALTH','LASER','DECOY','MINE'];

// ═══════════════════════════════════════════
//  ROOM CLASS
// ═══════════════════════════════════════════
class Room {
  constructor(id) {
    this.id = id;
    this.players = new Map();
    this.missiles = []; this.skills = []; this.mines = []; this.lasers = [];
    this.skillTimer = 8;
    this.tickInterval = null;
    this.createdAt = Date.now();
    this.startTime = Date.now();
    this.gameOver = false;
    this.gameMode = 'deathmatch';
    this.scoreLimit = 10;
    this.timeLimit = 300000; // 5 min
    this.winner = null;
    this.winReason = '';
  }

  startLoop() {
    if (this.tickInterval) return;
    this.tickInterval = setInterval(() => this.tick(), 50);
  }

  stopLoop() {
    if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null; }
  }

  tick() {
    if (this.gameOver) return;
    const dt = 0.05;
    const tNow = Date.now();
    const now = tNow / 1000;

    // ── Win condition: time limit ──
    if (tNow - this.startTime > this.timeLimit) { this.endGame('time'); return; }

    // ── Update players ──
    for (const p of this.players.values()) updateSubPhysics(p, dt);

    // ── Update missiles ──
    for (const m of this.missiles) m.update(dt);
    // Missile vs player hit detection
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      if (!m.alive) { this.missiles.splice(i, 1); continue; }
      for (const p of this.players.values()) {
        if (p.colorIdx === m.ownerId) continue; // no self-hit
        if (!p.alive) continue;
        const ddx = wrappedDistX(p.x, m.x), ddy = p.y - m.y;
        if (Math.sqrt(ddx*ddx + ddy*ddy) < 20) {
          p.hp -= 25; m.alive = false;
          if (p.hp <= 0) {
            p.alive = false; p.respawnTimer = 10; p.deaths = (p.deaths||0)+1;
            const atk = this._findPlayer(m.ownerId); if (atk) { atk.kills = (atk.kills||0)+1; if (atk.kills >= this.scoreLimit) { this.broadcast({ type:'player_died', colorIdx:p.colorIdx, respawnIn:10, killerColor:m.ownerId }); this.endGame('kill', m.ownerId); return; } }
            this.broadcast({ type:'player_died', colorIdx:p.colorIdx, respawnIn:10, killerColor:m.ownerId });
          } else {
            this.broadcast({ type:'player_hit', targetColor:p.colorIdx, attackerColor:m.ownerId, damage:25, hp:p.hp });
          }
          break;
        }
      }
    }
    // Clean dead missiles
    for (let i = this.missiles.length - 1; i >= 0; i--) { if (!this.missiles[i].alive) this.missiles.splice(i, 1); }

    // ── Skill spawn (every 10s, max 5) ──
    this.skillTimer -= dt;
    if (this.skillTimer <= 0 && this.skills.length < 5) {
      this.skillTimer = 10;
      for (let a = 0; a < 20; a++) {
        const sx = Math.random()*WORLD_W, sy = Math.random()*WORLD_H;
        if (!isPointOnLand(sx, sy)) {
          // Distance check >800px from existing skills
          let tooClose = false;
          for (const s of this.skills) { const ddx = wrappedDistX(sx, s.x); if (Math.sqrt(ddx*ddx + (sy-s.y)*(sy-s.y)) < 800) { tooClose = true; break; } }
          if (!tooClose) { this.skills.push({ x:sx, y:sy, type:ALL_SKILL_TYPES[Math.floor(Math.random()*ALL_SKILL_TYPES.length)] }); break; }
        }
      }
    }
    // Skill pickup
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      for (let i = this.skills.length - 1; i >= 0; i--) {
        const s = this.skills[i];
        const ddx = wrappedDistX(p.x, s.x), ddy = p.y - s.y;
        if (Math.sqrt(ddx*ddx + ddy*ddy) < 40) { this.skills.splice(i, 1); break; }
      }
    }

    // ── Mines: collision vs all players ──
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const mine = this.mines[i];
      if (now - mine.placedAt > 60) { this.mines.splice(i, 1); continue; }
      if (now - mine.placedAt < 3) continue; // immunity
      for (const p of this.players.values()) {
        if (!p.alive || p.colorIdx === mine.ownerId) continue;
        const ddx = wrappedDistX(p.x, mine.x), ddy = p.y - mine.y;
        if (Math.sqrt(ddx*ddx + ddy*ddy) < 60) {
          p.hp -= 40; this.mines.splice(i, 1);
          if (p.hp <= 0) { p.alive = false; p.respawnTimer = 10; p.deaths = (p.deaths||0)+1; const atk = this._findPlayer(mine.ownerId); if (atk) { atk.kills = (atk.kills||0)+1; if (atk.kills >= this.scoreLimit) { this.endGame('kill', mine.ownerId); return; } } this.broadcast({ type:'mine_explode', x:mine.x, y:mine.y, targetColor:p.colorIdx, hp:0, killerColor:mine.ownerId }); }
          else { this.broadcast({ type:'mine_explode', x:mine.x, y:mine.y, targetColor:p.colorIdx, hp:p.hp }); }
          break;
        }
      }
    }

    // ── Lasers: update + hit detection ──
    for (let i = this.lasers.length - 1; i >= 0; i--) {
      const l = this.lasers[i]; l.life -= dt; if (l.life <= 0) { this.lasers.splice(i, 1); continue; }
      // Check laser vs players (line-segment distance)
      const lx2 = l.x + Math.cos(l.angle)*l.length, ly2 = l.y + Math.sin(l.angle)*l.length;
      for (const p of this.players.values()) {
        if (!p.alive || p.colorIdx === l.ownerId) continue;
        // Point to line segment distance
        const dx = lx2 - l.x, dy = ly2 - l.y;
        const t = Math.max(0, Math.min(1, ((p.x-l.x)*dx + (p.y-l.y)*dy) / (dx*dx + dy*dy)));
        const cx = l.x + t*dx, cy = l.y + t*dy;
        const ddx = wrappedDistX(p.x, cx), ddy = p.y - cy;
        if (Math.sqrt(ddx*ddx + ddy*ddy) < 25) {
          p.hp -= 50;
          if (p.hp <= 0) { p.alive = false; p.respawnTimer = 10; p.deaths = (p.deaths||0)+1; const atk = this._findPlayer(l.ownerId); if (atk) { atk.kills = (atk.kills||0)+1; if (atk.kills >= this.scoreLimit) { this.endGame('kill', l.ownerId); return; } } this.broadcast({ type:'player_died', colorIdx:p.colorIdx, respawnIn:10, killerColor:l.ownerId, weapon:'laser' }); }
          else { this.broadcast({ type:'player_hit', targetColor:p.colorIdx, attackerColor:l.ownerId, damage:50, hp:p.hp, weapon:'laser' }); }
        }
      }
    }

    // ── Broadcast snapshot ──
    this.broadcastSnapshot();
  }

  broadcastSnapshot() {
    const players = []; for (const p of this.players.values()) { players.push({ colorIdx:p.colorIdx, nick:p.nick, x:p.x, y:p.y, heading:p.heading, speed:p.speed, hp:p.hp, alive:p.alive, kills:p.kills, deaths:p.deaths||0, isStealth:p.isStealth||false }); }
    const missiles = this.missiles.filter(m=>m.alive).map(m=>({ x:m.x, y:m.y, heading:m.heading, ownerId:m.ownerId }));
    const skills = this.skills.map(s=>({ x:s.x, y:s.y, type:s.type }));
    const mines = this.mines.map(m=>({ x:m.x, y:m.y, placedAt:m.placedAt }));
    const lasers = this.lasers.map(l=>({ x:l.x, y:l.y, angle:l.angle, length:l.length, life:l.life, maxLife:l.maxLife }));
    const timeLeft = Math.max(0, this.timeLimit - (Date.now() - this.startTime));
    this.broadcast({ type:'world_snapshot', timestamp:Date.now(), players, missiles, skills, mines, lasers, timeLeft, scoreLimit:this.scoreLimit, gameMode:this.gameMode });
  }

  _findPlayer(colorIdx) { for (const p of this.players.values()) { if (p.colorIdx === colorIdx) return p; } return null; }

  endGame(reason, winnerColor) {
    this.gameOver = true; this.stopLoop();
    const winner = winnerColor !== undefined ? this._findPlayer(winnerColor) : null;
    const stats = []; for (const p of this.players.values()) stats.push({ colorIdx:p.colorIdx, nick:p.nick, kills:p.kills||0, deaths:p.deaths||0, hp:p.hp });
    this.broadcast({ type:'game_over', reason, winnerColor, winnerNick:winner?winner.nick:'', stats, timePlayed:Date.now()-this.startTime });
    // Cleanup after 30s
    setTimeout(() => { for (const [ws] of this.players) { try { ws.close(); } catch(e){} } }, 30000);
  }

  broadcast(msgObj) {
    const data = JSON.stringify(msgObj);
    for (const p of this.players.values()) { if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data); }
  }
}

// ═══════════════════════════════════════════
//  SERVER SETUP
// ═══════════════════════════════════════════
function getLocalIP() { const ifaces = os.networkInterfaces(); for (const name of Object.keys(ifaces)) { for (const iface of ifaces[name]) { if (iface.family==='IPv4'&&!iface.internal) return iface.address; } } return '127.0.0.1'; }
const PORT = 8080, IP = getLocalIP(), wss = new WebSocket.Server({ port: PORT });
const rooms = new Map();

console.log('═══════════════════════════════════════');
console.log('  深海幽灵联机服务器 (权威模式)');
console.log(`  地址: ws://${IP}:${PORT}`);
console.log('═══════════════════════════════════════');

function assignColor(room) { const used = new Set(); for (const p of room.players.values()) used.add(p.colorIdx); for (let i = 0; i < 6; i++) { if (!used.has(i)) return i; } return -1; }

wss.on('connection', (ws, req) => {
  console.log(`[+] ${req.socket.remoteAddress}`);
  let myRoom = null, myPlayer = null;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch(e) { return; }
    switch (msg.type) {
      case 'echo': ws.send(JSON.stringify({ type:'echo_reply', sent:msg.sent, serverTime:Date.now() })); break;
      case 'create_room': {
        if (myRoom) break; const nick = (msg.nick||'Captain').substring(0,12);
        const id = 'R'+Date.now().toString(36).toUpperCase(); myRoom = new Room(id); rooms.set(id, myRoom);
        const pos = randomOceanPos();
        myPlayer = { ws, nick, colorIdx:0, x:pos.x, y:pos.y, heading:0, speed:0, angularVel:0, hp:100, alive:true, kills:0, deaths:0, respawnTimer:0, isStealth:false, input:{w:false,a:false,s:false,d:false,fire:false}, lastInput:Date.now() };
        myRoom.players.set(ws, myPlayer); myRoom.startLoop();
        ws.send(JSON.stringify({ type:'room_created', roomId:id, colorIdx:0, nick }));
        console.log(`[Room] ${id} created by ${nick}`);
        break;
      }
      case 'join_room': {
        if (myRoom) break; const room = rooms.get(msg.roomId);
        if (!room) { ws.send(JSON.stringify({ type:'error', text:'房间不存在' })); break; }
        if (room.players.size >= 6) { ws.send(JSON.stringify({ type:'error', text:'房间已满' })); break; }
        const nick = (msg.nick||'Sailor').substring(0,12); const ci = assignColor(room);
        if (ci < 0) { ws.send(JSON.stringify({ type:'error', text:'无可用颜色' })); break; }
        const pos = randomOceanPos();
        myRoom = room; myPlayer = { ws, nick, colorIdx:ci, x:pos.x, y:pos.y, heading:0, speed:0, angularVel:0, hp:100, alive:true, kills:0, deaths:0, respawnTimer:0, isStealth:false, input:{w:false,a:false,s:false,d:false,fire:false}, lastInput:Date.now() };
        room.players.set(ws, myPlayer);
        ws.send(JSON.stringify({ type:'room_joined', roomId:room.id, colorIdx:ci, nick }));
        room.broadcast({ type:'player_joined', nick, colorIdx:ci });
        room.broadcastSnapshot();
        console.log(`[Room] ${room.id}: ${nick} joined (${room.players.size} players)`);
        break;
      }
      case 'input': {
        if (!myPlayer) break;
        myPlayer.input.w = !!msg.w; myPlayer.input.a = !!msg.a; myPlayer.input.s = !!msg.s; myPlayer.input.d = !!msg.d;
        myPlayer.input.fire = !!msg.fire;
        myPlayer.lastInput = Date.now();
        break;
      }
      case 'fire': {
        if (!myRoom || !myPlayer || !myPlayer.alive) break;
        const bx = myPlayer.x + Math.cos(myPlayer.heading)*32, by = myPlayer.y + Math.sin(myPlayer.heading)*32;
        myRoom.missiles.push(new SvrMissile(bx, by, myPlayer.heading, myPlayer.colorIdx));
        break;
      }
      case 'chat': {
        if (!myRoom) break;
        myRoom.broadcast({ type:'chat', nick:myPlayer.nick, color:myPlayer.colorIdx, text:(msg.text||'').substring(0,80) });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (myRoom && myPlayer) {
      myRoom.players.delete(ws);
      myRoom.broadcast({ type:'player_left', nick:myPlayer.nick, colorIdx:myPlayer.colorIdx });
      if (myRoom.players.size === 0) { myRoom.stopLoop(); rooms.delete(myRoom.id); console.log(`[Room] ${myRoom.id} deleted`); }
    }
  });
  ws.on('error', () => {});
});

// Idle cleanup
setInterval(() => { const now = Date.now(); for (const [id, room] of rooms) { for (const [ws, p] of room.players) { if (now - p.lastInput > 120000) { ws.close(); } } if (room.players.size === 0) { room.stopLoop(); rooms.delete(id); } } }, 60000);

console.log('[Server] Ready (authoritative mode).');
