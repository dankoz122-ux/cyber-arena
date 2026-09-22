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

// Спавн начальных крипов
for(let i = 0; i < 18; i++) {
    let pos = getRandomSafePosition(14);
    creeps.push({ 
        id: 'c_' + Math.random().toString(36).substr(2, 5), 
        x: pos.x, y: pos.y, radius: 14, hp: 35, maxHp: 30, lastShot: 0,
        vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2, state: 'patrol', targetId: null
    });
}

// Функция обработки взрыва (AoE урон) на сервере
function triggerAoEExplosion(ex, ey, radius, damage, ownerId) {
    io.emit('aoeExplosion', { x: ex, y: ey, r: radius, damage: damage, ownerId: ownerId });

    // Урон по крипам
    for (let i = creeps.length - 1; i >= 0; i--) {
        let c = creeps[i];
        if (Math.hypot(c.x - ex, c.y - ey) < radius + c.radius) {
            c.hp -= damage;
            c.state = 'chase';
            c.targetId = ownerId;

            if (c.hp <= 0) {
                io.emit('creepKilled', { creepId: c.id, killerSocketId: ownerId, x: c.x, y: c.y });
                // Сбалансированная награда за убийство крипа: +8 кредитов вместо +15
                if (players[ownerId]) players[ownerId].credits += 8; 
                creeps.splice(i, 1);
                
                setTimeout(() => {
                    let pos = getRandomSafePosition(14);
                    creeps.push({ id: 'c_' + Math.random().toString(36).substr(2, 5), x: pos.x, y: pos.y, radius: 14, hp: 35, maxHp: 30, lastShot: 0, vx: (Math.random()-0.5)*2, vy: (Math.random()-0.5)*2, state: 'patrol', targetId: null });
                }, 6000);
            }
        }
    }

    // Урон по игрокам
    for (let id in players) {
        let p = players[id];
        // Запрещаем наносить урон самому себе взрывом, если нужно — удалите условие (id !== ownerId)
        if (id !== ownerId && Math.hypot(p.x - ex, p.y - ey) < radius + p.radius) {
            p.hp = Math.max(0, p.hp - damage);
            io.to(id).emit('damageTaken', damage);
        }
    }
}

io.on('connection', (socket) => {
    const isFirst = Object.keys(players).length === 0;
    const spawn = getRandomSafePosition(20);
    
    players[socket.id] = {
        id: socket.id, x: spawn.x, y: spawn.y, radius: 20,
        color: isFirst ? '#ff0055' : '#00ffcc', bulletColor: isFirst ? '#ff66aa' : '#66ffea',
        aimX: isFirst ? 1 : -1, aimY: 0, hp: 100, maxHp: 100, speed: 5.5, damage: 12, lvl: 1, credits: 0,
        skillActive: false, skillCD: 0, lastDashTime: 0 // Фиксация времени последнего рывка
    };

    socket.emit('init', { id: socket.id, world: WORLD, anomalies, buildings, players, creeps });
    socket.broadcast.emit('playerJoined', players[socket.id]);

    socket.on('playerUpdate', (data) => {
        let p = players[socket.id];
        if (p) {
            let boundedX = Math.max(20, Math.min(WORLD.width - 20, data.x));
            let boundedY = Math.max(20, Math.min(WORLD.height - 20, data.y));
            
            // Валидация рывка (SPACE) на стороне сервера (откат 3000 мс)
            let now = Date.now();
            if (data.skillActive && !p.skillActive && now - p.lastDashTime > 3000) {
                p.skillActive = true;
                p.lastDashTime = now;
                p.skillCD = 3000;
                // Сбрасываем флаг активности через короткое время действия рывка (например, 150мс)
                setTimeout(() => { if(players[socket.id]) players[socket.id].skillActive = false; }, 150);
            }

            // Обновляем серверный кулдаун для передачи клиентам
            let timePassed = now - p.lastDashTime;
            p.skillCD = Math.max(0, 3000 - timePassed);

            Object.assign(p, {
                x: boundedX, y: boundedY, aimX: data.aimX, aimY: data.aimY,
                hp: data.hp, speed: data.speed, damage: data.damage, lvl: data.lvl
                // Исключили credits из клиентского апдейта, чтобы избежать читерства и перезаписи баланса
            });
        }
    });

    socket.on('shoot', (bData) => { 
        bullets.push({ ...bData, id: Math.random().toString(36).substr(2, 9) }); 
    });

    // Клиент больше не решает, когда удалять чипы. Сервер делает это сам через проверку коллизий.
    socket.on('removeItem', (itemId) => { /* Устарело */ });
    
    socket.on('disconnect', () => { delete players[socket.id]; io.emit('playerLeft', socket.id); });
});

