import { createServer } from 'http';
import { Server } from 'socket.io';
import * as mediasoup from 'mediasoup';

const PORT = parseInt(process.env.PORT || '4000', 10);
const RTC_MIN_PORT = parseInt(process.env.RTC_MIN_PORT || '40000', 10);
const RTC_MAX_PORT = parseInt(process.env.RTC_MAX_PORT || '49999', 10);
const LISTEN_IP = process.env.LISTEN_IP || '0.0.0.0';
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || undefined; // публичный IP

const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: '*'} });

let worker;
let routers = new Map(); // roomId -> router
const transports = new Map(); // transportId -> transport
const producers = new Map(); // roomId -> Set(producer)
const socketRooms = new Map(); // socketId -> roomId
const producerToSocket = new Map(); // producerId -> socketId

async function createWorker() {
  worker = await mediasoup.createWorker({ rtcMinPort: RTC_MIN_PORT, rtcMaxPort: RTC_MAX_PORT });
  worker.on('died', () => {
    console.error('mediasoup worker died');
    process.exit(1);
  });
}

await createWorker();

const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 }
];

async function getRouter(roomId) {
  if (!routers.has(roomId)) {
    const router = await worker.createRouter({ mediaCodecs });
    routers.set(roomId, router);
  }
  return routers.get(roomId);
}

io.on('connection', (socket) => {
  socket.on('sfu_join_room', async ({ roomId }, cb) => {
    try {
      const router = await getRouter(String(roomId));
      cb({ routerRtpCapabilities: router.rtpCapabilities });
    } catch (e) {
      cb({ error: e.message });
    }
  });

  socket.on('sfu_create_transport', async ({ roomId, direction }, cb) => {
    try {
      const router = await getRouter(String(roomId));
      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: LISTEN_IP, announcedIp: ANNOUNCED_IP }],
        enableUdp: true,
        enableTcp: true
      });
      transports.set(transport.id, transport);
      cb({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters
      });
    } catch (e) {
      cb({ error: e.message });
    }
  });

  socket.on('sfu_connect_transport', async ({ transportId, dtlsParameters }, cb) => {
    const transport = transports.get(transportId);
    if (!transport) return cb({ error: 'Transport not found' });
    await transport.connect({ dtlsParameters });
    cb({});
  });

  socket.on('sfu_produce', async ({ roomId, transportId, kind, rtpParameters }, cb) => {
    try {
      const transport = transports.get(transportId);
      if (!transport) return cb({ error: 'Transport not found' });
      const producer = await transport.produce({ kind, rtpParameters });
      
      // Сохраняем producer
      if (!producers.has(roomId)) producers.set(roomId, new Set());
      producers.get(roomId).add(producer);
      producerToSocket.set(producer.id, socket.id);
      
      // Присоединяемся к комнате если еще не присоединились
      if (!socketRooms.has(socket.id)) {
        socket.join(String(roomId));
        socketRooms.set(socket.id, String(roomId));
        
        // Отправляем новому пользователю список существующих producers
        const existingProducers = Array.from(producers.get(roomId) || [])
          .filter(p => producerToSocket.get(p.id) !== socket.id); // Не отправляем свои же
        
        for (const p of existingProducers) {
          socket.emit('sfu_new_producer', { producerId: p.id, kind: p.kind });
        }
      }
      
      // Уведомляем других участников о новом producer
      socket.to(String(roomId)).emit('sfu_new_producer', { producerId: producer.id, kind: producer.kind });
      
      cb({ id: producer.id });
    } catch (e) {
      cb({ error: e.message });
    }
  });

  socket.on('sfu_consume', async ({ roomId, transportId, producerId, rtpCapabilities }, cb) => {
    try {
      const router = await getRouter(String(roomId));
      if (!router.canConsume({ producerId, rtpCapabilities })) return cb({ error: 'Cannot consume' });
      const transport = transports.get(transportId);
      if (!transport) return cb({ error: 'Transport not found' });
      const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
      cb({ id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters });
    } catch (e) {
      cb({ error: e.message });
    }
  });

  socket.on('sfu_resume_consumer', async ({ consumerId }, cb) => {
    for (const t of transports.values()) {
      const c = t.consumers?.find?.(x => x.id === consumerId);
      if (c) { await c.resume(); return cb({}); }
    }
    cb({ error: 'Consumer not found' });
  });

  socket.on('disconnect', () => {
    const roomId = socketRooms.get(socket.id);
    if (roomId && producers.has(roomId)) {
      // Удаляем producers этого сокета
      const roomProducers = producers.get(roomId);
      for (const producer of Array.from(roomProducers)) {
        if (producerToSocket.get(producer.id) === socket.id) {
          producer.close();
          roomProducers.delete(producer);
          producerToSocket.delete(producer.id);
        }
      }
    }
    socketRooms.delete(socket.id);
  });
});

httpServer.listen(PORT, () => console.log('SFU listening on', PORT));

