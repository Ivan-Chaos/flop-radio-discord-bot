// index.js
import dotenv from 'dotenv';
dotenv.config();
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource, 
  StreamType, 
  AudioPlayerStatus, 
  getVoiceConnection 
} from '@discordjs/voice';
import { spawn, execSync } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import http from "http";

// ============================================================================
// Configuration
// ============================================================================

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('Set DISCORD_TOKEN env var and restart.');
  process.exit(1);
}

const RADIO_URL = process.env.RADIO_STREAM_URL;
const GUILD_ID = process.env.GUILD_ID || null;
const CLIENT_ID = process.env.CLIENT_ID || null;

// ============================================================================
// HTTP Health Check Server
// ============================================================================

http.createServer((req, res) => res.end("Bot is running")).listen(process.env.PORT || 3000);

// ============================================================================
// FFmpeg Setup
// ============================================================================

function getFfmpegPath() {
  try {
    execSync('which ffmpeg', { stdio: 'ignore' });
    console.log(`[DEBUG] Using system ffmpeg`);
    return 'ffmpeg';
  } catch {
    console.log(`[DEBUG] System ffmpeg not found, using ffmpeg-static: ${ffmpegStatic}`);
    return ffmpegStatic;
  }
}

const FFMPEG_PATH = getFfmpegPath();

function createFfmpegArgs(url) {
  return [
    // Input options
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-analyzeduration', '0',
    '-probesize', '1000000',
    '-i', url,
    // Output options
    '-vn',                    // No video
    '-acodec', 'pcm_s16le',   // Audio codec
    '-ac', '2',               // Stereo
    '-ar', '48000',           // 48kHz sample rate
    '-f', 's16le',            // Format: signed 16-bit little-endian
    '-loglevel', 'warning',   // Log level
    'pipe:1'                  // Output to stdout
  ];
}

function createFfmpegStream(url) {
  const args = createFfmpegArgs(url);
  console.log(`[DEBUG] Spawning ffmpeg, path: ${FFMPEG_PATH}, URL: ${url}`);
  
  const ff = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`[DEBUG] ffmpeg process spawned, PID: ${ff.pid}`);

  let stderrBuffer = '';
  let hasLoggedStart = false;

  ff.on('error', err => {
    console.error(`[DEBUG] ffmpeg spawn error:`, err);
  });

  ff.stderr.on('data', d => {
    const data = d.toString();
    stderrBuffer += data;
    
    if (!hasLoggedStart && (data.includes('Stream #') || data.includes('Audio:'))) {
      console.log(`[DEBUG] ffmpeg stream info:`, data.trim());
      hasLoggedStart = true;
    }
    
    const lowerData = data.toLowerCase();
    if (lowerData.includes('error') || 
        lowerData.includes('failed') || 
        lowerData.includes('connection') ||
        lowerData.includes('timeout') ||
        lowerData.includes('segmentation') ||
        lowerData.includes('crash')) {
      console.error(`[DEBUG] ffmpeg stderr:`, data.trim());
    }
  });

  ff.on('exit', (code, signal) => {
    console.log(`[DEBUG] ffmpeg process exited, code: ${code}, signal: ${signal}`);
    if (signal === 'SIGSEGV') {
      console.error(`[DEBUG] CRITICAL: ffmpeg crashed with SIGSEGV`);
      console.error(`[DEBUG] ffmpeg path: ${FFMPEG_PATH}`);
      if (stderrBuffer) {
        console.error(`[DEBUG] ffmpeg stderr before crash:`, stderrBuffer);
      }
    } else if (code !== 0 && code !== null) {
      console.error(`[DEBUG] ffmpeg exited with code ${code}`);
      if (stderrBuffer) {
        console.error(`[DEBUG] ffmpeg stderr:`, stderrBuffer);
      }
    }
  });

  return ff;
}

// ============================================================================
// Voice Connection Management
// ============================================================================

async function waitForConnectionReady(connection, guildId) {
  if (connection.state.status === 'ready') {
    return;
  }

  console.log(`[DEBUG] Waiting for voice connection (current: ${connection.state.status})`);
  
  return new Promise((resolve, reject) => {
    const handler = (oldState, newState) => {
      console.log(`[DEBUG] Connection state: ${oldState.status} -> ${newState.status}`);
      
      if (newState.status === 'ready') {
        connection.removeListener('stateChange', handler);
        console.log(`[DEBUG] Voice connection ready for guild ${guildId}`);
        resolve();
      } else if (newState.status === 'disconnected') {
        connection.removeListener('stateChange', handler);
        reject(new Error(`Connection disconnected: ${newState.reason}`));
      }
    };

    connection.on('stateChange', handler);
    
    // Check again in case it became ready before listener was attached
    if (connection.state.status === 'ready') {
      connection.removeListener('stateChange', handler);
      resolve();
    }
  });
}

