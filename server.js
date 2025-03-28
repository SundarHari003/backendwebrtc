const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const debounce = require('lodash.debounce');
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
  },
  transports: ['websocket'],
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e8,
});

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'supersecretkey';
const MAX_USERS_PER_ROOM = 20; // Reduced from 50 to better match your target
const rooms = new Map();
const pendingJoins = new Map();
const networkQualityStats = new Map();

// Track dominant speaker and recent speakers
const speakerStats = new Map();
// Debounced function for participant list updates
const debouncedParticipantUpdates = new Map();
const getParticipants = (roomId) => {
  const room = rooms.get(roomId);
  if (!room) return [];

  return Array.from(room.values()).map((p) => ({
    id: p.id,
    isAdmin: p.isAdmin,
    username: p.username,
    handRaised: p.handRaised,
    isMuted: p.isMuted,
    isVideoOff: p.isVideoOff,
    isScreenSharing: p.isScreenSharing || false,
    canShareScreen: p.canShareScreen || false,
    bitrateProfile: p.bitrateProfile || 'medium',
    isSpeaking: p.isSpeaking || false,
  }));
};

const updateSpeakerStats = (roomId, userId, isSpeaking) => {
  if (!speakerStats.has(roomId)) {
    speakerStats.set(roomId, {
      dominantSpeaker: null,
      recentSpeakers: [],
      speakerTimers: new Map(),
    });
  }

  const roomStats = speakerStats.get(roomId);

  if (isSpeaking) {
    if (!roomStats.speakerTimers.has(userId)) {
      roomStats.speakerTimers.set(userId, {
        startTime: Date.now(),
        totalTime: 0,
      });
    }

    if (!roomStats.dominantSpeaker ||
      (roomStats.dominantSpeaker !== userId &&
        roomStats.speakerTimers.get(userId).totalTime > roomStats.speakerTimers.get(roomStats.dominantSpeaker).totalTime)) {
      roomStats.dominantSpeaker = userId;
      io.to(roomId).emit('dominant-speaker-changed', { userId });
    }

    if (!roomStats.recentSpeakers.includes(userId)) {
      roomStats.recentSpeakers.unshift(userId);
      if (roomStats.recentSpeakers.length > 4) {
        roomStats.recentSpeakers.pop();
      }
    }
  } else {
    if (roomStats.speakerTimers.has(userId)) {
      const timer = roomStats.speakerTimers.get(userId);
      timer.totalTime += Date.now() - timer.startTime;
      roomStats.speakerTimers.delete(userId);
    }
  }
};

// Initialize debounced emit for a room
const initDebouncedEmit = (roomId) => {
  if (!debouncedParticipantUpdates.has(roomId)) {
    debouncedParticipantUpdates.set(roomId, debounce(() => {
      io.to(roomId).emit('participant-list', getParticipants(roomId));
    }, 300));
  }
  return debouncedParticipantUpdates.get(roomId);
};

