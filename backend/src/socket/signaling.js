const cookie = require('cookie');
const { verifyToken } = require('../middleware/authMiddleware');
const prisma = require('../config/prisma');
const { getOrCreateRouter, closeRouter, createWebRtcTransport } = require('../mediasoup/worker');

// In-memory state, scoped per process. roomCode -> Map<socketId, PeerState>
// PeerState holds this participant's mediasoup objects and identity.
const rooms = new Map();

function getRoomPeers(roomCode) {
  if (!rooms.has(roomCode)) rooms.set(roomCode, new Map());
  return rooms.get(roomCode);
}

function peerSummary(peer) {
  return { socketId: peer.socketId, userId: peer.user.id, name: peer.user.name, avatarColor: peer.user.avatarColor };
}

function authenticateSocket(socket, next) {
  try {
    const raw = socket.handshake.headers.cookie ? cookie.parse(socket.handshake.headers.cookie) : {};
    const token = socket.handshake.auth?.token || raw[process.env.COOKIE_NAME || 'studyhere_token'];
    if (!token) return next(new Error('Not authenticated'));
    const payload = verifyToken(token);
    socket.user = { id: payload.sub, email: payload.email, name: payload.name };
    next();
  } catch (err) {
    next(new Error('Invalid or expired session'));
  }
}

function registerSignaling(io) {
  io.use(authenticateSocket);

  io.on('connection', (socket) => {
    let currentRoomCode = null;

    // --- Join a call room -------------------------------------------------
    socket.on('joinRoom', async ({ roomCode }, callback) => {
      try {
        const room = await prisma.room.findUnique({ where: { code: roomCode } });
        if (!room) return callback({ error: 'Room not found' });

        const dbUser = await prisma.user.findUnique({ where: { id: socket.user.id } });
        const router = await getOrCreateRouter(roomCode);

        const peers = getRoomPeers(roomCode);
        const peer = {
          socketId: socket.id,
          user: { id: dbUser.id, name: dbUser.name, avatarColor: dbUser.avatarColor },
          transports: new Map(),
          producers: new Map(),
          consumers: new Map(),
        };
        peers.set(socket.id, peer);

        currentRoomCode = roomCode;
        socket.join(roomCode);
        socket.to(roomCode).emit('peerJoined', peerSummary(peer));

        callback({
          rtpCapabilities: router.rtpCapabilities,
          peers: [...peers.values()].filter((p) => p.socketId !== socket.id).map(peerSummary),
        });
      } catch (err) {
        console.error('joinRoom error', err);
        callback({ error: 'Failed to join room' });
      }
    });

    // --- Transport setup (one for sending, one for receiving per peer) ----
    socket.on('createTransport', async ({ roomCode, direction }, callback) => {
      try {
        const router = await getOrCreateRouter(roomCode);
        const transport = await createWebRtcTransport(router);
        const peer = getRoomPeers(roomCode).get(socket.id);
        peer.transports.set(transport.id, transport);

        transport.observer.on('close', () => peer.transports.delete(transport.id));

        callback({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });
      } catch (err) {
        console.error('createTransport error', err);
        callback({ error: 'Failed to create transport' });
      }
    });

    socket.on('connectTransport', async ({ roomCode, transportId, dtlsParameters }, callback) => {
      try {
        const peer = getRoomPeers(roomCode).get(socket.id);
        const transport = peer.transports.get(transportId);
        await transport.connect({ dtlsParameters });
        callback({ ok: true });
      } catch (err) {
        console.error('connectTransport error', err);
        callback({ error: 'Failed to connect transport' });
      }
    });

    // --- Produce (send my mic/camera/screen) -------------------------------
    socket.on('produce', async ({ roomCode, transportId, kind, rtpParameters, appData }, callback) => {
      try {
        const peer = getRoomPeers(roomCode).get(socket.id);
        const transport = peer.transports.get(transportId);
        const producer = await transport.produce({ kind, rtpParameters, appData });
        peer.producers.set(producer.id, producer);

        producer.observer.on('close', () => peer.producers.delete(producer.id));

        socket.to(roomCode).emit('newProducer', {
          producerId: producer.id,
          socketId: socket.id,
          kind,
          appData,
        });

        callback({ id: producer.id });
      } catch (err) {
        console.error('produce error', err);
        callback({ error: 'Failed to produce media' });
      }
    });

    // --- Consume (receive another peer's media) -----------------------------
    socket.on('consume', async ({ roomCode, transportId, producerId, rtpCapabilities }, callback) => {
      try {
        const router = await getOrCreateRouter(roomCode);
        if (!router.canConsume({ producerId, rtpCapabilities })) {
          return callback({ error: 'Cannot consume this producer' });
        }

        const peer = getRoomPeers(roomCode).get(socket.id);
        const transport = peer.transports.get(transportId);
        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: true, // client resumes once it's ready to render
        });
        peer.consumers.set(consumer.id, consumer);
        consumer.observer.on('close', () => peer.consumers.delete(consumer.id));

        callback({
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      } catch (err) {
        console.error('consume error', err);
        callback({ error: 'Failed to consume media' });
      }
    });

    socket.on('resumeConsumer', async ({ roomCode, consumerId }, callback) => {
      try {
        const peer = getRoomPeers(roomCode).get(socket.id);
        await peer.consumers.get(consumerId).resume();
        callback({ ok: true });
      } catch (err) {
        callback({ error: 'Failed to resume consumer' });
      }
    });

    socket.on('closeProducer', ({ roomCode, producerId }) => {
      const peer = getRoomPeers(roomCode).get(socket.id);
      const producer = peer?.producers.get(producerId);
      if (producer) {
        producer.close();
        socket.to(roomCode).emit('producerClosed', { producerId, socketId: socket.id });
      }
    });

    // --- Chat ---------------------------------------------------------------
    socket.on('chatMessage', async ({ roomCode, body }, callback) => {
      try {
        const room = await prisma.room.findUnique({ where: { code: roomCode } });
        if (!room) return callback?.({ error: 'Room not found' });

        const message = await prisma.chatMessage.create({
          data: { body: body.slice(0, 2000), roomId: room.id, userId: socket.user.id },
          include: { user: { select: { id: true, name: true, avatarColor: true } } },
        });

        io.to(roomCode).emit('chatMessage', message);
        callback?.({ ok: true });
      } catch (err) {
        console.error('chatMessage error', err);
        callback?.({ error: 'Failed to send message' });
      }
    });

    // --- Leave / disconnect ---------------------------------------------------
    function leaveRoom() {
      if (!currentRoomCode) return;
      const peers = getRoomPeers(currentRoomCode);
      const peer = peers.get(socket.id);
      if (peer) {
        peer.transports.forEach((t) => t.close());
        peers.delete(socket.id);
        socket.to(currentRoomCode).emit('peerLeft', { socketId: socket.id });
      }
      if (peers.size === 0) {
        rooms.delete(currentRoomCode);
        closeRouter(currentRoomCode);
      }
      socket.leave(currentRoomCode);
      currentRoomCode = null;
    }

    socket.on('leaveRoom', leaveRoom);
    socket.on('disconnect', leaveRoom);
  });
}

module.exports = { registerSignaling };