// Основной игровой цикл (60 FPS)
setInterval(() => {
    let activePlayers = Object.values(players);
    let now = Date.now();

    // 1. Движение и логика крипов
    creeps.forEach(c => {
        if (activePlayers.length > 0) {
            let closest = null, minDist = Infinity;
            activePlayers.forEach(p => {
                let d = Math.hypot(p.x - c.x, p.y - c.y);
                if (d < minDist) { minDist = d; closest = p; }
            });

            if (c.state === 'patrol') {
                c.x += c.vx; c.y += c.vy;
                if (Math.random() < 0.02) { c.vx = (Math.random() - 0.5) * 3; c.vy = (Math.random() - 0.5) * 3; }
                if (closest && minDist < 380) { c.state = 'chase'; c.targetId = closest.id; }
            } else if (c.state === 'chase') {
                let curr = players[c.targetId];
                if (!curr || Math.hypot(curr.x - c.x, curr.y - c.y) > 480) {
                    c.state = 'patrol'; c.targetId = null; c.vx = (Math.random()-0.5)*2; c.vy = (Math.random()-0.5)*2;
                } else {
                    let dx = curr.x - c.x, dy = curr.y - c.y, dist = Math.hypot(dx, dy);
                    c.x += (dx / dist) * 2.4; c.y += (dy / dist) * 2.4;
                    if (now - c.lastShot > 1400 && dist < 350) {
                        bullets.push({ x: c.x, y: c.y, vx: (dx / dist) * 8.5, vy: (dy / dist) * 8.5, damage: 6, ownerColor: '#888888', color: '#ffffff', id: Math.random().toString(36).substr(2, 9) });
                        c.lastShot = now;
                    }
                }
            }
        }
        c.x = Math.max(c.radius, Math.min(WORLD.width - c.radius, c.x));
        c.y = Math.max(c.radius, Math.min(WORLD.height - c.radius, c.y));
        buildings.forEach(b => {
            if (c.x + c.radius > b.x && c.x - c.radius < b.x + b.w && c.y + c.radius > b.y && c.y - c.radius < b.y + b.h) {
                c.vx *= -1; c.vy *= -1; c.x += c.vx * 2.5; c.y += c.vy * 2.5;
                if(c.state === 'chase') { c.state = 'patrol'; c.targetId = null; }
            }
        });
    });

    // 2. Движение и коллизии снарядов
    for (let index = bullets.length - 1; index >= 0; index--) {
        let b = bullets[index];
        let sandevistanActive = Object.values(players).some(p => p.color === '#ff0055' && p.skillActive);
        let speedMod = (sandevistanActive && b.ownerColor !== '#ff0055') ? 0.25 : 1;
        
        b.x += b.vx * speedMod; 
        b.y += b.vy * speedMod;

        let hitWall = buildings.some(w => b.x > w.x && b.x < w.x + w.w && b.y > w.y && b.y < w.y + w.h);
        if (hitWall || b.x < 0 || b.x > WORLD.width || b.y < 0 || b.y > WORLD.height) {
            if(b.isExplosive) triggerAoEExplosion(b.x, b.y, 95, b.damage, b.ownerId);
            bullets.splice(index, 1); continue;
        }

        // Попадание во вражеских крипов
        let hitCreep = false;
        for (let i = 0; i < creeps.length; i++) {
            let c = creeps[i];
            if (b.ownerColor !== '#888888' && Math.hypot(b.x - c.x, b.y - c.y) < c.radius) {
                if(b.isExplosive) {
                    triggerAoEExplosion(b.x, b.y, 95, b.damage, b.ownerId);
                } else {
                    c.hp -= b.damage;
                    if(players[b.ownerId] && b.hasLeech) players[b.ownerId].hp = Math.min(100, players[b.ownerId].hp + (b.damage * 0.15));
                    c.state = 'chase'; c.targetId = b.ownerId;
                    
                    if (c.hp <= 0) {
                        io.emit('creepKilled', { creepId: c.id, killerSocketId: b.ownerId, x: c.x, y: c.y });
                        if (players[b.ownerId]) players[b.ownerId].credits += 8; // Сбалансировано (+8 вместо +15)
                        creeps.splice(i, 1);
                        setTimeout(() => {
                            let pos = getRandomSafePosition(14);
                            creeps.push({ id: 'c_' + Math.random().toString(36).substr(2, 5), x: pos.x, y: pos.y, radius: 14, hp: 35, maxHp: 30, lastShot: 0, vx: (Math.random()-0.5)*2, vy: (Math.random()-0.5)*2, state: 'patrol', targetId: null });
                        }, 6000);
                    }
                }
                bullets.splice(index, 1); hitCreep = true; break;
            }
        }
        if (hitCreep) continue;

        // Попадание в игроков
        for (let id in players) {
            let p = players[id];
            if (p.color !== b.ownerColor && Math.hypot(b.x - p.x, b.y - p.y) < p.radius) {
                if(b.isExplosive) {
                    triggerAoEExplosion(b.x, b.y, 95, b.damage, b.ownerId);
                } else {
                    io.emit('bulletExplode', {x: b.x, y: b.y, color: p.color});
                    p.hp = Math.max(0, p.hp - b.damage);
                    io.to(id).emit('damageTaken', b.damage);
                    if(players[b.ownerId] && b.hasLeech) players[b.ownerId].hp = Math.min(100, players[b.ownerId].hp + (b.damage * 0.15));
                    // Баланс: убрали начисление кредитов просто за попадания, чтобы не копить мгновенно!
                }
                bullets.splice(index, 1); break;
            }
        }
    }

    // 3. Серверный сбор чипов (РЕШАЕТ ПРОБЛЕМУ МНОГОКРАТНОГО ТРИГГЕРА)
    for (let i = items.length - 1; i >= 0; i--) {
        let item = items[i];
        for (let id in players) {
            let p = players[id];
            if (Math.hypot(p.x - item.x, p.y - item.y) < p.radius + 13) {
                // Изменяем характеристики на сервере
                if (item.type === 'heal') p.hp = Math.min(p.maxHp, p.hp + 20);
                if (item.type === 'damage') p.damage += 2;
                if (item.type === 'speed') p.speed += 0.3;

                // Баланс наград: теперь чип дает умеренное количество опыта и валюты
                p.credits += 3; // Было +5 в описании, снизили до 3 для усложнения
                
                // Прокачка уровня (каждые 4 чипа — новый уровень)
                if (Math.random() < 0.25) p.lvl += 1; 

                io.emit('itemRemoved', item.id);
                items.splice(i, 1);
                break; // Чип может поднять только один игрок
            }
        }
    }

    // Спавн новых чипов
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