io.on('connection', (socket) => {
  console.log('New user connected:', socket.id);

  // Track network quality for this connection
  networkQualityStats.set(socket.id, {
    lastUpdate: Date.now(),
    quality: 'good',
    packetLoss: 0,
    latency: 0,
    jitter: 0,
  });
  socket.on('network-quality', ({ packetLoss, latency, jitter }) => {
    const stats = networkQualityStats.get(socket.id) || {};
    stats.packetLoss = packetLoss;
    stats.latency = latency;
    stats.jitter = jitter;
    stats.lastUpdate = Date.now();

    let quality;
    if (packetLoss > 10 || latency > 500 || jitter > 100) {
      quality = 'poor';
    } else if (packetLoss > 5 || latency > 300 || jitter > 50) {
      quality = 'medium';
    } else {
      quality = 'good';
    }

    if (quality !== stats.quality) {
      stats.quality = quality;
      socket.emit('recommend-bitrate', { profile: quality });
    }

    networkQualityStats.set(socket.id, stats);
  });

  socket.on('speaking-status', ({ roomId, isSpeaking }) => {
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      if (room.has(socket.id)) {
        room.get(socket.id).isSpeaking = isSpeaking;
        updateSpeakerStats(roomId, socket.id, isSpeaking);
        const debouncedEmit = initDebouncedEmit(roomId);
        debouncedEmit();
      }
    }
  });

  socket.on('generate-room', ({ isAdmin, username }, callback) => {
    if (!isAdmin) {
      callback({ error: 'Only admins can generate rooms.' });
      return;
    }
    const roomId = uuidv4();
    rooms.set(roomId, new Map([
      [socket.id, {
        id: socket.id,
        joinedAt: Date.now(),
        isAdmin: true,
        username: username || `Admin-${socket.id.substring(0, 5)}`,
        handRaised: false,
        isMuted: false,
        isVideoOff: false,
        isScreenSharing: false,
        canShareScreen: true,
        bitrateProfile: 'good',
      }]
    ]));
    socket.join(roomId);
    initDebouncedEmit(roomId);
    callback({ roomId });
  });

  socket.on('request-to-join', ({ roomId, isAdmin, username }, callback) => {
    if (!rooms.has(roomId)) {
      callback({ error: 'Room does not exist.' });
      return;
    }
    const room = rooms.get(roomId);
    if (room.size >= MAX_USERS_PER_ROOM) {
      callback({ error: 'Room is full.' });
      return;
    }
    if (isAdmin && Array.from(room.values()).some((p) => p.isAdmin)) {
      callback({ error: 'Only one admin is allowed per room.' });
      return;
    }
    if (!pendingJoins.has(roomId)) pendingJoins.set(roomId, new Map());
    pendingJoins.get(roomId).set(socket.id, username);
    socket.join(roomId);

    const admin = Array.from(room.values()).find((p) => p.isAdmin);
    if (admin) {
      io.to(admin.id).emit('pending-join', { userId: socket.id, username });
    }
    callback({ success: true, pending: true });
  });

  socket.on('admit-user', async ({ roomId, adminToken, userId }, callback) => {
    if (adminToken !== ADMIN_SECRET) {
      callback({ error: 'Unauthorized action!' });
      return;
    }
    const room = rooms.get(roomId);
    if (!room || !room.has(socket.id) || !room.get(socket.id).isAdmin) {
      callback({ error: 'Only admin can admit users!' });
      return;
    }
    const pendingRoom = pendingJoins.get(roomId);
    if (pendingRoom && pendingRoom.has(userId)) {
      const username = pendingRoom.get(userId);
      room.set(userId, {
        id: userId,
        joinedAt: Date.now(),
        isAdmin: false,
        username: username || `User-${userId.substring(0, 5)}`,
        handRaised: false,
        isMuted: false,
        isVideoOff: false,
        isScreenSharing: false,
        canShareScreen: false,
        bitrateProfile: 'medium',
      });
      pendingRoom.delete(userId);
      if (pendingRoom.size === 0) pendingJoins.delete(roomId);

      const participants = getParticipants(roomId);
      io.in(roomId).emit('participant-list', participants);
      io.to(userId).emit('join-approved');
      socket.to(roomId).emit('user-joined', { userId, participants });

      // Send initial subscription info (dominant speaker + recent speakers)
      const stats = speakerStats.get(roomId) || {};
      io.to(userId).emit('initial-subscriptions', {
        dominantSpeaker: stats.dominantSpeaker,
        recentSpeakers: stats.recentSpeakers || [],
      });

      callback({ success: true });
    } else {
      callback({ error: 'User not found or already admitted.' });
    }
  });

  socket.on('request-screen-share', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room && room.has(socket.id)) {
      const user = room.get(socket.id);
      if (user.isAdmin) {
        // Admin can always share screen
        user.isScreenSharing = true;
        io.in(roomId).emit('participant-list', getParticipants(roomId));
        io.in(roomId).emit('screen-share-started', { sender: socket.id });
      } else if (user.canShareScreen) {
        // Check if someone else is already sharing
        const isSomeoneSharing = Array.from(room.values()).some(p => p.isScreenSharing);
        if (isSomeoneSharing) {
          socket.emit('screen-share-error', { message: 'Someone is already sharing screen.' });
        } else {
          user.isScreenSharing = true;
          io.in(roomId).emit('participant-list', getParticipants(roomId));
          io.in(roomId).emit('screen-share-started', { sender: socket.id });
        }
      } else {
        socket.emit('screen-share-error', { message: 'You need permission to share screen.' });
      }
    }
  });

  socket.on('stop-screen-share', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room && room.has(socket.id)) {
      const user = room.get(socket.id);
      if (user.isScreenSharing) {
        user.isScreenSharing = false;
        io.in(roomId).emit('participant-list', getParticipants(roomId));
        io.in(roomId).emit('screen-share-ended', { sender: socket.id });
      }
    }
  });

  socket.on('enable-user-screen-share', ({ roomId, targetUser, adminToken }) => {
    if (adminToken !== ADMIN_SECRET) return;
    const room = rooms.get(roomId);
    if (room && room.has(socket.id) && room.get(socket.id).isAdmin && room.has(targetUser)) {
      const user = room.get(targetUser);
      user.canShareScreen = true;
      io.in(roomId).emit('participant-list', getParticipants(roomId));
      io.to(targetUser).emit('screen-share-permission-granted');
    }
  });

  socket.on('disable-user-screen-share', ({ roomId, targetUser, adminToken }) => {
    if (adminToken !== ADMIN_SECRET) return;
    const room = rooms.get(roomId);
    if (room && room.has(socket.id) && room.get(socket.id).isAdmin && room.has(targetUser)) {
      const user = room.get(targetUser);
      user.canShareScreen = false;
      if (user.isScreenSharing) {
        user.isScreenSharing = false;
        io.in(roomId).emit('screen-share-ended', { sender: targetUser });
      }
      io.in(roomId).emit('participant-list', getParticipants(roomId));
      io.to(targetUser).emit('screen-share-permission-revoked');
    }
  });

  socket.on('update-bitrate-profile', ({ roomId, profile }) => {
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      if (room.has(socket.id)) {
        room.get(socket.id).bitrateProfile = profile;
        io.to(roomId).emit('participant-list', getParticipants(roomId));
      }
    }
  });

  socket.on('subscribe-to-stream', ({ roomId, targetUserId }) => {
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      if (room.has(targetUserId)) {
        io.to(targetUserId).emit('new-subscriber', { subscriberId: socket.id });
      }
    }
  });

  socket.on('unsubscribe-from-stream', ({ roomId, targetUserId }) => {
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      if (room.has(targetUserId)) {
        io.to(targetUserId).emit('remove-subscriber', { subscriberId: socket.id });
      }
    }
  });

  socket.on('send-message', ({ roomId, message, sender }) => {
    if (rooms.has(roomId)) {
      const timestamp = new Date();
      io.in(roomId).emit('receive-message', { sender, message, timestamp });
    }
  });

  socket.on('signal', ({ roomId, signal, sender, target, streamType }) => {
    const room = rooms.get(roomId);
    if (room && room.has(target)) {
      io.to(target).emit('signal', { signal, sender, streamType });
    }
  });

  socket.on('ice-candidate', ({ roomId, candidate, sender, target, streamType }) => {
    const room = rooms.get(roomId);
    if (room && room.has(target)) {
      io.to(target).emit('ice-candidate', { candidate, sender, streamType });
    }
  });

  socket.on('mute-user', ({ roomId, targetUser }) => {
    const room = rooms.get(roomId);
    if (room.has(socket.id) && room.get(socket.id).isAdmin && room.has(targetUser)) {
      const user = room.get(targetUser);
      user.isMuted = true;
      io.to(targetUser).emit('mute-audio');
      const debouncedEmit = initDebouncedEmit(roomId);
      debouncedEmit();
    }
  });

  socket.on('unmute-user', ({ roomId, targetUser }) => {
    const room = rooms.get(roomId);
    if (room.has(socket.id) && room.get(socket.id).isAdmin && room.has(targetUser)) {
      const user = room.get(targetUser);
      user.isMuted = false;
      io.to(targetUser).emit('unmute-audio');
      const debouncedEmit = initDebouncedEmit(roomId);
      debouncedEmit();
    }
  });

  socket.on('disable-video', ({ roomId, targetUser }) => {
    const room = rooms.get(roomId);
    if (room.has(socket.id) && room.get(socket.id).isAdmin && room.has(targetUser)) {
      const user = room.get(targetUser);
      user.isVideoOff = true;
      io.to(targetUser).emit('disable-video');
      const debouncedEmit = initDebouncedEmit(roomId);
      debouncedEmit();
    }
  });

  socket.on('enable-video', ({ roomId, targetUser }) => {
    const room = rooms.get(roomId);
    if (room.has(socket.id) && room.get(socket.id).isAdmin && room.has(targetUser)) {
      const user = room.get(targetUser);
      user.isVideoOff = false;
      io.to(targetUser).emit('enable-video');
      const debouncedEmit = initDebouncedEmit(roomId);
      debouncedEmit();
    }
  });

  socket.on('raise-hand', ({ roomId, sender }) => {
    const room = rooms.get(roomId);
    if (room && room.has(sender)) {
      room.get(sender).handRaised = true;
      io.in(roomId).emit('user-raised-hand', sender);
      const debouncedEmit = initDebouncedEmit(roomId);
      debouncedEmit();
    }
  });

  socket.on('lower-hand', ({ roomId, sender }) => {
    const room = rooms.get(roomId);
    if (room && room.has(sender)) {
      room.get(sender).handRaised = false;
      io.in(roomId).emit('user-lowered-hand', sender);
      const debouncedEmit = initDebouncedEmit(roomId);
      debouncedEmit();
    }
  });

  socket.on('kick-user', ({ roomId, targetUser, adminToken }) => {
    if (adminToken !== ADMIN_SECRET) return;
    const room = rooms.get(roomId);
    if (room && room.has(socket.id) && room.get(socket.id).isAdmin && room.has(targetUser)) {
      const user = room.get(targetUser);
      if (user.isScreenSharing) {
        io.in(roomId).emit('screen-share-ended', { sender: targetUser });
      }
      room.delete(targetUser);
      io.to(targetUser).emit('kicked');
      const debouncedEmit = initDebouncedEmit(roomId);
      debouncedEmit();
    }
  });

  socket.on('leave-room', ({ roomId, sender }) => {
    const room = rooms.get(roomId);
    if (room && room.has(sender)) {
      const user = room.get(sender);
      if (user.isAdmin && user.isScreenSharing) {
        io.in(roomId).emit('screen-share-ended', { sender });
      }
      const leavingUsername = user.username;
      room.delete(sender);
      const participants = getParticipants(roomId);
      if (room.size === 0) {
        rooms.delete(roomId);
        pendingJoins.delete(roomId);
        speakerStats.delete(roomId);
      } else {
        io.in(roomId).emit('user-left', { participants, username: leavingUsername });
        io.in(roomId).emit('participant-list', participants);
      }
      socket.leave(roomId);
    }
  });

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      const room = rooms.get(roomId);
      if (room && room.has(socket.id)) {
        const user = room.get(socket.id);
        if (user.isScreenSharing) {
          io.in(roomId).emit('screen-share-ended', { sender: socket.id });
        }
        room.delete(socket.id);
        const participants = getParticipants(roomId);
        if (room.size === 0) {
          rooms.delete(roomId);
          pendingJoins.delete(roomId);
          speakerStats.delete(roomId);
          debouncedParticipantUpdates.delete(roomId);
        } else {
          const debouncedEmit = initDebouncedEmit(roomId);
          debouncedEmit();
        }
      }
      const pendingRoom = pendingJoins.get(roomId);
      if (pendingRoom && pendingRoom.has(socket.id)) {
        pendingRoom.delete(socket.id);
        if (pendingRoom.size === 0) pendingJoins.delete(roomId);
        const admin = room?.values().find((p) => p.isAdmin);
        if (admin) {
          io.to(admin.id).emit('pending-join-cancelled', { userId: socket.id });
        }
      }
    }
    networkQualityStats.delete(socket.id);
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));