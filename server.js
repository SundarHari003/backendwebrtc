const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const cors = require('cors');
const axios = require('axios');
const Room = require('./Room');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

async function getPublicIp() {
  try {
    const response = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
    console.log(`Fetched public IP: ${response.data.ip}`);
    return response.data.ip;
  } catch (error) {
    console.error('Error fetching public IP:', error.message);
    return process.env.RENDER_EXTERNAL_IP || '0.0.0.0'; // Fallback to env variable or default
  }
}

// Mediasoup settings
async function initializeMediasoupSettings() {
  const publicIp = await getPublicIp();
  return {
    worker: {
      rtcMinPort: 10000,
      rtcMaxPort: 20000,
      logLevel: 'debug', // Set to debug for detailed logs
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
      announcedIp: publicIp
    },
    router: {
      mediaCodecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
          parameters: {
            minptime: 10,
            useinbandfec: 1
          }
        },
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: {
            'x-google-start-bitrate': 1000
          }
        },
        {
          kind: 'video',
          mimeType: 'video/H264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',
            'level-asymmetry-allowed': 1
          }
        }
      ]
    }
  };
}

// Worker pool management
const WORKER_POOL_SIZE = 4;
let workers = [];
let nextWorkerIndex = 0;
let rooms = new Map();
let consumerTracking = new Map();

async function createWorker(settings) {
  const worker = await mediasoup.createWorker({
    ...settings.worker,
    appData: { announcedIp: settings.worker.announcedIp }
  });
  worker.on('died', () => {
    console.error(`Mediasoup worker died (PID: ${worker.pid})`);
    workers = workers.filter(w => w !== worker);
    createWorker(settings).then(newWorker => {
      workers.push(newWorker);
      console.log(`Replacement worker created (PID: ${newWorker.pid})`);
    });
  });
  return worker;
}

async function initializeWorkerPool(settings) {
  for (let i = 0; i < WORKER_POOL_SIZE; i++) {
    const worker = await createWorker(settings);
    workers.push(worker);
    console.log(`Worker ${i + 1} created (PID: ${worker.pid}, announcedIp: ${settings.worker.announcedIp})`);
  }
}

function getNextWorker() {
  const worker = workers[nextWorkerIndex];
  nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
  return worker;
}

// Health check endpoint
app.get('/health', (req, res) => {
  const roomStatus = Array.from(rooms.values()).map(room => ({
    roomId: room.roomId,
    peers: room.getPeers().size,
    health: room.checkHealth(),
    workerPid: room.worker.pid
  }));
  res.json({
    status: 'ok',
    mediasoupVersion: mediasoup.version,
    workers: workers.map(w => ({ pid: w.pid, alive: !w.closed })),
    rooms: roomStatus
  });
});

// Consumer validation endpoint
app.post('/validate-consumer/:roomId', express.json(), (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const { producerId, rtpCapabilities, peerId } = req.body;
  if (!producerId || !rtpCapabilities || !peerId) {
    return res.status(400).json({ error: 'Missing producerId, rtpCapabilities, or peerId' });
  }

  try {
    const consumerKey = `${peerId}:${producerId}`;
    if (consumerTracking.has(consumerKey)) {
      return res.status(409).json({
        error: 'Consumer already exists for this peer and producer',
        existingConsumerId: consumerTracking.get(consumerKey)
      });
    }
    const canConsume = room.router.canConsume({ producerId, rtpCapabilities });
    res.json({
      canConsume,
      routerCapabilities: room.getRouterRtpCapabilities()
    });
  } catch (err) {
    res.status(400).json({
      error: err.message,
      details: { producerId, rtpCapabilities, peerId }
    });
  }
});

// Graceful shutdown handler
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  for (const [roomId, room] of rooms) {
    room.getPeers().forEach(peer => room.removePeer(peer.id));
    rooms.delete(roomId);
    console.log(`Closed room ${roomId}`);
  }
  await Promise.all(workers.map(async worker => {
    if (!worker.closed) {
      await worker.close();
      console.log(`Worker closed (PID: ${worker.pid})`);
    }
  }));
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

