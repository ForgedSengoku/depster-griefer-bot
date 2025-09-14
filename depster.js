/*
  Ultimate Minecraft Bot Server - Gemini Overhaul
  - Web dashboard control via Socket.io with enhanced UI feedback.
  - Microsoft authentication flow is now visually tracked on the dashboard.
  - New `trap` command: Bots will follow a player and build a dirt prison around them, as seen in the video.
  - New collaborative `clearmap` command: Main thread assigns each bot a unique direction, making them spread out and clear the map efficiently.
  - Griefing Logic Reworked: Removed stopping/sneaking to match the older, more aggressive style. Bot follows while breaking blocks.
  - Configuration Updated: CPS set to 13 as requested.
  - Persistent Usernames: Authenticated Microsoft account usernames are now stored in `accountsList.txt` for subsequent sessions.
  - Status Updates: Bots report their current action (e.g., Trapping, Griefing, Idle) back to the dashboard.
  - Full Logging: All server-side console logs and dependency outputs are now forwarded to the web dashboard.
*/

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const Vec3 = require('vec3').Vec3;

// ----- CONFIG (main-thread values) -----
const accountsFile = path.resolve(__dirname, 'accountsList.txt');

// server and plugin-level configs (shared to workers)
const sharedConfig = {
  server: { host: 'crossplay.my.pebble.host', port: 25602, version: '1.21.1' },
  protectedNames: ['light_gray_concrete', 'smooth_quartz_slab', 'water', 'barrier', 'bedrock'],
  // breaking params
  cps: 13, // Set to 13 CPS as requested
  clickDelay: 1000 / 13,
  scanRadius: 8,
  maxDig: 8,
  // trap params
  trapBlock: 'dirt',
};

