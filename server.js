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
  // Optimize socket.io for high concurrency
  transports:['websocket'],
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e8, // Increase buffer for video streams
});

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'supersecretkey';
const MAX_USERS_PER_ROOM = 50; // Set a reasonable limit to prevent overload
const rooms = new Map(); // Use Map for O(1) lookups
const pendingJoins = new Map();

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

  socket.on('error', (error) => console.error('Socket error:', socket.id, error));

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
        username: username || userId,
        handRaised: false,
        isMuted: false,
        isVideoOff: false,
        isScreenSharing: false,
      });
      pendingRoom.delete(userId);
      if (pendingRoom.size === 0) pendingJoins.delete(roomId);

      const participants = getParticipants(roomId);
      io.in(roomId).emit('participant-list', participants);
      io.to(userId).emit('join-approved');
      socket.to(roomId).emit('user-joined', { userId, participants });

      const admin = room.get(socket.id);
      if (admin.isScreenSharing) {
        io.to(admin.id).emit('initiate-screen-share-peer', { targetUser: userId });
      }
      callback({ success: true });
    } else {
      callback({ error: 'User not found or already admitted.' });
    }
  });

  socket.on('start-screen-share', ({ roomId, sender }) => {
    const room = rooms.get(roomId);
    if (room && room.has(sender)) {
      const admin = room.get(sender);
      if (admin.isAdmin) {
        admin.isScreenSharing = true;
        io.in(roomId).emit('participant-list', getParticipants(roomId));
        io.in(roomId).emit('start-screen-share', { sender });
      } else {
        socket.emit('error', { message: 'Only admin can start screen sharing.' });
      }
    } else {
      socket.emit('error', { message: 'Room not found.' });
    }
  });

  socket.on('stop-screen-share', ({ roomId, sender }) => {
    const room = rooms.get(roomId);
    if (room && room.has(sender)) {
      const admin = room.get(sender);
      if (admin.isAdmin) {
        admin.isScreenSharing = false;
        io.in(roomId).emit('participant-list', getParticipants(roomId));
        io.in(roomId).emit('screen-share-ended', { sender });
      } else {
        socket.emit('error', { message: 'Only admin can stop screen sharing.' });
      }
    } else {
      socket.emit('error', { message: 'Room not found.' });
    }
  });

  socket.on('send-message', ({ roomId, message, sender }) => {
    if (rooms.has(roomId)) {
      const timestamp = new Date();
      io.in(roomId).emit('receive-message', { sender, message, Wtimestamp });
    } else {
      socket.emit('error', { message: 'Room not found.' });
    }
  });

  socket.on('signal', ({ roomId, signal, sender, target, streamType }) => {
    const room = rooms.get(roomId);
    if (room && room.has(target)) {
      io.to(target).emit('signal', { signal, sender, streamType });
    } else {
      socket.emit('error', { message: `Signal failed: Target ${target} not found in room ${roomId}` });
    }
  });

  socket.on('ice-candidate', ({ roomId, candidate, sender, target, streamType }) => {
    const room = rooms.get(roomId);
    if (room && room.has(target)) {
      io.to(target).emit('ice-candidate', { candidate, sender, streamType });
    } else {
      socket.emit('error', { message: `ICE candidate failed: Target ${target} not found in room ${roomId}` });
    }
  });

  socket.on('mute-user', ({ roomId, targetUser }) => {
    // if (adminToken !== ADMIN_SECRET || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room.has(socket.id) && room.get(socket.id).isAdmin && room.has(targetUser)) {
      const user = room.get(targetUser);
      user.isMuted = true;
      io.to(targetUser).emit('mute-audio');
      io.in(roomId).emit('participant-list', getParticipants(roomId));
    }
  });

  socket.on('unmute-user', ({ roomId, targetUser }) => {
    // if (adminToken !== ADMIN_SECRET || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room.has(socket.id) && room.get(socket.id).isAdmin && room.has(targetUser)) {
      const user = room.get(targetUser);
      user.isMuted = false;
      io.to(targetUser).emit('unmute-audio');
      io.in(roomId).emit('participant-list', getParticipants(roomId));
    }
  });

  socket.on('disable-video', ({ roomId, targetUser }) => {
    // if (adminToken !== ADMIN_SECRET || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room.has(socket.id) && room.get(socket.id).isAdmin && room.has(targetUser)) {
      const user = room.get(targetUser);
      user.isVideoOff = true;
      io.to(targetUser).emit('disable-video');
      io.in(roomId).emit('participant-list', getParticipants(roomId));
    }
  });

  socket.on('enable-video', ({ roomId, targetUser }) => {
    // if (adminToken !== ADMIN_SECRET || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room.has(socket.id) && room.get(socket.id).isAdmin && room.has(targetUser)) {
      const user = room.get(targetUser);
      user.isVideoOff = false;
      io.to(targetUser).emit('enable-video');
      io.in(roomId).emit('participant-list', getParticipants(roomId));
    }
  });

  socket.on('raise-hand', ({ roomId, sender }) => {
    const room = rooms.get(roomId);
    if (room && room.has(sender)) {
      room.get(sender).handRaised = true;
      io.in(roomId).emit('user-raised-hand', sender);
      io.in(roomId).emit('participant-list', getParticipants(roomId));
    }
  });

  socket.on('lower-hand', ({ roomId, sender }) => {
    const room = rooms.get(roomId);
    if (room && room.has(sender)) {
      room.get(sender).handRaised = false;
      io.in(roomId).emit('user-lowered-hand', sender);
      io.in(roomId).emit('participant-list', getParticipants(roomId));
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
        if (user.isAdmin && user.isScreenSharing) {
          io.in(roomId).emit('screen-share-ended', { sender: socket.id });
        }
        const leavingUsername = user.username;
        room.delete(socket.id);
        const participants = getParticipants(roomId);
        if (room.size === 0) {
          rooms.delete(roomId);
          pendingJoins.delete(roomId);
        } else {
          io.in(roomId).emit('user-left', { participants, username: leavingUsername });
          io.in(roomId).emit('participant-list', participants);
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
  });

  socket.on('disconnect', (reason) => {
    console.log(`User disconnected: ${socket.id}. Reason:`, reason);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));