function setupConnectionHandlers(connection, guildId) {
  connection.on('stateChange', (oldState, newState) => {
    console.log(`[DEBUG] Connection state changed for guild ${guildId}: ${oldState.status} -> ${newState.status}`);
    if (newState.status === 'disconnected') {
      console.log(`[DEBUG] Connection disconnected for guild ${guildId}, reason: ${newState.reason}`);
    }
  });

  connection.on('error', error => {
    console.error(`[DEBUG] Voice connection error for guild ${guildId}:`, error);
    disconnectGuild(guildId);
  });
}

// ============================================================================
// Audio Player Management
// ============================================================================

function setupPlayerHandlers(player, guildId) {
  player.on(AudioPlayerStatus.Playing, () => {
    console.log(`[DEBUG] Audio player: Playing for guild ${guildId}`);
    console.log(`🎵 Started playing in guild ${guildId} - Floptropican vibes activated! 💅✨`);
  });

  player.on(AudioPlayerStatus.Buffering, () => {
    console.log(`[DEBUG] Audio player: Buffering for guild ${guildId}`);
  });

  player.on(AudioPlayerStatus.Paused, () => {
    console.log(`[DEBUG] Audio player: Paused for guild ${guildId}`);
  });

  player.on('error', error => {
    console.error(`[DEBUG] Audio player error for guild ${guildId}:`, error);
    disconnectGuild(guildId);
  });

  player.on(AudioPlayerStatus.Idle, () => {
    console.log(`[DEBUG] Audio player: Idle for guild ${guildId} - possible stream issue`);
    
    const entry = players.get(guildId);
    if (entry?.ffmpeg) {
      const isAlive = !entry.ffmpeg.killed && entry.ffmpeg.exitCode === null;
      console.log(`[DEBUG] ffmpeg status - alive: ${isAlive}, killed: ${entry.ffmpeg.killed}, exitCode: ${entry.ffmpeg.exitCode}`);
      
      const conn = getVoiceConnection(guildId);
      console.log(`[DEBUG] Voice connection state: ${conn?.state.status || 'not found'}`);
    }
  });
}

// ============================================================================
// Stream Data Management
// ============================================================================

async function waitForFfmpegData(ffmpeg, guildId) {
  return new Promise((resolve, reject) => {
    let dataReceived = false;

    ffmpeg.stdout.once('data', (chunk) => {
      dataReceived = true;
      console.log(`[DEBUG] ffmpeg streaming data for guild ${guildId}, first chunk: ${chunk.length} bytes`);
      resolve();
    });

    ffmpeg.on('exit', (code, signal) => {
      if (!dataReceived) {
        if (signal === 'SIGSEGV') {
          reject(new Error(`ffmpeg crashed with SIGSEGV before streaming data. Install system ffmpeg.`));
        } else {
          reject(new Error(`ffmpeg exited before streaming data, code: ${code}, signal: ${signal}`));
        }
      }
    });
  });
}

function setupFfmpegMonitoring(ffmpeg, guildId) {
  let bytesReceived = 0;

  ffmpeg.stdout.on('data', (chunk) => {
    bytesReceived += chunk.length;
    if (bytesReceived % (1024 * 1024) < chunk.length) {
      console.log(`[DEBUG] ffmpeg data flow for guild ${guildId}: ${bytesReceived} bytes`);
    }
  });

  ffmpeg.stdout.on('error', (err) => {
    console.error(`[DEBUG] ffmpeg stdout error for guild ${guildId}:`, err);
  });

  ffmpeg.on('exit', (code, signal) => {
    console.log(`[DEBUG] ffmpeg exited for guild ${guildId}, code: ${code}, signal: ${signal}`);
    if (code !== 0 && code !== null) {
      console.error(`[DEBUG] ffmpeg exited unexpectedly in guild ${guildId}`);
      disconnectGuild(guildId);
    }
  });
}

// ============================================================================
// Main Playback Function
// ============================================================================

const players = new Map();

