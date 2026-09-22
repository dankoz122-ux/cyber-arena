const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { 
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling']
});
const path = require('path');

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

const WORLD = { width: 4000, height: 2400 };
let players = {};
let bullets = [];
let items = [];
let creeps = [];

let anomalies = [];
const anomalyTypes = [{type:'toxic'}, {type:'sludge'}, {type:'heal'}];
for (let i = 0; i < 16; i++) {
    anomalies.push({
        x: Math.random() * (WORLD.width - 600) + 300, y: Math.random() * (WORLD.height - 600) + 300, radius: Math.random() * 180 + 130,
        type: anomalyTypes[Math.floor(Math.random() * anomalyTypes.length)].type
    });
}

let buildings = [];
for (let i = 0; i < 42; i++) {
    buildings.push({
        x: Math.random() * (WORLD.width - 300) + 150, y: Math.random() * (WORLD.height - 300) + 150,
        w: Math.random() * 160 + 90, h: Math.random() * 160 + 90
    });
}

function getRandomSafePosition(radius = 20) {
    let attempts = 0;
    while (attempts < 1000) {
        let rx = Math.random() * (WORLD.width - 200) + 100;
        let ry = Math.random() * (WORLD.height - 200) + 100;
        let bad = buildings.some(b => rx+radius > b.x && rx-radius < b.x+b.w && ry+radius > b.y && ry-radius < b.y+b.h) ||
                  anomalies.some(a => Math.hypot(rx - a.x, ry - a.y) < a.radius + radius);
        if (!bad) return { x: rx, y: ry };
        attempts++;
    }
    return { x: 2000, y: 1200 };
}

// Спавн сбалансированных крипов
for(let i = 0; i < 18; i++) {
    let pos = getRandomSafePosition(14);
    creeps.push({ 
        id: 'c_' + Math.random().toString(36).substr(2, 5), 
        x: pos.x, y: pos.y, radius: 14, hp: 35, maxHp: 30, lastShot: 0,
        vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2,
        state: 'patrol', targetId: null
    });
}

io.on('connection', (socket) => {
    const isFirst = Object.keys(players).length === 0;
    const spawn = getRandomSafePosition(20);
    
    players[socket.id] = {
        id: socket.id, x: spawn.x, y: spawn.y, radius: 20,
        color: isFirst ? '#ff0055' : '#00ffcc', bulletColor: isFirst ? '#ff66aa' : '#66ffea',
        aimX: isFirst ? 1 : -1, aimY: 0, hp: 100, maxHp: 100, speed: 5.5, damage: 12, lvl: 1, skillActive: false, skillCD: 0
    };

    socket.emit('init', { id: socket.id, world: WORLD, anomalies, buildings, players, creeps });
    socket.broadcast.emit('playerJoined', players[socket.id]);

    socket.on('playerUpdate', (data) => {
        if (players[socket.id]) {
            Object.assign(players[socket.id], {
                x: data.x, y: data.y, aimX: data.aimX, aimY: data.aimY,
                skillActive: data.skillActive, skillCD: data.skillCD,
                hp: data.hp, speed: data.speed, damage: data.damage, lvl: data.lvl
            });
        }
    });

    socket.on('shoot', (bData) => { bullets.push({ ...bData, id: Math.random().toString(36).substr(2, 9) }); });
    socket.on('removeItem', (itemId) => { items = items.filter(i => i.id !== itemId); io.emit('itemRemoved', itemId); });
    socket.on('disconnect', () => { delete players[socket.id]; io.emit('playerLeft', socket.id); });
});

