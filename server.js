const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const cors = require('cors');
const Room = require('./Room');
const https = require('https');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
const server = https.createServer({
  cert: fs.readFileSync('./ssl/cert.pem'),
  key: fs.readFileSync('./ssl/key.pem')
}, app);
// const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // Limit each IP to 100 requests per windowMs
}));
// Mediasoup settings
const mediasoupSettings = {
  worker: {
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp', 'rtx', 'bwe', 'score', 'simulcast'],
    announcedIp: '10.204.253.43'
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
          'x-google-start-bitrate': 1000,
          'x-google-min-bitrate': 500,
          'x-google-max-bitrate': 3000
        }
      },
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '42e01f',
          'level-asymmetry-allowed': 1,
          'x-google-start-bitrate': 1000,
          'x-google-min-bitrate': 500,
          'x-google-max-bitrate': 3000
        }
      }
    ]
  },
  webRtcTransportOptions: {
    listenIps: [
      {
        ip: '0.0.0.0',
        announcedIp: '10.204.253.43' // Will be set dynamically
      }
    ],
    initialAvailableOutgoingBitrate: 1000000,
    minimumAvailableOutgoingBitrate: 600000,
    maxIncomingBitrate: 1500000,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    enableSctp: true,
    iceConsentTimeout: 30,
    iceServers: [
      {
        urls: "stun:stun.relay.metered.ca:80",
      },
      {
        urls: "turn:global.relay.metered.ca:80",
        username: "809b412749942c1dd719a575",
        credential: "IGrizVaKruezuMCE",
      },
      {
        urls: "turn:global.relay.metered.ca:80?transport=tcp",
        username: "809b412749942c1dd719a575",
        credential: "IGrizVaKruezuMCE",
      },
      {
        urls: "turn:global.relay.metered.ca:443",
        username: "809b412749942c1dd719a575",
        credential: "IGrizVaKruezuMCE",
      },
      {
        urls: "turns:global.relay.metered.ca:443?transport=udp",
        username: "809b412749942c1dd719a575",
        credential: "IGrizVaKruezuMCE",
      },
    ],
    iceTransportPolicy: 'relay'

  }
};

// Worker pool management
const WORKER_POOL_SIZE = 4; // Number of workers based on CPU cores or needs
let workers = [];
let nextWorkerIndex = 0;
let rooms = new Map();
let consumerTracking = new Map(); // Track consumer assignments

async function createWorker() {
  const worker = await mediasoup.createWorker(mediasoupSettings.worker);

  worker.on('died', () => {
    console.error(`Mediasoup worker died (PID: ${worker.pid})`);
    // Remove dead worker and create new one
    workers = workers.filter(w => w !== worker);
    createWorker().then(newWorker => {
      workers.push(newWorker);
      console.log(`Replacement worker created (PID: ${newWorker.pid})`);
    });
  });

  return worker;
}

async function initializeWorkerPool() {
  for (let i = 0; i < WORKER_POOL_SIZE; i++) {
    const worker = await createWorker();
    workers.push(worker);
    console.log(`Worker ${i + 1} created (PID: ${worker.pid})`);
  }
}

function getNextWorker() {
  const worker = workers[nextWorkerIndex];
  nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
  return worker;
}

// Health check endpoint with worker pool status
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

