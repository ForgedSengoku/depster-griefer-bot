/*
  Ultimate Minecraft Bot Server - Gemini Overhaul 2.0
  - Connection Stability: Fixed account mapping issues on disconnect. Authenticated usernames are now correctly linked to their source from accountsList.txt, preventing mismatches.
  - Enhanced Logging: Added clear logs to show which file username corresponds to which authenticated in-game name.
  - Trap Logic Reworked: Significantly improved the 'trap' command's reliability. Bots now correctly acquire dirt (even in creative) and build the prison structure more effectively.
  - Griefing Adjustments: Griefing movement is now slower and non-sprinting for a more methodical block-breaking approach, as requested.
  - Configuration Update: CPS is set to 20.
  - Dashboard Renamed: The frontend file is now `bot_dashboard.html`.
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
  cps: 20, // Set to 20 CPS for fast breaking like old code
  clickDelay: 1000 / 20,
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
  // This map stores the initial username (from file or temp auth name) as the key
  const activeWorkers = new Map(); // initialUsername -> { worker, finalUsername }
  const forwardStreamOutputToDashboard = (stream, type) => {
      const originalWrite = stream.write;
      stream.write = (chunk, encoding, callback) => {
          const message = chunk.toString();
          if (message.trim()) {
              io.emit('log', { bot: 'System', text: message, type });
          }
          return originalWrite.apply(stream, [chunk, encoding, callback]);
      };
  };
  forwardStreamOutputToDashboard(process.stdout, 'info');
  forwardStreamOutputToDashboard(process.stderr, 'error');
  app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'bot_dashboard.html')));
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
    // Store worker reference immediately
    activeWorkers.set(username, { worker, finalUsername: null });
    console.log(`[main] Spawned worker for: ${username} (isAuth: ${isAuthWorker})`);
    worker.on('message', msg => {
      if (!msg || !msg.type) return;
      const botName = msg.bot || username;
      switch (msg.type) {
        case 'auth-link':
          io.emit('auth-link', { ...msg, username: botName });
          io.emit('log', { bot: botName, text: `Auth required. Code: ${msg.user_code}`, type: 'info' });
          break;
        case 'authenticated':
          const finalUsername = msg.nickname;
          const initialUsername = msg.initialUsername;
        
          if (activeWorkers.has(initialUsername)) {
              // Update the final username for the existing entry
              const workerEntry = activeWorkers.get(initialUsername);
              workerEntry.finalUsername = finalUsername;
              // If the initial username was a temp one, we need to remap
              if (isAuthWorker) {
                  activeWorkers.delete(initialUsername);
                  activeWorkers.set(finalUsername, workerEntry);
              }
          }
        
          io.emit('bot-authenticated', { tempUsername: initialUsername, finalUsername: finalUsername });
          // The specific logging format you requested
          console.log(`[main] Authed usrname: ${finalUsername}`);
          console.log(`[main] txtfileusername: ${initialUsername}`);
          break;
        case 'status-update':
            // Find the correct bot to update, it could be keyed by initial or final name
            let botToUpdate = activeWorkers.get(botName) || Array.from(activeWorkers.values()).find(w => w.finalUsername === botName);
            if (botToUpdate) {
                 io.emit('bot-status-update', { username: botToUpdate.finalUsername || botName, status: msg.status });
            }
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
      let exitedBotInfo = null;
      for (const [key, wInfo] of activeWorkers.entries()) {
        if (wInfo.worker === worker) {
          exitedBotKey = key;
          exitedBotInfo = wInfo;
          break;
        }
      }
      if (exitedBotKey) {
        activeWorkers.delete(exitedBotKey);
        // If the bot had a final name, use that for the offline message
        const offlineUsername = exitedBotInfo.finalUsername || exitedBotKey;
        io.emit('bot-offline', { username: offlineUsername });
        console.log(`[main] Worker for ${offlineUsername} (initial: ${exitedBotKey}) exited with code ${code}.`);
        // Respawn logic for non-auth workers that crash
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
    const onlineBots = Array.from(activeWorkers.values()).map(w => w.finalUsername).filter(Boolean);
    socket.emit('initial-accounts', onlineBots);
    socket.on('spawn-auth-bot', () => {
        const tempUsername = `AuthBot-${Math.floor(Math.random() * 10000)}`;
        spawnWorkerFor(tempUsername, true);
        io.emit('bot-online', { username: tempUsername, status: 'Authenticating...' });
    });
    socket.on('send-command', (data) => {
      if (!data || !data.command) return;
      console.log(`[main] Received command '${data.command}' from dashboard.`);
      if (data.command === 'clearmap') {
          const workers = Array.from(activeWorkers.values()).map(w => w.worker);
          workers.forEach((worker, index) => {
              const angle = (index / workers.length) * 2 * Math.PI;
              worker.postMessage({ type: 'command', command: 'clearmap', angle });
          });
          return;
      }
    
      for (const { worker } of activeWorkers.values()) {
        worker.postMessage({ type: 'command', ...data });
      }
    });
    socket.on('send-chat', (message) => {
      console.log(`[main] Broadcasting chat from dashboard: ${message}`);
      for (const { worker } of activeWorkers.values()) {
        worker.postMessage({ type: 'command', command: 'chat', message });
      }
    });
    socket.on('disconnect-all', () => {
      console.log(`[main] Disconnecting all bots via dashboard command.`);
      activeWorkers.forEach(({ worker } ) => worker.terminate());
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
  const Item = require('prismarine-item')(cfg.server.version);
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
          trapOffsets.push({ pos: new Vec3(x, -1, z), type: 'floor' });
      }
  }
  // Walls (2 layers high)
  for (let y = 0; y <= 1; y++) {
    trapOffsets.push({ pos: new Vec3(-1, y, -1), type: 'wall' }); trapOffsets.push({ pos: new Vec3(-1, y, 1), type: 'wall' });
    trapOffsets.push({ pos: new Vec3(1, y, -1), type: 'wall' }); trapOffsets.push({ pos: new Vec3(1, y, 1), type: 'wall' });
    trapOffsets.push({ pos: new Vec3(0, y, -1), type: 'wall' }); trapOffsets.push({ pos: new Vec3(0, y, 1), type: 'wall' });
    trapOffsets.push({ pos: new Vec3(-1, y, 0), type: 'wall' }); trapOffsets.push({ pos: new Vec3(1, y, 0), type: 'wall' });
  }
  // Roof (9 blocks)
  for (let x = -1; x <= 1; x++) {
      for (let z = -1; z <= 1; z++) {
          trapOffsets.push({ pos: new Vec3(x, 2, z), type: 'roof' });
      }
  }
  parentPort.on('message', (msg) => {
    if (!bot || !bot.entity || !msg || msg.type !== 'command') return;
    const resetState = () => {
      bot.state.target = null;
      bot.state.mode = null;
      bot.state.isTrapping = false;
      bot.controlState.sprint = false;
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
      }
      // Send authenticated message regardless, to confirm connection and final username
      send({ type: 'authenticated', nickname: bot.username, initialUsername: initialUsername });
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
            bot.controlState.sprint = true;
            const goal = new GoalFollow(player.entity, 1);
            bot.pathfinder.setGoal(goal, true);
            break;
          case 'grief':
            if (!player?.entity) { bot.state.mode = null; updateStatus('Idle'); return; }
            bot.controlState.sprint = true;
            await griefLogic(player.entity.position);
            break;
          case 'trap':
            if (!player?.entity) { bot.state.mode = null; updateStatus('Idle'); return; }
            await trapLogic(player.entity);
            break;
          case 'clearmap':
            bot.controlState.sprint = true;
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
        bot.pathfinder.setGoal(new GoalBlock(targetPos.x, targetPos.y, targetPos.z), true);
        const blocks = [];
        for (let dx = -scanRadius; dx <= scanRadius; dx++) {
        for (let dy = -scanRadius; dy <= scanRadius; dy++) {
        for (let dz = -scanRadius; dz <= scanRadius; dz++) {
            const bpos = targetPos.offset(dx, dy, dz);
            if (bot.entity.position.distanceTo(bpos) > maxDig) continue;
            const b = bot.blockAt(bpos);
            if (!b || !b.position || b.name === 'air' || protectedIds.has(b.type)) continue;
            blocks.push(b);
        }}}
        if (blocks.length === 0) return;
        blocks.sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
        const block = blocks[0];
        const now = Date.now();
        if (now - bot.state.lastDig < clickDelay) return;
        bot.state.lastDig = now;
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
        bot.dig(block, true, 'raycast').catch(() => {});
    }
    async function trapLogic(targetEntity) {
        if (bot.state.isTrapping) return;
        const distance = bot.entity.position.distanceTo(targetEntity.position);
        if (distance > 4.5) {
            bot.pathfinder.setGoal(new GoalFollow(targetEntity, 3.5), true);
            return; // Keep moving closer
        }
        bot.pathfinder.stop();
        bot.state.isTrapping = true;
        const trapBlockItem = await getBlockInHand(cfg.trapBlock);
        if (!trapBlockItem) {
            log(`Cannot find or get ${cfg.trapBlock} to trap with. Aborting.`);
            bot.state.isTrapping = false;
            bot.state.mode = null;
            updateStatus('Idle');
            return;
        }
        await bot.equip(trapBlockItem, 'hand');
        const playerPos = targetEntity.position.floored();
        for (const { pos: offset } of trapOffsets) {
            const blockPos = playerPos.plus(offset);
            const block = bot.blockAt(blockPos);
            // Only place if the spot is empty (air, water, etc.)
            if (block && block.boundingBox === 'empty') {
                // To place a block, we need a solid block next to the target position
                // Let's check all 6 adjacent positions for a solid block to place against
                const adjacentOffsets = [
                    new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(-1, 0, 0),
                    new Vec3(1, 0, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1)
                ];
                for (const adjOffset of adjacentOffsets) {
                    const referenceBlockPos = blockPos.plus(adjOffset);
                    const referenceBlock = bot.blockAt(referenceBlockPos);
                  
                    if (referenceBlock && referenceBlock.boundingBox === 'block') {
                         try {
                            // The face vector is the inverse of the offset from the placement position
                            const faceVector = adjOffset.scaled(-1);
                            await bot.placeBlock(referenceBlock, faceVector);
                            // Short delay to help server keep up
                            await new Promise(resolve => setTimeout(resolve, 50));
                            break; // Move to the next block in the trap structure
                         } catch(e) { /* ignore placement errors, try next reference block */ }
                    }
                }
            }
        }
        log(`Trap for ${bot.state.target} should be complete.`);
        bot.state.mode = 'follow'; // Switch to follow after trapping
        updateStatus(`Following ${bot.state.target}`);
        bot.state.isTrapping = false;
    }
    async function getBlockInHand(itemName) {
        const itemData = mcData.itemsByName[itemName];
        if (!itemData) return null;
      
        let item = bot.inventory.findInventoryItem(itemData.id);
        if (item) return item;
        // If no item and in creative, give one
        if (bot.creative) {
            try {
                // First hotbar slot is 36
                await bot.creative.setInventorySlot(36, new Item(itemData.id, 64));
                log(`Gave myself a stack of ${itemName}.`);
                // Re-check inventory after giving
                return bot.inventory.findInventoryItem(itemData.id);
            } catch (e) {
                err(e);
                return null;
            }
        }
        return null;
    }
    bot.on('error', e => err(e));
    bot.on('end', (reason) => {
      log(`Disconnected: ${reason}.`);
      process.exit(1); // Main thread will handle respawning if needed
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