// Initialize server
async function startServer() {
  try {
    console.log(`Starting server with mediasoup v${mediasoup.version}`);
    const mediasoupSettings = await initializeMediasoupSettings();
    await initializeWorkerPool(mediasoupSettings);

    io.on('connection', async (socket) => {
      console.log('Client connected:', socket.id);

      const wrapAsync = (fn) => async (data, callback) => {
        try {
          const result = await fn(data);
          callback({ success: true, ...result });
        } catch (err) {
          console.error(`Error in ${fn.name || 'handler'}:`, err);
          callback({
            success: false,
            error: err.message,
            details: data
          });
        }
      };

      const logError = (context, error, details = {}) => {
        console.error({
          timestamp: new Date().toISOString(),
          context,
          message: error.message,
          stack: error.stack,
          details
        });
      };

      socket.on('createRoom', async ({ roomId, name }, callback) => {
        try {
          if (rooms.has(roomId)) {
            return callback({ success: false, error: 'Room already exists' });
          }
          const worker = getNextWorker();
          const router = await worker.createRouter({
            mediaCodecs: mediasoupSettings.router.mediaCodecs
          });
          rooms.set(roomId, new Room(router, roomId, worker));
          const room = rooms.get(roomId);
          const peerDetails = {
            id: socket.id,
            name: name || 'Admin',
            isAdmin: true,
            handRaise: false,
            isVideoOn: true,
            isAudioOn: true,
            sharingScreen: false,
            isAdmitted: true,
            pendingApproval: false
          };
          await room.addPeer(socket.id, peerDetails);
          socket.join(roomId);
          const users = Array.from(room.getPeers().values());
          callback({ success: true, roomId, users, isAdmin: true });
          const rtpCapabilities = room.getRouterRtpCapabilities();
          console.log('Emitting routerCapabilities:', rtpCapabilities);
          socket.emit('routerCapabilities', rtpCapabilities);
        } catch (err) {
          console.error('Error in createRoom:', err);
          callback({ success: false, error: err.message });
        }
      });

      socket.on('request-to-join', async ({ roomId, name }, callback) => {
        try {
          const room = rooms.get(roomId);
          if (!room) {
            return callback({ success: false, error: 'Room not found' });
          }
          const peerDetails = {
            id: socket.id,
            name: name || 'Anonymous',
            isAdmin: false,
            handRaise: false,
            isVideoOn: true,
            isAudioOn: true,
            sharingScreen: false,
            isAdmitted: false,
            pendingApproval: true
          };
          room.addPendingPeer(socket.id, peerDetails);
          const admins = Array.from(room.getPeers().values())
            .filter(peer => peer.isAdmin)
            .map(peer => peer.id);
          admins.forEach(adminId => {
            io.to(adminId).emit('join-request', {
              peerId: socket.id,
              name: peerDetails.name
            });
          });
          callback({
            success: true,
            message: 'Join request sent to admin'
          });
        } catch (err) {
          callback({ success: false, error: err.message });
        }
      });

      socket.on('admit-participant', async ({ roomId, peerId }, callback) => {
        try {
          const room = rooms.get(roomId);
          if (!room) {
            return callback({ success: false, error: 'Room not found' });
          }
          const adminPeer = room.getPeerDetails(socket.id);
          if (!adminPeer?.isAdmin) {
            return callback({ success: false, error: 'Unauthorized' });
          }
          const pendingPeer = room.getPendingPeer(peerId);
          if (!pendingPeer) {
            return callback({ success: false, error: 'Pending peer not found' });
          }
          pendingPeer.isAdmitted = true;
          pendingPeer.pendingApproval = false;
          await room.addPeer(peerId, pendingPeer);
          room.removePendingPeer(peerId);
          io.to(peerId).emit('admitted', {
            roomId,
            rtpCapabilities: room.getRouterRtpCapabilities()
          });
          const users = Array.from(room.getPeers().values());
          io.to(roomId).emit('participants-updated', { users });
          callback({ success: true });
        } catch (err) {
          callback({ success: false, error: err.message });
        }
      });

      socket.on('toggle-media', async ({ roomId, type, enabled, name }, callback) => {
        try {
          const room = rooms.get(roomId);
          if (!room) {
            return callback({ success: false, error: 'Room not found' });
          }
          const peer = room.getPeerDetails(socket.id);
          if (!peer) {
            return callback({ success: false, error: 'Peer not found' });
          }
          if (type === 'video') {
            peer.isVideoOn = enabled;
          } else if (type === 'audio') {
            peer.isAudioOn = enabled;
          }
          room.updatePeerDetails(socket.id, peer);
          io.to(roomId).emit('peer-media-toggle', {
            peerId: socket.id,
            type,
            enabled,
            peerName: name
          });
          callback({ success: true });
        } catch (err) {
          callback({ success: false, error: err.message });
        }
      });

      socket.on('toggle-handraise', async ({ roomId, enabled, name }, callback) => {
        try {
          const room = rooms.get(roomId);
          if (!room) {
            return callback({ success: false, error: 'Room not found' });
          }
          const peer = room.getPeerDetails(socket.id);
          if (!peer) {
            return callback({ success: false, error: 'Peer not found' });
          }
          peer.handRaise = enabled;
          room.updatePeerDetails(socket.id, peer);
          io.to(roomId).emit('handraise-toggle', {
            peerId: socket.id,
            enabled,
            peerName: name
          });
          console.log("handraise", name, " is ", peer.handRaise);
          callback({ success: true });
        } catch (err) {
          callback({ success: false, error: err.message });
        }
      });

      socket.on('toggle-screenshare', async ({ roomId, enabled, name }, callback) => {
        try {
          const room = rooms.get(roomId);
          if (!room) {
            return callback({ success: false, error: 'Room not found' });
          }
          const peer = room.getPeerDetails(socket.id);
          if (!peer) {
            return callback({ success: false, error: 'Peer not found' });
          }
          peer.sharingScreen = enabled;
          room.updatePeerDetails(socket.id, peer);
          io.to(roomId).emit('screenshare-toggle', {
            peerId: socket.id,
            enabled,
            peerName: name
          });
          callback({ success: true });
        } catch (err) {
          callback({ success: false, error: err.message });
        }
      });

      socket.on('send-message', async ({ roomId, message }, callback) => {
        try {
          const room = rooms.get(roomId);
          if (!room) {
            return callback({ success: false, error: 'Room not found' });
          }
          const peer = room.getPeerDetails(socket.id);
          if (!peer) {
            return callback({ success: false, error: 'Peer not found' });
          }
          const messageData = {
            senderId: socket.id,
            senderName: peer.name,
            message,
            timestamp: new Date().toISOString()
          };
          io.to(roomId).emit('new-message', messageData);
          callback({ success: true });
        } catch (err) {
          callback({ success: false, error: err.message });
        }
      });

      socket.on('get-participants', async ({ roomId }, callback) => {
        try {
          const room = rooms.get(roomId);
          if (!room) {
            return callback({ success: false, error: 'Room not found' });
          }
          const participants = Array.from(room.getPeers().values()).map(peer => ({
            id: peer.id,
            name: peer.name,
            isAdmin: peer.isAdmin,
            isVideoOn: peer.isVideoOn,
            isAudioOn: peer.isAudioOn,
            sharingScreen: peer.sharingScreen,
            handRaise: peer.handRaise
          }));
          callback({
            success: true,
            participants
          });
        } catch (err) {
          callback({ success: false, error: err.message });
        }
      });

      socket.on('joinRoom', async ({ roomId, name }, callback) => {
        try {
          console.log(`${name} (${socket.id}) joining room ${roomId}`);
          if (!rooms.has(roomId)) {
            return callback({ success: false, error: 'Room does not exist' });
          }
          Array.from(socket.rooms).forEach(room => {
            if (room !== socket.id) socket.leave(room);
          });
          const room = rooms.get(roomId);
          const peerDetails = {
            id: socket.id,
            name: name || 'Anonymous',
            isAdmin: false,
            handRaise: false,
            isVideoOn: true,
            isAudioOn: true,
            sharingScreen: false
          };
          await room.addPeer(socket.id, peerDetails);
          socket.join(roomId, () => {
            console.log(`Socket ${socket.id} joined room ${roomId}`);
          });
          const users = Array.from(room.getPeers().values()).map(peer => ({
            id: peer.id,
            name: peer.name,
            isAdmin: peer.isAdmin,
            handRaise: peer.handRaise,
            isVideoOn: peer.isVideoOn,
            isAudioOn: peer.isAudioOn,
            sharingScreen: peer.sharingScreen
          }));
          io.to(roomId).emit('participants-updated', {
            users,
            joiningPeer: {
              peerId: socket.id,
              ...peerDetails
            }
          });
          callback({
            success: true,
            users,
            currentPeer: peerDetails
          });
          const rtpCapabilities = room.getRouterRtpCapabilities();
          socket.emit('routerCapabilities', rtpCapabilities);
          const producers = room.getProducerList();
          socket.emit('producerList', producers);
        } catch (err) {
          console.error('Error joining room:', err);
          callback({ success: false, error: err.message });
        }
      });

      socket.on('createWebRtcTransport', wrapAsync(async ({ direction }) => {
        const roomId = Array.from(socket.rooms).find(room => room !== socket.id);
        if (!roomId) throw new Error('Not in a room');
        const room = rooms.get(roomId);
        if (!room) throw new Error('Room not found');
        console.log(`Creating ${direction} transport for socket ${socket.id} in room ${roomId}`);
        const { transport, params } = await room.createWebRtcTransport(socket.id, direction);
        room.storeTransport(socket.id, transport, direction);
        console.log(`Created ${direction} transport:`, params);
        return { params };
      }));

      socket.on('connectTransport', wrapAsync(async ({ transportId, dtlsParameters }) => {
        const roomId = Array.from(socket.rooms).find(room => room !== socket.id);
        if (!roomId) throw new Error('Not in a room');
        const room = rooms.get(roomId);
        if (!room) throw new Error('Room not found');
        console.log(`Connecting transport ${transportId} for socket ${socket.id}`);
        await room.connectTransport(socket.id, transportId, dtlsParameters);
        console.log(`Connected transport ${transportId}`);
        return { transportId };
      }));

      socket.on('produce', wrapAsync(async ({ transportId, kind, rtpParameters, appData }) => {
        const roomId = Array.from(socket.rooms).find(room => room !== socket.id);
        if (!roomId) throw new Error('Not in a room');
        const room = rooms.get(roomId);
        if (!room) throw new Error('Room not found');
        const { producerId } = await room.produce(socket.id, transportId, kind, rtpParameters, appData);
        socket.to(roomId).emit('newProducer', {
          peerId: socket.id,
          producerId,
          kind,
          appData
        });
        return { producerId };
      }));

      socket.on('consume', wrapAsync(async ({ transportId, producerId, rtpCapabilities }) => {
        const roomId = Array.from(socket.rooms).find(room => room !== socket.id);
        if (!roomId) throw new Error('Not in a room');
        const room = rooms.get(roomId);
        if (!room) throw new Error('Room not found');
        console.log(`Consuming for socket ${socket.id}, transport ${transportId}, producer ${producerId}`);
        const transport = room.getTransport(socket.id, transportId);
        if (!transport || transport.closed) {
          throw new Error('Invalid or closed transport');
        }
        const consumerKey = `${socket.id}:${producerId}`;
        if (consumerTracking.has(consumerKey)) {
          const existingConsumerId = consumerTracking.get(consumerKey);
          const consumer = room.getConsumer(socket.id, existingConsumerId);
          if (consumer && !consumer.closed) {
            throw new Error('Consumer already exists for this producer');
          } else {
            consumerTracking.delete(consumerKey);
            room.closeConsumer(socket.id, existingConsumerId);
          }
        }
        const { params, consumerId } = await room.consume(socket.id, transportId, producerId, rtpCapabilities);
        consumerTracking.set(consumerKey, consumerId);
        console.log(`Created consumer ${consumerId} for socket ${socket.id}`);
        return { params, consumerId };
      }));

      socket.on('resumeConsumer', wrapAsync(async ({ consumerId }) => {
        const roomId = Array.from(socket.rooms).find(room => room !== socket.id);
        if (!roomId) throw new Error('Not in a room');
        const room = rooms.get(roomId);
        if (!room) throw new Error('Room not found');
        await room.resumeConsumer(socket.id, consumerId);
        return { consumerId };
      }));

      socket.on('reconnect', async ({ peerId, roomId }, callback) => {
        try {
          console.log(`Reconnecting peer ${peerId} to room ${roomId}`);
          const room = rooms.get(roomId);
          if (!room) {
            return callback({ success: false, error: 'Room not found' });
          }
          if (room.getPeers().has(peerId)) {
            const consumerKeys = Array.from(consumerTracking.keys())
              .filter(key => key.startsWith(`${peerId}:`));
            consumerKeys.forEach(key => {
              const consumerId = consumerTracking.get(key);
              room.closeConsumer(peerId, consumerId);
              consumerTracking.delete(key);
            });
            room.closeTransports(peerId);
            await room.updatePeerSocket(peerId, socket.id);
            await socket.join(roomId);
            const rtpCapabilities = room.getRouterRtpCapabilities();
            socket.emit('routerCapabilities', rtpCapabilities);
            const producers = room.getProducerList();
            socket.emit('producerList', producers);
            callback({ success: true });
          } else {
            callback({ success: false, error: 'Peer not found' });
          }
        } catch (err) {
          console.error('Error in reconnect:', err);
          callback({ success: false, error: err.message });
        }
      });

      socket.on('updatePeerProperties', async ({ property, value }, callback) => {
        try {
          const roomId = Array.from(socket.rooms).find(room => room !== socket.id);
          if (!roomId) throw new Error('Not in a room');
          const room = rooms.get(roomId);
          if (!room) throw new Error('Room not found');
          const peer = room.getPeerDetails(socket.id);
          if (!peer) throw new Error('Peer not found');
          peer[property] = value;
          room.updatePeerDetails(socket.id, peer);
          socket.to(roomId).emit('peerPropertiesUpdated', {
            peerId: socket.id,
            property,
            value
          });
          callback({ success: true });
        } catch (err) {
          console.error('Error updating peer properties:', err);
          callback({ success: false, error: err.message });
        }
      });

      socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
        Array.from(rooms.entries()).forEach(([roomId, room]) => {
          if (room.getPeers().has(socket.id)) {
            const peerDetails = room.getPeerDetails(socket.id);
            const peerName = peerDetails ? peerDetails.name : 'Unknown';
            const consumerKeys = Array.from(consumerTracking.keys())
              .filter(key => key.startsWith(`${socket.id}:`));
            consumerKeys.forEach(key => {
              const consumerId = consumerTracking.get(key);
              room.closeConsumer(socket.id, consumerId);
              consumerTracking.delete(key);
            });
            room.closeTransports(socket.id);
            room.removePeer(socket.id);
            socket.to(roomId).emit('peerClosed', { peerId: socket.id, peerName });
            if (room.getPeers().size === 0) {
              rooms.delete(roomId);
              console.log(`Room ${roomId} closed (no more peers)`);
            }
          }
        });
      });
    });

    const PORT = process.env.PORT || 3001;
    server.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
      console.log(`Worker pool initialized with ${WORKER_POOL_SIZE} workers`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();