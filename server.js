const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

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
const MAX_USERS_PER_ROOM = 50;
const rooms = new Map();
const pendingJoins = new Map();
const activeScreenShares = new Map(); // Map to track active screen share per room

const getParticipants = (roomId) => {
  const participants = rooms.get(roomId) || [];
  return Array.from(participants.values()).map((p) => ({
    id: p.id,
    isAdmin: p.isAdmin,
    username: p.username,
    handRaised: p.handRaised,
    isMuted: p.isMuted,
    isVideoOff: p.isVideoOff,
    isScreenSharing: p.isScreenSharing || false,
  }));
};

io.on('connection', (socket) => {
  console.log('New user connected:', socket.id);

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
        isAdmin,
        username: username || socket.id,
        handRaised: false,
        isMuted: false,
        isVideoOff: false,
        isScreenSharing: false,
      }]
    ]));
    socket.join(roomId);
    io.in(roomId).emit('participant-list', getParticipants(roomId));
    callback({ roomId });
  });

  socket.on('request-to-join', ({ roomId, username }, callback) => {
    if (!rooms.has(roomId)) {
      callback({ error: 'Room does not exist.' });
      return;
    }
    const room = rooms.get(roomId);
    if (room.size >= MAX_USERS_PER_ROOM) {
      callback({ error: 'Room is full.' });
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

  socket.on('admit-user', ({ roomId, adminToken, userId }, callback) => {
    if (adminToken !== ADMIN_SECRET) {
      callback({ error: 'Unauthorized action!' });
      return;
    }
    const room = rooms.get(roomId);
    if (!room || !room.get(socket.id)?.isAdmin) {
      callback({ error: 'Only admin can admit users!' });
      return;
    }
    const pendingRoom = pendingJoins.get(roomId);
    if (pendingRoom?.has(userId)) {
      const username = pendingRoom.get(userId);
      room.set(userId, {
        id: userId,
        joinedAt: Date.now(),
        isAdmin: false,
        username: username || userId,
        handRaised: false,
        isMuted: false,
        isVideoOff: false,
        isScreenSharing: false,
      });
      pendingRoom.delete(userId);
      if (pendingRoom.size === 0) pendingJoins.delete(roomId);

      io.in(roomId).emit('participant-list', getParticipants(roomId));
      io.to(userId).emit('join-approved');
      callback({ success: true });
    }
  });

  // Admin media control
  socket.on('toggle-media', ({ roomId, type, state }) => {
    const room = rooms.get(roomId);
    if (room?.has(socket.id)) {
      const user = room.get(socket.id);
      if (type === 'audio') {
        user.isMuted = state;
        io.to(socket.id).emit(state ? 'mute-audio' : 'unmute-audio');
      } else if (type === 'video') {
        user.isVideoOff = state;
        io.to(socket.id).emit(state ? 'disable-video' : 'enable-video');
      }
      io.in(roomId).emit('participant-list', getParticipants(roomId));
    }
  });

  // Admin control over user media
  socket.on('control-user-media', ({ roomId, targetUser, type, state }) => {
    const room = rooms.get(roomId);
    if (room?.get(socket.id)?.isAdmin && room.has(targetUser)) {
      const user = room.get(targetUser);
      if (type === 'audio') {
        user.isMuted = state;
        io.to(targetUser).emit(state ? 'mute-audio' : 'unmute-audio');
      } else if (type === 'video') {
        user.isVideoOff = state;
        io.to(targetUser).emit(state ? 'disable-video' : 'enable-video');
      }
      io.in(roomId).emit('participant-list', getParticipants(roomId));
    }
  });

  // Admin kick user
  socket.on('kick-user', ({ roomId, targetUser }) => {
    const room = rooms.get(roomId);
    if (room?.get(socket.id)?.isAdmin && room.has(targetUser)) {
      const targetUserData = room.get(targetUser);
      room.delete(targetUser);
      io.to(targetUser).emit('kicked');
      socket.to(roomId).emit('user-left', { 
        participants: getParticipants(roomId), 
        username: targetUserData.username 
      });
      if (activeScreenShares.get(roomId) === targetUser) {
        activeScreenShares.delete(roomId);
        io.in(roomId).emit('screen-share-ended', { sender: targetUser });
      }
    }
  });

  // Screen sharing
  socket.on('request-screen-share', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room?.has(socket.id)) return;

    if (activeScreenShares.has(roomId)) {
      socket.emit('error', { message: 'Another user is already sharing their screen in this room.' });
      return;
    }

    const user = room.get(socket.id);
    if (user.isAdmin) {
      user.isScreenSharing = true;
      activeScreenShares.set(roomId, socket.id);
      io.in(roomId).emit('start-screen-share', { sender: socket.id });
      io.in(roomId).emit('participant-list', getParticipants(roomId));
    } else {
      const admin = Array.from(room.values()).find(p => p.isAdmin);
      io.to(admin.id).emit('screen-share-request', { userId: socket.id, username: user.username });
    }
  });

  socket.on('approve-screen-share', ({ roomId, userId }) => {
    const room = rooms.get(roomId);
    if (!room?.get(socket.id)?.isAdmin || !room.has(userId)) return;

    if (activeScreenShares.has(roomId)) {
      socket.emit('error', { message: 'Another user is already sharing their screen in this room.' });
      return;
    }

    const user = room.get(userId);
    user.isScreenSharing = true;
    activeScreenShares.set(roomId, userId);
    io.in(roomId).emit('start-screen-share', { sender: userId });
    io.in(roomId).emit('participant-list', getParticipants(roomId));
  });

  socket.on('stop-screen-share', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room?.has(socket.id) && room.get(socket.id).isScreenSharing) {
      room.get(socket.id).isScreenSharing = false;
      activeScreenShares.delete(roomId);
      io.in(roomId).emit('screen-share-ended', { sender: socket.id });
      io.in(roomId).emit('participant-list', getParticipants(roomId));
    }
  });

  // SFU signaling
  socket.on('signal', ({ roomId, signal, target, streamType }) => {
    const room = rooms.get(roomId);
    if (room?.has(target)) {
      io.to(target).emit('signal', { signal, sender: socket.id, streamType });
    }
  });

  socket.on('ice-candidate', ({ roomId, candidate, target, streamType }) => {
    const room = rooms.get(roomId);
    if (room?.has(target)) {
      io.to(target).emit('ice-candidate', { candidate, sender: socket.id, streamType });
    }
  });

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      const room = rooms.get(roomId);
      if (room?.has(socket.id)) {
        const user = room.get(socket.id);
        room.delete(socket.id);
        if (room.size === 0) {
          rooms.delete(roomId);
          activeScreenShares.delete(roomId);
        }
        io.in(roomId).emit('participant-list', getParticipants(roomId));
        if (activeScreenShares.get(roomId) === socket.id) {
          activeScreenShares.delete(roomId);
          io.in(roomId).emit('screen-share-ended', { sender: socket.id });
        }
      }
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`User disconnected: ${socket.id}. Reason:`, reason);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));