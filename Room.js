const EventEmitter = require('events');
const os = require('os');
const ifaces = os.networkInterfaces()

const getLocalIp = () => {
    let localIp = '127.0.0.1'
    Object.keys(ifaces).forEach((ifname) => {
        for (const iface of ifaces[ifname]) {
            // Ignore IPv6 and 127.0.0.1
            if (iface.family !== 'IPv4' || iface.internal !== false) {
                continue
            }
            // Set the local ip to the first IPv4 address found and exit the loop
            localIp = iface.address
            console.log(`Local IP: ${localIp}`);
            
            return
        }
    })
    return localIp
}
const localIp = getLocalIp();
class Room extends EventEmitter {
  constructor(router, roomId, worker) {
    super();
    this.router = router;
    this.roomId = roomId;
    this.worker = worker;
    this.peers = new Map();
    this.pendingPeers = new Map();
    this.producers = new Map();
    this.consumers = new Map();
    this.transports = new Map();
    this.createdAt = Date.now();
  }

  addPendingPeer(peerId, details) {
    this.pendingPeers.set(peerId, details);
  }

  removePendingPeer(peerId) {
    this.pendingPeers.delete(peerId);
  }

  getPendingPeer(peerId) {
    return this.pendingPeers.get(peerId);
  }

  getPendingPeers() {
    return this.pendingPeers;
  }

  getRouterRtpCapabilities() {
    if (!this.router || !this.router.rtpCapabilities) {
      throw new Error('Router not initialized');
    }

    // Return the full router capabilities without filtering
    return this.router.rtpCapabilities;
  }

  storeTransport(peerId, transport, direction) {
    if (!this.transports.has(peerId)) {
      this.transports.set(peerId, new Map());
    }
    this.transports.get(peerId).set(transport.id, { transport, direction });
  }

  getTransport(peerId, transportId) {
    return this.transports.get(peerId)?.get(transportId)?.transport;
  }

  closeTransports(peerId) {
    const peerTransports = this.transports.get(peerId);
    if (peerTransports) {
      for (const [transportId, { transport }] of peerTransports) {
        if (!transport.closed) {
          transport.close();
        }
      }
      this.transports.delete(peerId);
    }
  }

  getConsumer(peerId, consumerId) {
    return this.consumers.get(peerId)?.get(consumerId);
  }

  closeConsumer(peerId, consumerId) {
    const peerConsumers = this.consumers.get(peerId);
    if (peerConsumers) {
      const consumer = peerConsumers.get(consumerId);
      if (consumer && !consumer.closed) {
        consumer.close();
      }
      peerConsumers.delete(consumerId);
      if (peerConsumers.size === 0) {
        this.consumers.delete(peerId);
      }
    }
  }

  async addPeer(peerId, peerDetails) {
    this.peers.set(peerId, {
      id: peerId,
      ...peerDetails,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
      joinedAt: Date.now()
    });

    this.emit('peerJoined', peerId);
    return this.peers.get(peerId);
  }

  getPeerDetails(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return null;

    return {
      id: peer.id,
      name: peer.name,
      isAdmin: peer.isAdmin,
      handRaise: peer.handRaise,
      isVideoOn: peer.isVideoOn,
      isAudioOn: peer.isAudioOn,
      sharingScreen: peer.sharingScreen
    };
  }

  updatePeerDetails(peerId, updates) {
    if (this.peers.has(peerId)) {
      this.peers.set(peerId, { ...this.peers.get(peerId), ...updates });
      return true;
    }
    return false;
  }

  getPeers() {
    return this.peers;
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return false;

    // Close all transports
    peer.transports.forEach(({ transport }) => {
      try {
        transport.close();
      } catch (err) {
        console.error(`Error closing transport for peer ${peerId}:`, err);
      }
    });

    // Close all producers
    peer.producers.forEach(producer => {
      try {
        producer.close();
      } catch (err) {
        console.error(`Error closing producer for peer ${peerId}:`, err);
      }
    });

    // Close all consumers
    peer.consumers.forEach(consumer => {
      try {
        consumer.close();
      } catch (err) {
        console.error(`Error closing consumer for peer ${peerId}:`, err);
      }
    });

    this.peers.delete(peerId);
    this.emit('peerLeft', peerId);

    return true;
  }