if (isMainThread) {
  try {
    if (!fs.existsSync(accountsFile)) {
      fs.writeFileSync(accountsFile, '\n', 'utf8');
      console.log('[main] Created empty accountsList.txt.');
    }
  } catch (e) {
    console.error('[main] Failed to create/read accounts file:', e);
  }

  const express = require('express');
  const http = require('http');
  const { Server } = require('socket.io');

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  // --- Global Log Forwarder ---
  // This captures all stdout and stderr output from the main process and all its
  // worker threads (as they share the process streams), ensuring everything seen
  // in the terminal also appears on the dashboard, including dependency logs.
  const forwardStreamOutputToDashboard = (stream, type) => {
      const originalWrite = stream.write;
      stream.write = (chunk, encoding, callback) => {
          const message = chunk.toString();
          // Don't forward empty messages
          if (message.trim()) {
              io.emit('log', { bot: 'System', text: message, type });
          }
          // Also, write to the actual console to keep terminal logging intact
          return originalWrite.apply(stream, [chunk, encoding, callback]);
      };
  };

  forwardStreamOutputToDashboard(process.stdout, 'info');
  forwardStreamOutputToDashboard(process.stderr, 'error');
  // --- End Global Log Forwarder ---

  const activeWorkers = new Map(); // finalUsername -> Worker

  app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'dashboard_griefer.html')));

  function readAccountsFile() {
    try {
      const data = fs.readFileSync(accountsFile, 'utf8');
      return data.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } catch (e) {
      console.error('[main] Error reading accounts file:', e);
      return [];
    }
  }

  function spawnWorkerFor(username, isAuthWorker = false) {
    if (activeWorkers.has(username)) {
      console.log(`[main] Worker for ${username} already running.`);
      return;
    }

    const worker = new Worker(__filename, { 
      workerData: { username, sharedConfig, isAuthWorker } 
    });
    
    activeWorkers.set(username, worker);
    console.log(`[main] Spawned worker for: ${username} (isAuth: ${isAuthWorker})`);

    worker.on('message', msg => {
      if (!msg || !msg.type) return;
      const botName = msg.bot || username;

      // These structured messages from workers are sent directly to avoid being labeled "System"
      switch (msg.type) {
        case 'auth-link':
          io.emit('auth-link', { ...msg, username: botName });
          io.emit('log', { bot: botName, text: `Auth required. Code: ${msg.user_code}`, type: 'info' });
          break;

        case 'authenticated':
          const finalUsername = msg.nickname;
          if (username !== finalUsername && activeWorkers.has(username)) {
              const workerRef = activeWorkers.get(username);
              activeWorkers.delete(username);
              activeWorkers.set(finalUsername, workerRef);
          }
          io.emit('bot-authenticated', { tempUsername: username, finalUsername: finalUsername });
          io.emit('log', { bot: finalUsername, text: `Authenticated successfully.`, type: 'info' });
          break;
        
        case 'status-update':
            io.emit('bot-status-update', { username: botName, status: msg.status });
            break;

        case 'log':
          io.emit('log', { bot: botName, text: msg.text, type: 'info' });
          break;

        case 'error':
          io.emit('log', { bot: botName, text: `ERROR: ${msg.error}`, type: 'error' });
          break;
      }
    });

    worker.on('exit', code => {
      let exitedBotKey = null;
      for (const [key, w] of activeWorkers.entries()) {
        if (w === worker) {
          exitedBotKey = key;
          break;
        }
      }
      
      if (exitedBotKey) {
        activeWorkers.delete(exitedBotKey);
        io.emit('bot-offline', { username: exitedBotKey });
        console.log(`[main] Worker for ${exitedBotKey} exited with code ${code}.`);
        if (code !== 0 && !isAuthWorker) {
          setTimeout(() => {
            console.log(`[main] Respawning worker for ${exitedBotKey}...`);
            spawnWorkerFor(exitedBotKey, false);
          }, 5000);
        }
      }
    });

    worker.on('error', err => {
      console.error(`[main] Worker error for ${username}:`, err);
    });
  }

  io.on('connection', (socket) => {
    console.log('[Server] Web client connected');
    socket.emit('initial-accounts', Array.from(activeWorkers.keys()));

    socket.on('spawn-auth-bot', () => {
        const tempUsername = `AuthBot-${Math.floor(Math.random() * 10000)}`;
        spawnWorkerFor(tempUsername, true);
        io.emit('bot-online', { username: tempUsername, status: 'Authenticating...' });
    });

    socket.on('send-command', (data) => {
      if (!data || !data.command) return;
      
      console.log(`[main] Received command '${data.command}' from dashboard.`);
      if (data.command === 'clearmap') {
          const workers = Array.from(activeWorkers.values());
          workers.forEach((worker, index) => {
              const angle = (index / workers.length) * 2 * Math.PI;
              worker.postMessage({ type: 'command', command: 'clearmap', angle });
          });
          return;
      }
      
      for (const worker of activeWorkers.values()) {
        worker.postMessage({ type: 'command', ...data });
      }
    });
    
    socket.on('send-chat', (message) => {
      console.log(`[main] Broadcasting chat from dashboard: ${message}`);
      for (const worker of activeWorkers.values()) {
        worker.postMessage({ type: 'command', command: 'chat', message });
      }
    });

    socket.on('disconnect-all', () => {
      console.log(`[main] Disconnecting all bots via dashboard command.`);
      activeWorkers.forEach(w => w.terminate());
    });
  });

  const PORT = 3000;
  server.listen(PORT, () => console.log(`[main] Dashboard ready at http://localhost:${PORT}`));

  readAccountsFile().forEach(u => spawnWorkerFor(u, false));
  return;
}


