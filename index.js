// index.js
import dotenv from 'dotenv';
dotenv.config(); // optional, if you use .env file for DISCORD_TOKEN
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus, getVoiceConnection } from '@discordjs/voice';
import { spawn, execSync } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import http from "http";
http.createServer((req, res) => res.end("Bot is running")).listen(process.env.PORT || 3000);


const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('Set DISCORD_TOKEN env var and restart.');
  process.exit(1);
}

const RADIO_URL = process.env.RADIO_STREAM_URL;

// --- Create slash commands (join, leave) on bot startup (guild command is faster to appear)
const commands = [
  new SlashCommandBuilder().setName('vagina').setDescription('🎵 PLAY RADIO <3 CUPCAKKE FOR LIFE 💅✨'),
  new SlashCommandBuilder().setName('cvm').setDescription('💋 Badussy army is gonna be after yo ass if you run this 🔥🍑')
].map(cmd => cmd.toJSON());

// Replace with your guild ID while testing for instant registration, or register globally
const GUILD_ID = process.env.GUILD_ID || null; // optional; set to speed up command availability
const CLIENT_ID = process.env.CLIENT_ID || null; // optional; your bot application id

async function registerCommands() {
  if (!CLIENT_ID) {
    console.warn('CLIENT_ID not set — skipping command registration. Set CLIENT_ID and GUILD_ID for auto registration.');
    return;
  }
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('Registered guild commands.');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Registered global commands (can take up to an hour to appear).');
    }
  } catch (err) {
    console.error('Error registering commands:', err);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const players = new Map(); // map guildId -> { player, ffmpegProc }

// Determine which ffmpeg binary to use
function getFfmpegPath() {
  // Try to use system ffmpeg first (more reliable on some platforms)
  try {
    execSync('which ffmpeg', { stdio: 'ignore' });
    console.log(`[DEBUG] Using system ffmpeg`);
    return 'ffmpeg';
  } catch {
    // Fall back to ffmpeg-static
    console.log(`[DEBUG] System ffmpeg not found, using ffmpeg-static: ${ffmpegStatic}`);
    return ffmpegStatic;
  }
}

const FFMPEG_PATH = getFfmpegPath();

// Helper: start ffmpeg reading the radio stream and return its stdout stream
function createFfmpegStream(url) {
  // Optimized ffmpeg command for live streaming:
  // - Use reconnect flags for robust streaming
  // - Lower analyzeduration/probesize for faster startup
  // - Set buffer size for better streaming
  // - Output raw s16le 48k stereo (discord expects 48k)
  // - Use stream_loop for continuous playback
  const args = [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-analyzeduration', '0',
    '-probesize', '1000000',
    '-bufsize', '64k',
    '-i', url,
    '-vn',                    // No video
    '-acodec', 'pcm_s16le',   // Explicitly set codec
    '-ac', '2',               // 2 audio channels (stereo)
    '-ar', '48000',           // 48kHz sample rate
    '-f', 's16le',            // Format: signed 16-bit little-endian
    '-loglevel', 'warning',   // Reduce log noise but keep warnings
    'pipe:1'                  // Output to stdout
  ];
  console.log(`[DEBUG] Spawning ffmpeg with args:`, args);
  console.log(`[DEBUG] ffmpeg path: ${FFMPEG_PATH}`);
  console.log(`[DEBUG] Stream URL: ${url}`);
  const ff = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`[DEBUG] ffmpeg process spawned, PID: ${ff.pid}`);

  ff.on('error', err => {
    console.error(`[DEBUG] ffmpeg spawn error:`, err);
    console.error(`[DEBUG] Make sure ffmpeg is installed and in your PATH`);
  });

  // Log stderr for debugging (ffmpeg outputs info to stderr)
  let stderrBuffer = '';
  let hasLoggedStart = false;
  ff.stderr.on('data', d => {
    const data = d.toString();
    stderrBuffer += data;
    
    // Log initial connection info
    if (!hasLoggedStart && (data.includes('Stream #') || data.includes('Audio:'))) {
      console.log(`[DEBUG] ffmpeg stream info:`, data.trim());
      hasLoggedStart = true;
    }
    
    // Log errors and important messages
    if (data.toLowerCase().includes('error') || 
        data.toLowerCase().includes('failed') || 
        data.toLowerCase().includes('connection') ||
        data.toLowerCase().includes('timeout') ||
        data.toLowerCase().includes('segmentation') ||
        data.toLowerCase().includes('crash')) {
      console.error(`[DEBUG] ffmpeg stderr:`, data.trim());
    }
  });

  // Handle process exit
  ff.on('exit', (code, signal) => {
    console.log(`[DEBUG] ffmpeg process exited, code: ${code}, signal: ${signal}`);
    if (signal === 'SIGSEGV') {
      console.error(`[DEBUG] CRITICAL: ffmpeg crashed with segmentation fault (SIGSEGV)`);
      console.error(`[DEBUG] This usually indicates a binary compatibility issue or memory problem`);
      console.error(`[DEBUG] ffmpeg path: ${FFMPEG_PATH}`);
      console.error(`[DEBUG] Suggestion: Install system ffmpeg on your platform (apt-get install ffmpeg / yum install ffmpeg)`);
      if (stderrBuffer) {
        console.error(`[DEBUG] ffmpeg stderr output before crash:`, stderrBuffer);
      }
    } else if (code !== 0 && code !== null) {
      console.error(`[DEBUG] ffmpeg exited with non-zero code ${code}, signal ${signal}`);
      if (stderrBuffer) {
        console.error(`[DEBUG] ffmpeg stderr output:`, stderrBuffer);
      }
    }
  });

  return ff;
}