  async updatePeerSocket(oldPeerId, newPeerId) {
    const peer = this.peers.get(oldPeerId);
    if (!peer) throw new Error('Peer not found');

    // Update the peer ID
    peer.id = newPeerId;

    // Remove the old entry and add with new ID
    this.peers.delete(oldPeerId);
    this.peers.set(newPeerId, peer);

    this.emit('peerUpdated', { oldPeerId, newPeerId });
    return true;
  }

  async createWebRtcTransport(peerId, direction) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Peer not found');

    const transport = await this.router.createWebRtcTransport({
      listenIps: [
        { ip: '0.0.0.0', announcedIp: 'https://backendwebrtc-x442.onrender.com' }
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1000000,
      enableSctp: false,
      numSctpStreams: { OS: 1024, MIS: 1024 },
      appData: { peerId, direction, roomId: this.roomId }
    });

    transport.on('dtlsstatechange', (dtlsState) => {
      if (dtlsState === 'closed') {
        transport.close();
      }
    });

    transport.on('close', () => {
      console.log(`Transport ${transport.id} closed for peer ${peerId}`);
      peer.transports.delete(transport.id);
    });

    const transportData = {
      transport,
      direction,
      peerId,
      createdAt: Date.now()
    };

    peer.transports.set(transport.id, transportData);

    return {
      transport,
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters
      }
    };
  }

  async connectTransport(peerId, transportId, dtlsParameters) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Peer not found');

    const transportData = peer.transports.get(transportId);
    if (!transportData) throw new Error('Transport not found');

    await transportData.transport.connect({ dtlsParameters });
    return true;
  }

  async produce(peerId, transportId, kind, rtpParameters, appData) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Peer not found');

    const transportData = peer.transports.get(transportId);
    if (!transportData) throw new Error('Transport not found');

    if (transportData.direction !== 'send') {
      throw new Error('Transport not configured for sending');
    }

    const producer = await transportData.transport.produce({
      kind,
      rtpParameters,
      appData: { peerId, roomId: this.roomId, mediaType: appData?.mediaType || kind } // Include mediaType
    });

    producer.on('transportclose', () => {
      producer.close();
    });

    producer.on('close', () => {
      peer.producers.delete(producer.id);
      this.emit('producerClosed', { peerId, producerId: producer.id });
    });

    peer.producers.set(producer.id, producer);
    this.emit('producerCreated', { peerId, producerId: producer.id, kind, appData: producer.appData });

    return { producerId: producer.id };
  }

  // async consume(peerId, transportId, producerId, rtpCapabilities) {
  //   const peer = this.peers.get(peerId);
  //   if (!peer) throw new Error('Peer not found');

  //   const transportData = peer.transports.get(transportId);
  //   if (!transportData) throw new Error('Transport not found');

  //   if (transportData.direction !== 'recv') {
  //     throw new Error('Transport not configured for receiving');
  //   }

  //   // Validate rtpCapabilities
  //   if (!rtpCapabilities || !rtpCapabilities.codecs) {
  //     throw new Error('Invalid RTP capabilities');
  //   }

  //   // Check if we can consume this producer
  //   const canConsume = this.router.canConsume({
  //     producerId,
  //     rtpCapabilities
  //   });

  //   if (!canConsume) {
  //     const error = new Error('Cannot consume this producer');
  //     error.details = {
  //       producerId,
  //       rtpCapabilities,
  //       routerCapabilities: this.router.rtpCapabilities
  //     };
  //     throw error;
  //   }

  //   // Find the producer to get its appData
  //   let producerAppData = {};
  //   for (const peer of this.peers.values()) {
  //     const producer = peer.producers.get(producerId);
  //     if (producer) {
  //       producerAppData = producer.appData;
  //       break;
  //     }
  //   }

  //   const consumer = await transportData.transport.consume({
  //     producerId,
  //     rtpCapabilities,
  //     paused: true,
  //     appData: { peerId, roomId: this.roomId, mediaType: producerAppData.mediaType || 'unknown' } // Include mediaType
  //   });

  //   consumer.on('transportclose', () => {
  //     consumer.close();
  //   });

  //   consumer.on('producerclose', () => {
  //     peer.consumers.delete(consumer.id);
  //     this.emit('consumerClosed', { peerId, consumerId: consumer.id });
  //   });

  //   peer.consumers.set(consumer.id, consumer);
  //   this.emit('consumerCreated', { peerId, consumerId: consumer.id });

  //   return {
  //     consumer,
  //     params: {
  //       id: consumer.id,
  //       producerId: consumer.producerId,
  //       kind: consumer.kind,
  //       rtpParameters: consumer.rtpParameters,
  //       appData: consumer.appData // Include appData in consumer params
  //     }
  //   };
  // }
  async consume(peerId, transportId, producerId, rtpCapabilities) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Peer not found');

    const transportData = this.getTransport(peerId, transportId);
    if (!transportData) throw new Error('Transport not found');

    if (transportData.closed) {
      throw new Error('Transport is closed');
    }

    if (transportData.appData?.direction !== 'recv') {
      throw new Error('Transport not configured for receiving');
    }

    // Validate rtpCapabilities
    if (!rtpCapabilities || !rtpCapabilities.codecs) {
      throw new Error('Invalid RTP capabilities');
    }

    // Check if we can consume this producer
    const canConsume = this.router.canConsume({
      producerId,
      rtpCapabilities
    });

    if (!canConsume) {
      const error = new Error('Cannot consume this producer');
      error.details = {
        producerId,
        rtpCapabilities,
        routerCapabilities: this.router.rtpCapabilities
      };
      throw error;
    }

    // Find the producer to get its appData
    let producerAppData = {};
    for (const peer of this.peers.values()) {
      const producer = peer.producers.get(producerId);
      if (producer) {
        producerAppData = producer.appData;
        break;
      }
    }

    // Create consumer
    const consumer = await transportData.consume({
      producerId,
      rtpCapabilities,
      paused: true,
      appData: { peerId, roomId: this.roomId, mediaType: producerAppData.mediaType || 'unknown' }
    });

    // Store consumer
    if (!this.consumers.has(peerId)) {
      this.consumers.set(peerId, new Map());
    }
    this.consumers.get(peerId).set(consumer.id, consumer);

    // Event handlers
    consumer.on('transportclose', () => {
      this.closeConsumer(peerId, consumer.id);
      this.emit('consumerClosed', { peerId, consumerId: consumer.id });
    });

    consumer.on('producerclose', () => {
      this.closeConsumer(peerId, consumer.id);
      this.emit('consumerClosed', { peerId, consumerId: consumer.id });
    });

    // Backward compatibility with existing peer.consumers
    if (!peer.consumers) {
      peer.consumers = new Map();
    }
    peer.consumers.set(consumer.id, consumer);

    this.emit('consumerCreated', { peerId, consumerId: consumer.id });

    return {
      params: {
        id: consumer.id,
        producerId: consumer.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        appData: consumer.appData
      },
      consumerId: consumer.id
    };
  }
  async resumeConsumer(peerId, consumerId) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Peer not found');

    const consumer = peer.consumers.get(consumerId);
    if (!consumer) throw new Error('Consumer not found');

    await consumer.resume();
    return true;
  }

  getProducerList() {
    const producerList = [];

    this.peers.forEach(peer => {
      peer.producers.forEach(producer => {
        producerList.push({
          producerId: producer.id,
          peerId: peer.id,
          peerName: peer.name,
          kind: producer.kind,
          appData: producer.appData // Include appData in producer list
        });
      });
    });

    return producerList;
  }

  checkHealth() {
    return {
      peers: this.peers.size,
      routerAlive: !!this.router,
      transports: Array.from(this.peers.values()).reduce(
        (sum, peer) => sum + peer.transports.size, 0),
      producers: Array.from(this.peers.values()).reduce(
        (sum, peer) => sum + peer.producers.size, 0),
      consumers: Array.from(this.peers.values()).reduce(
        (sum, peer) => sum + peer.consumers.size, 0),
      uptime: Date.now() - this.createdAt
    };
  }
}

module.exports = Room;