setInterval(() => {
    let activePlayers = Object.values(players);

    // Расчет ИИ Крипов с учетом зон видимости и потери цели
    creeps.forEach(c => {
        let closestPlayer = null, minDist = Infinity;
        
        activePlayers.forEach(p => {
            let d = Math.hypot(p.x - c.x, p.y - c.y);
            if (d < minDist) { minDist = d; closestPlayer = p; }
        });

        // Матрица состояний ИИ дрона
        if (c.state === 'patrol') {
            // Обычное блуждание
            c.x += c.vx; c.y += c.vy;
            if (Math.random() < 0.02) { c.vx = (Math.random() - 0.5) * 3; c.vy = (Math.random() - 0.5) * 3; }

            // Проверка входа в Agro-радиус (380px)
            if (closestPlayer && minDist < 380) {
                c.state = 'chase';
                c.targetId = closestPlayer.id;
            }
        } else if (c.state === 'chase') {
            // Проверяем, существует ли цель до сих пор
            let currentTarget = players[c.targetId];
            if (!currentTarget) { c.state = 'patrol'; return; }

            let distToTarget = Math.hypot(currentTarget.x - c.x, currentTarget.y - c.y);

            // Проверка разрыва дистанции и потери агро (480px)
            if (distToTarget > 480) {
                c.state = 'patrol';
                c.targetId = null;
                c.vx = (Math.random() - 0.5) * 2; c.vy = (Math.random() - 0.5) * 2;
                return;
            }

            // Преследование цели
            let dx = currentTarget.x - c.x, dy = currentTarget.y - c.y;
            c.x += (dx / distToTarget) * 2.4; c.y += (dy / distToTarget) * 2.4;

            // Ведение огня
            let now = Date.now();
            if (now - c.lastShot > 1400 && distToTarget < 350) {
                bullets.push({ 
                    x: c.x, y: c.y, vx: (dx / distToTarget) * 8.5, vy: (dy / distToTarget) * 8.5, 
                    damage: 6, ownerColor: '#888888', color: '#ffffff', id: Math.random().toString(36).substr(2, 9) 
                });
                c.lastShot = now;
            }
        }

        // Отталкивание от неоновых стен зданий
        if (c.x < c.radius || c.x > WORLD.width - c.radius) c.vx *= -1;
        if (c.y < c.radius || c.y > WORLD.height - c.radius) c.vy *= -1;
        buildings.forEach(b => {
            if (c.x + c.radius > b.x && c.x - c.radius < b.x + b.w && c.y + c.radius > b.y && c.y - c.radius < b.y + b.h) {
                c.vx *= -1; c.vy *= -1; c.x += c.vx * 2.5; c.y += c.vy * 2.5;
                if(c.state === 'chase') { c.state = 'patrol'; c.targetId = null; } // Теряет след при столкновении со стеной
            }
        });
    });

    // Обработка снарядов лазеров
    bullets.forEach((b, index) => {
        let sandevistanActive = Object.values(players).some(p => p.color === '#ff0055' && p.skillActive);
        let speedMod = (sandevistanActive && b.ownerColor !== '#ff0055') ? 0.25 : 1;
        b.x += b.vx * speedMod; b.y += b.vy * speedMod;

        let hitWall = buildings.some(w => b.x > w.x && b.x < w.x + w.w && b.y > w.y && b.y < w.y + w.h);
        if (hitWall || b.x < 0 || b.x > WORLD.width || b.y < 0 || b.y > WORLD.height) {
            bullets.splice(index, 1); return;
        }

        for (let i = 0; i < creeps.length; i++) {
            let c = creeps[i];
            if (b.ownerColor !== '#888888' && Math.hypot(b.x - c.x, b.y - c.y) < c.radius) {
                c.hp -= b.damage;
                c.state = 'chase'; // Контратака: если выстрелить в крипа, он сразу сагрится на вас
                c.targetId = b.ownerId;
                
                if (c.hp <= 0) {
                    io.emit('creepKilled', { creepId: c.id, killerSocketId: b.ownerId, x: c.x, y: c.y });
                    creeps.splice(i, 1);
                    setTimeout(() => {
                        let pos = getRandomSafePosition(14);
                        creeps.push({ id: 'c_' + Math.random().toString(36).substr(2, 5), x: pos.x, y: pos.y, radius: 14, hp: 35, maxHp: 30, lastShot: 0, vx: (Math.random()-0.5)*2, vy: (Math.random()-0.5)*2, state: 'patrol', targetId: null });
                    }, 6000);
                }
                bullets.splice(index, 1); return;
            }
        }

        for (let id in players) {
            let p = players[id];
            if (p.color !== b.ownerColor && Math.hypot(b.x - p.x, b.y - p.y) < p.radius) {
                io.emit('bulletExplode', {x: b.x, y: b.y, color: p.color});
                io.to(id).emit('damageTaken', b.damage);
                bullets.splice(index, 1); break;
            }
        }
    });

    if (items.length < 25 && Math.random() < 0.02) {
        let pos = getRandomSafePosition(13);
        const types = [{t:'heal', c:'#00ff55', l:'HP'}, {t:'damage', c:'#ffaa00', l:'DMG'}, {t:'speed', c:'#d200ff', l:'SPD'}];
        let s = types[Math.floor(Math.random() * types.length)];
        items.push({ x: pos.x, y: pos.y, type: s.t, color: s.c, label: s.l, id: Math.random().toString(36).substr(2, 5) });
    }
    io.emit('stateUpdate', { players, bullets, items, creeps });
}, 1000 / 60);

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => { console.log(`Server running on port ${PORT}`); });