// Consumer validation endpoint with tracking
app.post('/validate-consumer/:roomId', express.json(), (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const { producerId, rtpCapabilities, peerId } = req.body;

  if (!producerId || !rtpCapabilities || !peerId) {
    return res.status(400).json({ error: 'Missing producerId, rtpCapabilities, or peerId' });
  }

  try {
    // Check for existing consumer for this peer and producer
    const consumerKey = `${peerId}:${producerId}`;
    if (consumerTracking.has(consumerKey)) {
      return res.status(409).json({
        error: 'Consumer already exists for this peer and producer',
        existingConsumerId: consumerTracking.get(consumerKey)
      });
    }

    const canConsume = room.router.canConsume({
      producerId,
      rtpCapabilities
    });

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

  // Close all rooms
  for (const [roomId, room] of rooms) {
    room.getPeers().forEach(peer => room.removePeer(peer.id));
    rooms.delete(roomId);
    console.log(`Closed room ${roomId}`);
  }

  // Close all workers
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

    await initializeWorkerPool();

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

          // Assign worker from pool
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

          callback({
            success: true,
            roomId,
            users,
            isAdmin: true
          });

          const rtpCapabilities = room.getRouterRtpCapabilities();
          socket.emit('routerCapabilities', rtpCapabilities);
        } catch (err) {
          console.error('Error creating room:', err);
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

          console.log("handriaise", name, " is ", peer.handRaise);


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

        const { transport, params } = await room.createWebRtcTransport(socket.id, direction);
        // Store transport reference for cleanup
        room.storeTransport(socket.id, transport, direction);
        console.log(params,"checl");
        
        return { params };
      }));

      socket.on('connectTransport', wrapAsync(async ({ transportId, dtlsParameters }) => {
        const roomId = Array.from(socket.rooms).find(room => room !== socket.id);
        if (!roomId) throw new Error('Not in a room');

        const room = rooms.get(roomId);
        if (!room) throw new Error('Room not found');

        try {
          await room.connectTransport(socket.id, transportId, dtlsParameters);
          return { transportId };
        } catch (err) {
          logError('connectTransport', err, { socketId: socket.id, transportId });
          throw err;
        }
      }));

      socket.on('produce', wrapAsync(async ({ transportId, kind, rtpParameters, appData }) => {
        const roomId = Array.from(socket.rooms).find(room => room !== socket.id);
        if (!roomId) throw new Error('Not in a room');

        const room = rooms.get(roomId);
        if (!room) throw new Error('Room not found');

        try {
          const { producerId } = await room.produce(socket.id, transportId, kind, rtpParameters, appData);

          socket.to(roomId).emit('newProducer', {
            peerId: socket.id,
            producerId,
            kind,
            appData
          });

          return { producerId };
        } catch (err) {
          logError('produce', err, { socketId: socket.id, transportId, kind });
          throw err;
        }
      }));

      socket.on('consume', wrapAsync(async ({ transportId, producerId, rtpCapabilities }) => {
        const roomId = Array.from(socket.rooms).find(room => room !== socket.id);
        if (!roomId) throw new Error('Not in a room');

        const room = rooms.get(roomId);
        if (!room) throw new Error('Room not found');

        const transport = room.getTransport(socket.id, transportId);
        if (!transport || transport.closed) {
          throw new Error('Invalid or closed transport');
        }

        const consumerKey = `${socket.id}:${producerId}`;
        if (consumerTracking.has(consumerKey)) {
          const existingConsumerId = consumerTracking.get(consumerKey);
          const consumer = room.getConsumer(socket.id, existingConsumerId);
          if (consumer && !consumer.closed) {
            console.log(`Consumer already exists for peer ${socket.id}, producer ${producerId}`);
            // throw new Error('Consumer already exists for this producer');
          } else {
            console.log(`Cleaning up stale consumer for peer ${socket.id}, producer ${producerId}`);
            consumerTracking.delete(consumerKey);
            room.closeConsumer(socket.id, existingConsumerId);
          }
        }

        try {
          const { params, consumerId } = await room.consume(socket.id, transportId, producerId, rtpCapabilities);
          consumerTracking.set(consumerKey, consumerId);
          console.log(`Consumer created: ${consumerId} for peer ${socket.id}, producer ${producerId}`);
          return { params, consumerId };
        } catch (err) {
          logError('consume', err, { socketId: socket.id, transportId, producerId });
          throw err;
        }
      }));

      socket.on('resumeConsumer', wrapAsync(async ({ consumerId }) => {
        const roomId = Array.from(socket.rooms).find(room => room !== socket.id);
        if (!roomId) throw new Error('Not in a room');

        const room = rooms.get(roomId);
        if (!room) throw new Error('Room not found');

        try {
          await room.resumeConsumer(socket.id, consumerId);
          console.log(`Consumer resumed: ${consumerId} for peer ${socket.id}`);
          return { consumerId };
        } catch (err) {
          logError('resumeConsumer', err, { socketId: socket.id, consumerId });
          throw err;
        }
      }));

      socket.on('reconnect', async ({ peerId, roomId }, callback) => {
        try {
          const room = rooms.get(roomId);
          if (!room) {
            return callback({ success: false, error: 'Room not found' });
          }

          if (room.getPeers().has(peerId)) {
            // Clean up stale consumer entries for this peer
            const consumerKeys = Array.from(consumerTracking.keys())
              .filter(key => key.startsWith(`${peerId}:`));
            consumerKeys.forEach(key => {
              const consumerId = consumerTracking.get(key);
              room.closeConsumer(peerId, consumerId);
              consumerTracking.delete(key);
            });

            // Clean up transports
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

            // Clean up consumer tracking
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