async function playRadio(voiceChannel) {
  const guildId = voiceChannel.guild.id;

  // Cleanup existing playback
  const existing = players.get(guildId);
  if (existing) {
    try { existing.player.stop(true); } catch {}
    try { existing.ffmpeg.kill('SIGKILL'); } catch {}
    players.delete(guildId);
  }

  if (!RADIO_URL) {
    throw new Error('RADIO_STREAM_URL environment variable is not set');
  }

  // Create voice connection
  console.log(`[DEBUG] Creating voice connection for guild ${guildId}, channel ${voiceChannel.id} (${voiceChannel.name})`);
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator
  });

  await waitForConnectionReady(connection, guildId);
  setupConnectionHandlers(connection, guildId);

  // Create and subscribe audio player
  const player = createAudioPlayer();
  console.log(`[DEBUG] Audio player created for guild ${guildId}`);
  
  try {
    connection.subscribe(player);
    console.log(`[DEBUG] Subscribed audio player to connection for guild ${guildId}`);
  } catch (err) {
    console.error(`[DEBUG] Failed to subscribe player:`, err);
    throw err;
  }

  // Start ffmpeg stream
  console.log(`[DEBUG] Starting ffmpeg stream for guild ${guildId}`);
  const ffmpeg = createFfmpegStream(RADIO_URL);
  
  // Wait for data to start flowing
  try {
    await waitForFfmpegData(ffmpeg, guildId);
  } catch (err) {
    console.error(`[DEBUG] Failed to receive data from ffmpeg:`, err);
    if (!ffmpeg.killed && ffmpeg.exitCode === null) {
      ffmpeg.kill('SIGKILL');
    }
    throw err;
  }

  // Setup monitoring
  setupFfmpegMonitoring(ffmpeg, guildId);
  setupPlayerHandlers(player, guildId);

  // Create audio resource and start playback
  console.log(`[DEBUG] Creating audio resource for guild ${guildId}`);
  const resource = createAudioResource(ffmpeg.stdout, { 
    inputType: StreamType.Raw,
    inlineVolume: false
  });

  console.log(`[DEBUG] Starting playback for guild ${guildId}`);
  player.play(resource);

  // Store for cleanup
  players.set(guildId, { player, ffmpeg, connection });

  return { player, ffmpeg, connection };
}

function disconnectGuild(guildId) {
  const entry = players.get(guildId);
  if (!entry) return;
  
  try { entry.player.stop(true); } catch {}
  try { entry.ffmpeg.kill('SIGKILL'); } catch {}
  try {
    const conn = getVoiceConnection(guildId);
    if (conn) conn.destroy();
  } catch {}
  
  players.delete(guildId);
}

// ============================================================================
// Discord Bot Setup
// ============================================================================

const commands = [
  new SlashCommandBuilder().setName('vagina').setDescription('🎵 PLAY RADIO <3 CUPCAKKE FOR LIFE 💅✨'),
  new SlashCommandBuilder().setName('cvm').setDescription('💋 Badussy army is gonna be after yo ass if you run this 🔥🍑')
].map(cmd => cmd.toJSON());

async function registerCommands() {
  if (!CLIENT_ID) {
    console.warn('CLIENT_ID not set — skipping command registration.');
    return;
  }
  
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('Registered guild commands.');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Registered global commands.');
    }
  } catch (err) {
    console.error('Error registering commands:', err);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

// ============================================================================
// Event Handlers
// ============================================================================

client.on('voiceStateUpdate', (oldState, newState) => {
  for (const [guildId, entry] of players.entries()) {
    try {
      const conn = getVoiceConnection(guildId);
      if (!conn) {
        disconnectGuild(guildId);
        continue;
      }
      
      const channel = conn.joinConfig.channelId 
        ? oldState.guild.channels.cache.get(conn.joinConfig.channelId) 
        : null;
      if (!channel) continue;
      
      const nonBotMembers = channel.members.filter(m => !m.user.bot);
      if (nonBotMembers.size === 0) {
        console.log(`Channel ${channel.id} empty — disconnecting bot for guild ${guildId}`);
        disconnectGuild(guildId);
      }
    } catch (err) {
      console.error('Error in voiceStateUpdate handler:', err);
    }
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'vagina') {
    const memberVoice = interaction.member?.voice?.channel;
    if (!memberVoice) {
      await interaction.reply({ 
        content: '💅 You need to be in a vagina channel first, bestie! 🎤✨', 
        ephemeral: true 
      });
      return;
    }

    await interaction.reply({ 
      content: `💋✨ Deploying badussy forces to ${memberVoice.name} 🎵🔥 🎧💅`, 
      ephemeral: false 
    });

    try {
      await playRadio(memberVoice);
    } catch (err) {
      console.error('Failed to join/play:', err);
      await interaction.followUp({ 
        content: `😭💔 Labubus got us((((. The badussy forces have been defeated... 💅✨`, 
        ephemeral: true 
      });
    }
  }

  if (commandName === 'cvm') {
    disconnectGuild(interaction.guildId);
    await interaction.reply({ 
      content: 'GAWK GAWK GAWK GAWK SUCK THAT DICK PUSSY 🎵✨', 
      ephemeral: true 
    });
  }
});

client.once('ready', async () => {
  console.log(`💋✨ Logged in as ${client.user.tag} - Badussy army ready to serve! 🎵🔥💅`);
  await registerCommands();
});

client.login(TOKEN);