// Play radio in given voiceChannel
async function playRadio(voiceChannel) {
  const guildId = voiceChannel.guild.id;

  // if already playing leave previous
  const existing = players.get(guildId);
  if (existing) {
    // stop current player and kill ffmpeg
    try { existing.player.stop(true); } catch {}
    try { existing.ffmpeg.kill('SIGKILL'); } catch {}
    players.delete(guildId);
  }

  console.log(`[DEBUG] Creating voice connection for guild ${guildId}, channel ${voiceChannel.id} (${voiceChannel.name})`);
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator
  });

  console.log(`[DEBUG] Voice connection created, state: ${connection.state.status}`);

  // Wait for connection to be ready before proceeding
  if (connection.state.status !== 'ready') {
    console.log(`[DEBUG] Waiting for voice connection to be ready (current: ${connection.state.status})`);
    await new Promise((resolve, reject) => {
      // No timeout - wait indefinitely for connection
      connection.on('stateChange', (oldState, newState) => {
        console.log(`[DEBUG] Voice connection state changed for guild ${guildId}: ${oldState.status} -> ${newState.status}`);
        if (newState.status === 'ready') {
          connection.removeAllListeners('stateChange');
          console.log(`[DEBUG] Voice connection ready for guild ${guildId}`);
          resolve();
        } else if (newState.status === 'disconnected') {
          connection.removeAllListeners('stateChange');
          reject(new Error(`Connection disconnected: ${newState.reason}`));
        }
      });

      // If already ready, resolve immediately
      if (connection.state.status === 'ready') {
        resolve();
      }
    });
  }

  // Handle connection state changes (after initial ready)
  connection.on('stateChange', (oldState, newState) => {
    console.log(`[DEBUG] Voice connection state changed for guild ${guildId}: ${oldState.status} -> ${newState.status}`);
    if (newState.status === 'disconnected') {
      console.log(`[DEBUG] Connection disconnected for guild ${guildId}, reason: ${newState.reason}`);
    }
  });

  // Handle connection errors
  connection.on('error', error => {
    console.error(`[DEBUG] Voice connection error for guild ${guildId}:`, error);
    console.error(`[DEBUG] Error stack:`, error.stack);
    disconnectGuild(guildId);
  });

  const player = createAudioPlayer();
  console.log(`[DEBUG] Audio player created for guild ${guildId}`);
  
  try {
    connection.subscribe(player);
    console.log(`[DEBUG] Subscribed audio player to connection for guild ${guildId}`);
  } catch (err) {
    console.error(`[DEBUG] Failed to subscribe player to connection for guild ${guildId}:`, err);
    throw err;
  }

  // start ffmpeg and pipe into discord
  if (!RADIO_URL) {
    throw new Error('RADIO_STREAM_URL environment variable is not set');
  }
  console.log(`[DEBUG] Starting ffmpeg stream for guild ${guildId}, URL: ${RADIO_URL}`);
  const ffmpeg = createFfmpegStream(RADIO_URL);
  console.log(`[DEBUG] ffmpeg process spawned for guild ${guildId}, PID: ${ffmpeg.pid}`);
  
  // Wait for ffmpeg to start and begin streaming data
  let dataReceived = false;
  let exitInfo = null;
  
  const dataPromise = new Promise((resolve, reject) => {
    // No timeout - wait for data or exit
    ffmpeg.stdout.once('data', (chunk) => {
      if (!dataReceived) {
        dataReceived = true;
        console.log(`[DEBUG] ffmpeg started streaming data for guild ${guildId}, first chunk: ${chunk.length} bytes`);
        resolve();
      }
    });

    ffmpeg.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      if (!dataReceived) {
        if (signal === 'SIGSEGV') {
          reject(new Error(`ffmpeg crashed with SIGSEGV (segmentation fault) before streaming data. This is a critical crash, not a connection issue. Try installing system ffmpeg on your platform.`));
        } else {
          reject(new Error(`ffmpeg exited before streaming data, code: ${code}, signal: ${signal}`));
        }
      }
    });
  });

  // Check if ffmpeg process is still alive (exit handler will catch crashes)
  if (ffmpeg.killed || ffmpeg.exitCode !== null || exitInfo) {
    const signal = exitInfo?.signal || 'unknown';
    const code = exitInfo?.code ?? ffmpeg.exitCode;
    console.error(`[DEBUG] ffmpeg process failed to start for guild ${guildId}, killed: ${ffmpeg.killed}, exitCode: ${code}, signal: ${signal}`);
    if (signal === 'SIGSEGV') {
      throw new Error(`ffmpeg crashed with SIGSEGV immediately after spawn. This indicates a binary compatibility issue. Please install system ffmpeg on your platform (e.g., apt-get install ffmpeg).`);
    }
    throw new Error(`ffmpeg process failed to start (killed: ${ffmpeg.killed}, exitCode: ${code}, signal: ${signal})`);
  }
  console.log(`[DEBUG] ffmpeg process confirmed alive for guild ${guildId}`);

  // Wait for data to start flowing (no timeout - wait indefinitely)
  try {
    await dataPromise;
  } catch (err) {
    console.error(`[DEBUG] Failed to receive data from ffmpeg:`, err);
    if (!ffmpeg.killed && ffmpeg.exitCode === null) {
      ffmpeg.kill('SIGKILL');
    }
    throw err;
  }

  // Handle ffmpeg process exit - cleanup and notify
  ffmpeg.on('exit', (code, signal) => {
    console.log(`[DEBUG] ffmpeg process exited for guild ${guildId}, code: ${code}, signal: ${signal}`);
    if (code !== 0 && code !== null) {
      console.error(`[DEBUG] ffmpeg process exited unexpectedly in guild ${guildId} with code ${code}`);
      disconnectGuild(guildId);
    }
  });

  // Monitor ffmpeg stdout for data flow
  let bytesReceived = 0;
  ffmpeg.stdout.on('data', (chunk) => {
    bytesReceived += chunk.length;
    if (bytesReceived % (1024 * 1024) < chunk.length) { // Log every ~1MB
      console.log(`[DEBUG] ffmpeg stream data flowing for guild ${guildId}, total bytes: ${bytesReceived}`);
    }
  });

  ffmpeg.stdout.on('error', (err) => {
    console.error(`[DEBUG] ffmpeg stdout error for guild ${guildId}:`, err);
  });

  // create resource from ffmpeg stdout (raw PCM 16-bit)
  console.log(`[DEBUG] Creating audio resource from ffmpeg stdout for guild ${guildId}`);
  const resource = createAudioResource(ffmpeg.stdout, { 
    inputType: StreamType.Raw,
    inlineVolume: false
  });
  console.log(`[DEBUG] Audio resource created for guild ${guildId}`);

  console.log(`[DEBUG] Starting playback for guild ${guildId}`);
  try {
    player.play(resource);
    console.log(`[DEBUG] Playback started for guild ${guildId}`);
  } catch (err) {
    console.error(`[DEBUG] Failed to start playback:`, err);
    throw err;
  }

  player.on(AudioPlayerStatus.Playing, () => {
    console.log(`[DEBUG] Audio player status: Playing for guild ${guildId}`);
    console.log(`🎵 Started playing in guild ${guildId} - Floptropican vibes activated! 💅✨`);
  });

  player.on(AudioPlayerStatus.Buffering, () => {
    console.log(`[DEBUG] Audio player status: Buffering for guild ${guildId}`);
  });

  player.on(AudioPlayerStatus.Paused, () => {
    console.log(`[DEBUG] Audio player status: Paused for guild ${guildId}`);
  });

  player.on('error', error => {
    console.error(`[DEBUG] Audio player error for guild ${guildId}:`, error);
    console.error(`[DEBUG] Audio player error stack:`, error.stack);
    disconnectGuild(guildId);
  });

  player.on(AudioPlayerStatus.Idle, () => {
    console.log(`[DEBUG] Audio player status: Idle for guild ${guildId} - this might indicate a stream issue`);
    console.log(`Player went idle in guild ${guildId} - this might indicate a stream issue`);
    
    // Check if ffmpeg is still running
    const entry = players.get(guildId);
    if (entry && entry.ffmpeg) {
      const isAlive = !entry.ffmpeg.killed && entry.ffmpeg.exitCode === null;
      console.log(`[DEBUG] ffmpeg process status - alive: ${isAlive}, killed: ${entry.ffmpeg.killed}, exitCode: ${entry.ffmpeg.exitCode}`);
      
      // Check connection state
      const conn = getVoiceConnection(guildId);
      if (conn) {
        console.log(`[DEBUG] Voice connection state: ${conn.state.status}`);
      } else {
        console.log(`[DEBUG] Voice connection not found`);
      }
    }
  });

  // store so we can stop later
  players.set(guildId, { player, ffmpeg, connection });

  return { player, ffmpeg, connection };
}

