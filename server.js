const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const path = require('path');

// Раздаем файл index.html при зашествии на сайт
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const WORLD = { width: 4000, height: 2400 };
let players = {};
let bullets = [];
let items = [];

// Процедурная генерация карты на сервере
let anomalies = [];
const anomalyTypes = [{type:'toxic'}, {type:'sludge'}, {type:'heal'}];
for (let i = 0; i < 18; i++) {
    anomalies.push({
        x: Math.random() * (WORLD.width - 400) + 200, y: Math.random() * (WORLD.height - 400) + 200, radius: Math.random() * 200 + 130,
        type: anomalyTypes[Math.floor(Math.random() * anomalyTypes.length)].type
    });
}

let buildings = [];
for (let i = 0; i < 48; i++) {
    buildings.push({
        x: Math.random() * (WORLD.width - 300) + 150, y: Math.random() * (WORLD.height - 300) + 150,
        w: Math.random() * 160 + 90, h: Math.random() * 160 + 90
    });
}

function getRandomSafePosition() {
    let attempts = 0;
    while (attempts < 1000) {
        let rx = Math.random() * (WORLD.width - 100) + 50;
        let ry = Math.random() * (WORLD.height - 100) + 50;
        let bad = buildings.some(b => rx+20 > b.x && rx-20 < b.x+b.w && ry+20 > b.y && ry-20 < b.y+b.h) ||
                  anomalies.some(a => Math.hypot(rx - a.x, ry - a.y) < a.radius + 20);
        if (!bad) return { x: rx, y: ry };
        attempts++;
    }
    return { x: 2000, y: 1200 };
}

io.on('connection', (socket) => {
    const isFirst = Object.keys(players).length === 0;
    const spawn = getRandomSafePosition();
    
    players[socket.id] = {
        id: socket.id, x: spawn.x, y: spawn.y, radius: 20,
        color: isFirst ? '#ff0055' : '#00ffcc', bulletColor: isFirst ? '#ff66aa' : '#66ffea',
        aimX: isFirst ? 1 : -1, aimY: 0, hp: 100, skillActive: false, skillCD: 0
    };

    socket.emit('init', { id: socket.id, world: WORLD, anomalies, buildings, players });
    socket.broadcast.emit('playerJoined', players[socket.id]);

    socket.on('playerUpdate', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x; players[socket.id].y = data.y;
            players[socket.id].aimX = data.aimX; players[socket.id].aimY = data.aimY;
            players[socket.id].skillActive = data.skillActive; players[socket.id].skillCD = data.skillCD;
            players[socket.id].hp = data.hp;
        }
    });

    socket.on('shoot', (bulletData) => {
        bullets.push({ ...bulletData, id: Math.random().toString(36).substr(2, 9) });
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerLeft', socket.id);
    });
});

// Серверный игровой цикл (60 кадров в секунду)
setInterval(() => {
    bullets.forEach((b, index) => {
        let sandevistanActive = Object.values(players).some(p => p.color === '#ff0055' && p.skillActive);
        let speedMod = (sandevistanActive && b.ownerColor !== '#ff0055') ? 0.25 : 1;
        b.x += b.vx * speedMod; b.y += b.vy * speedMod;

        let hitWall = buildings.some(w => b.x > w.x && b.x < w.x + w.w && b.y > w.y && b.y < w.y + w.h);
        if (hitWall || b.x < 0 || b.x > WORLD.width || b.y < 0 || b.y > WORLD.height) {
            io.emit('bulletExplode', {x: b.x, y: b.y, color: '#2d2d66'});
            bullets.splice(index, 1); return;
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

    if (items.length < 25 && Math.random() < 0.015) {
        let ix = Math.random() * (WORLD.width - 60) + 30;
        let iy = Math.random() * (WORLD.height - 60) + 30;
        if (!buildings.some(b => ix > b.x && ix < b.x + b.w && iy > b.y && iy < b.y + b.h)) {
            const types = [{t:'heal', c:'#00ff55', l:'HP'}, {t:'damage', c:'#ffaa00', l:'DMG'}, {t:'speed', c:'#d200ff', l:'SPD'}];
            let s = types[Math.floor(Math.random() * types.length)];
            items.push({ x: ix, y: iy, type: s.t, color: s.c, label: s.l });
        }
    }
    io.emit('stateUpdate', { players, bullets, items });
}, 1000 / 60);

// Порт берется из окружения хостинга автоматически
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`Кибер-сервер запущен на порту ${PORT}`); });