// ------------------ WORKER THREAD ------------------
(async () => {
  const initialUsername = workerData.username;
  const cfg = workerData.sharedConfig;
  const isAuthWorker = workerData.isAuthWorker;

  const mineflayer = require('mineflayer');
  const { pathfinder, Movements } = require('mineflayer-pathfinder');
  const { GoalFollow, GoalBlock, GoalXZ } = require('mineflayer-pathfinder').goals;
  const mcData = require('minecraft-data')(cfg.server.version);

  const protectedIds = new Set(cfg.protectedNames.map(n => mcData.blocksByName[n]?.id).filter(Boolean));

  let bot = null;

  function send(msg) {
    const botName = (bot && bot.username) ? bot.username : initialUsername;
    parentPort.postMessage({ ...msg, bot: botName });
  }
  function log(text) { send({ type: 'log', text }); }
  function err(e) { send({ type: 'error', error: (e?.stack) ? e.stack : String(e) }); }
  function updateStatus(status) { send({ type: 'status-update', status }); }

  const trapOffsets = [];
  // Floor (8 blocks around player feet)
  for (let x = -1; x <= 1; x++) {
      for (let z = -1; z <= 1; z++) {
          if (x === 0 && z === 0) continue;
          trapOffsets.push(new Vec3(x, -1, z));
      }
  }
  // Walls (2 layers high)
  for (let y = 0; y <= 1; y++) {
      trapOffsets.push(new Vec3(-1, y, -1)); trapOffsets.push(new Vec3(-1, y, 1));
      trapOffsets.push(new Vec3(1, y, -1)); trapOffsets.push(new Vec3(1, y, 1));
      trapOffsets.push(new Vec3(0, y, -1)); trapOffsets.push(new Vec3(0, y, 1));
      trapOffsets.push(new Vec3(-1, y, 0)); trapOffsets.push(new Vec3(1, y, 0));
  }
  // Roof (9 blocks)
  for (let x = -1; x <= 1; x++) {
      for (let z = -1; z <= 1; z++) {
          trapOffsets.push(new Vec3(x, 2, z));
      }
  }

  parentPort.on('message', (msg) => {
    if (!bot || !bot.entity || !msg || msg.type !== 'command') return;

    const resetState = () => {
      bot.state.target = null;
      bot.state.mode = null;
      bot.state.isTrapping = false;
      bot.pathfinder.stop();
      updateStatus('Idle');
    };

    switch (msg.command) {
      case 'follow':
      case 'grief':
      case 'trap':
        const targetName = msg.target;
        if (!targetName) return log('Target player name is required.');
        const targetPlayer = bot.players[targetName];
        if (!targetPlayer) return log(`Can't see target player ${targetName}.`);
        
        resetState();
        bot.state.target = targetName;
        bot.state.mode = msg.command;
        log(`Executing '${msg.command}' on ${targetName}.`);
        updateStatus(`${msg.command.charAt(0).toUpperCase() + msg.command.slice(1)}ing ${targetName}`);
        if (msg.command === 'trap') getBlockInHand(cfg.trapBlock);
        break;
      
      case 'clearmap':
        resetState();
        bot.state.mode = 'clearmap';
        bot.state.clearMapAngle = msg.angle;
        log(`Initializing clearmap protocol at angle ${msg.angle.toFixed(2)}.`);
        updateStatus('Clearing Map');
        break;
        
      case 'stop':
        log('Stopping current action.');
        resetState();
        break;

      case 'chat':
        bot.chat(msg.message);
        break;
    }
  });

  function createBot() {
    bot = mineflayer.createBot({
      username: isAuthWorker ? `Player${Math.floor(Math.random() * 1000)}` : initialUsername,
      auth: 'microsoft',
      host: cfg.server.host,
      port: cfg.server.port,
      version: cfg.server.version
    });

    bot.loadPlugin(pathfinder);
    bot.state = { target: null, mode: null, lastDig: 0, clearMapAngle: 0, isTrapping: false };

    bot.once('spawn', () => {
      if (isAuthWorker) {
        fs.appendFileSync(accountsFile, bot.username + '\n', 'utf8');
        send({ type: 'authenticated', nickname: bot.username });
      }

      const movements = new Movements(bot, mcData);
      movements.canDig = true;
      movements.blocksToDig = new Set(Object.values(mcData.blocks).map(b => b.id));
      bot.pathfinder.setMovements(movements);
      log('Bot online.');
      updateStatus('Idle');
    });

    bot.on('microsoft-auth-required', (codeData) => {
      send({ type: 'auth-link', link: codeData.verification_uri, user_code: codeData.user_code });
    });

    bot.on('physicsTick', async () => {
      try {
        if (!bot.state.mode) return;
        
        const targetName = bot.state.target;
        const player = targetName ? bot.players[targetName] : null;

        switch (bot.state.mode) {
          case 'follow':
            if (!player?.entity) { bot.state.mode = null; updateStatus('Idle'); return; }
            bot.pathfinder.setGoal(new GoalFollow(player.entity, 2), true);
            break;

          case 'grief':
            if (!player?.entity) { bot.state.mode = null; updateStatus('Idle'); return; }
            bot.pathfinder.setGoal(new GoalFollow(player.entity, cfg.maxDig - 1), true);
            await griefLogic(player.entity.position);
            break;

          case 'trap':
            if (!player?.entity) { bot.state.mode = null; updateStatus('Idle'); return; }
            await trapLogic(player.entity);
            break;
          
          case 'clearmap':
            if (!bot.pathfinder.isMoving()) {
              const angle = bot.state.clearMapAngle;
              const newX = bot.entity.position.x + 10000 * Math.cos(angle);
              const newZ = bot.entity.position.z + 10000 * Math.sin(angle);
              bot.pathfinder.setGoal(new GoalXZ(newX, newZ));
              log(`Set new distant goal in my assigned direction.`);
            }
            break;
        }
      } catch (e) { err(e); }
    });

    async function griefLogic(targetPos) {
      const blocks = [];
      for (let dx = -cfg.scanRadius; dx <= cfg.scanRadius; dx++) {
      for (let dy = -cfg.scanRadius; dy <= cfg.scanRadius; dy++) {
      for (let dz = -cfg.scanRadius; dz <= cfg.scanRadius; dz++) {
        const bpos = targetPos.offset(dx, dy, dz);
        if (bot.entity.position.distanceTo(bpos) > cfg.maxDig) continue;
        const b = bot.blockAt(bpos);
        if (!b || b.name === 'air' || protectedIds.has(b.type)) continue;
        blocks.push(b);
      }}}
      if (blocks.length === 0) return;

      blocks.sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
      const blockToBreak = blocks[0];

      if (Date.now() - bot.state.lastDig < cfg.clickDelay) return;
      bot.state.lastDig = Date.now();
      
      try {
        await bot.lookAt(blockToBreak.position.offset(0.5, 0.5, 0.5), true);
        await bot.dig(blockToBreak, true);
      } catch (e) { /* ignore dig errors */ }
    }

    async function trapLogic(targetEntity) {
        if (bot.state.isTrapping) return;

        const distance = bot.entity.position.distanceTo(targetEntity.position);
        if (distance > 4.5) {
            bot.pathfinder.setGoal(new GoalFollow(targetEntity, 3.5), true);
            return;
        }

        bot.pathfinder.stop();
        bot.state.isTrapping = true;

        const trapBlockItem = await getBlockInHand(cfg.trapBlock);
        if (!trapBlockItem) {
            log(`Cannot find ${cfg.trapBlock} to trap with.`);
            bot.state.isTrapping = false;
            bot.state.mode = null;
            updateStatus('Idle');
            return;
        }
        await bot.equip(trapBlockItem, 'hand');

        const playerPos = targetEntity.position.floored();

        for (const offset of trapOffsets) {
            const blockPos = playerPos.plus(offset);
            const block = bot.blockAt(blockPos);
            if (block && block.name === 'air') {
                try {
                    // Find a non-air block to place ON
                    const placeAgainst = bot.blockAt(blockPos.offset(0, -1, 0)) || bot.blockAt(blockPos.offset(1, 0, 0)) || bot.blockAt(blockPos.offset(-1, 0, 0)) || bot.blockAt(blockPos.offset(0, 0, 1)) || bot.blockAt(blockPos.offset(0, 0, -1));
                    if (placeAgainst && placeAgainst.name !== 'air') {
                       await bot.placeBlock(placeAgainst, offset.minus(placeAgainst.position.minus(playerPos)).scaled(-1));
                    }
                } catch(e) { /* ignore placement errors */ }
            }
        }
        
        log(`Trap for ${bot.state.target} should be complete.`);
        bot.state.mode = 'follow'; // Switch to follow after trapping
        updateStatus(`Following ${bot.state.target}`);
        bot.state.isTrapping = false;
    }

    async function getBlockInHand(itemName) {
        let item = bot.inventory.findInventoryItem(mcData.itemsByName[itemName]?.id);
        if (item) return item;

        if (bot.creative) {
            try {
                const Item = require('prismarine-item')(bot.version);
                const creativeItem = new Item(mcData.itemsByName[itemName].id, 64);
                await bot.creative.setInventorySlot(36, creativeItem);
                log(`Gave myself a stack of ${itemName}.`);
                return bot.inventory.findInventoryItem(mcData.itemsByName[itemName].id);
            } catch (e) { err(e); }
        }
        return null;
    }
    
    bot.on('error', e => err(e));
    bot.on('end', (reason) => {
      log(`Disconnected: ${reason}.`);
      process.exit(1);
    });
  }

  try {
    log('Starting bot...');
    createBot();
  } catch (e) {
    err(e);
    process.exit(1);
  }
})();