// Disconnect and cleanup for a guild
function disconnectGuild(guildId) {
  const entry = players.get(guildId);
  if (!entry) return;
  try { entry.player.stop(true); } catch {}
  try { entry.ffmpeg.kill('SIGKILL'); } catch {}
  try {
    const c = getVoiceConnection(guildId);
    if (c) c.destroy();
  } catch (e) { /* ignore */ }
  players.delete(guildId);
}

// Auto-disconnect when channel empty (no non-bot users)
client.on('voiceStateUpdate', (oldState, newState) => {
  // For each connection, check its channel members
  for (const [guildId, entry] of players.entries()) {
    try {
      const conn = getVoiceConnection(guildId);
      if (!conn) {
        disconnectGuild(guildId);
        continue;
      }
      const channel = conn.joinConfig.channelId ? oldState.guild.channels.cache.get(conn.joinConfig.channelId) : null;
      if (!channel) continue;
      // Count non-bot members still in the channel
      const nonBotMembers = channel.members.filter(m => !m.user.bot);
      if (nonBotMembers.size === 0) {
        console.log(`Channel ${channel.id} empty of real users — disconnecting bot for guild ${guildId}`);
        disconnectGuild(guildId);
      }
    } catch (err) {
      console.error('Error in voiceStateUpdate handler:', err);
    }
  }
});

// Command handling
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'vagina') {
    // who invoked - make sure they are in a voice channel
    const memberVoice = interaction.member?.voice?.channel;
    if (!memberVoice) {
      await interaction.reply({ content: '💅 You need to be in a vagina channel first, bestie! 🎤✨', ephemeral: true });
      return;
    }

    await interaction.reply({ content: `💋✨ Deploying badussy forces to ${memberVoice.name} 🎵🔥 🎧💅`, ephemeral: false });

    try {
      await playRadio(memberVoice);
      // no further reply (we already sent)
    } catch (err) {
      console.error('Failed to join/play:', err);
      await interaction.followUp({ content: `😭💔 Labubus got us((((. The badussy forces have been defeated... 💅✨`, ephemeral: true });
    }
  }

  if (commandName === 'cvm') {
    const guildId = interaction.guildId;
    disconnectGuild(guildId);
    await interaction.reply({ content: 'GAWK GAWK GAWK GAWK SUCK THAT DICK PUSSY 🎵✨', ephemeral: true });
  }
});

client.once('ready', async () => {
  console.log(`💋✨ Logged in as ${client.user.tag} - Badussy army ready to serve! 🎵🔥💅`);
  await registerCommands();
});

client.login(TOKEN);
