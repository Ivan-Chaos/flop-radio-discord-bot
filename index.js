// index.js
require('dotenv').config(); // optional, if you use .env file for DISCORD_TOKEN
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus, getVoiceConnection } = require('@discordjs/voice');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

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

// Helper: start ffmpeg reading the radio stream and return its stdout stream
function createFfmpegStream(url) {
  // ffmpeg command: use reconnect flags for robust streaming, output raw s16le 48k stereo (discord expects 48k)
  const args = [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', url,
    '-vn',
    '-ac', '2',
    '-ar', '48000',
    '-f', 's16le',
    'pipe:1'
  ];
  const ff = spawn(ffmpegStatic, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  ff.on('error', err => {
    console.error('ffmpeg spawn error:', err);
    console.error('Make sure ffmpeg is installed and in your PATH');
  });

  // Log stderr for debugging (ffmpeg outputs info to stderr)
  let stderrBuffer = '';
  ff.stderr.on('data', d => {
    stderrBuffer += d.toString();
    // Log errors and important messages
    const data = d.toString();
    if (data.toLowerCase().includes('error') || data.toLowerCase().includes('failed')) {
      console.error('ffmpeg error:', data);
    }
  });

  // Handle process exit
  ff.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`ffmpeg exited with code ${code}, signal ${signal}`);
      if (stderrBuffer) {
        console.error('ffmpeg stderr output:', stderrBuffer);
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

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator
  });

  // Handle connection errors
  connection.on('error', error => {
    console.error('Voice connection error:', error);
    disconnectGuild(guildId);
  });

  const player = createAudioPlayer();
  connection.subscribe(player);

  // start ffmpeg and pipe into discord
  const ffmpeg = createFfmpegStream(RADIO_URL);
  
  // Wait a moment to ensure ffmpeg starts successfully
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // Check if ffmpeg process is still alive
  if (ffmpeg.killed || ffmpeg.exitCode !== null) {
    throw new Error('ffmpeg process failed to start');
  }

  // Handle ffmpeg process exit - cleanup and notify
  ffmpeg.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`ffmpeg process exited unexpectedly in guild ${guildId}`);
      disconnectGuild(guildId);
    }
  });

  // create resource from ffmpeg stdout (raw PCM 16-bit)
  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });

  player.play(resource);

  player.on(AudioPlayerStatus.Playing, () => {
    console.log(`🎵 Started playing in guild ${guildId} - Floptropican vibes activated! 💅✨`);
  });

  player.on('error', error => {
    console.error('Audio player error:', error);
    disconnectGuild(guildId);
  });

  player.on(AudioPlayerStatus.Idle, () => {
    console.log(`Player went idle in guild ${guildId} - this might indicate a stream issue`);
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

    await interaction.reply({ content: `💋✨ Deploying badussy forces to ${memberVoice.name} 🎵🔥 WE ARE CHARLIE CUPCAKKE!!!! 🎧💅`, ephemeral: false });

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
