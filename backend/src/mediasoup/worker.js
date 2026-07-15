const mediasoup = require('mediasoup');
const config = require('./config');

let workers = [];
let nextWorkerIndex = 0;

// Room code -> mediasoup Router. Each room gets its own router so media
// never crosses between unrelated calls.
const routers = new Map();

async function createWorkers() {
  for (let i = 0; i < config.numWorkers; i++) {
    const worker = await mediasoup.createWorker(config.worker);
    worker.on('died', () => {
      // A worker dying is fatal for the media it was handling; crash loudly
      // so the process supervisor (pm2/docker) restarts a clean instance.
      console.error(`mediasoup worker ${worker.pid} died, exiting in 2s`);
      setTimeout(() => process.exit(1), 2000);
    });
    workers.push(worker);
  }
  console.log(`mediasoup: started ${workers.length} worker(s)`);
}

function getNextWorker() {
  const worker = workers[nextWorkerIndex];
  nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
  return worker;
}

async function getOrCreateRouter(roomCode) {
  let router = routers.get(roomCode);
  if (router) return router;

  const worker = getNextWorker();
  router = await worker.createRouter({ mediaCodecs: config.router.mediaCodecs });
  routers.set(roomCode, router);
  return router;
}

function closeRouter(roomCode) {
  const router = routers.get(roomCode);
  if (router) {
    router.close();
    routers.delete(roomCode);
  }
}

async function createWebRtcTransport(router) {
  const transport = await router.createWebRtcTransport({
    ...config.webRtcTransport,
    appData: {},
  });

  if (config.webRtcTransport.maxIncomingBitrate) {
    try {
      await transport.setMaxIncomingBitrate(config.webRtcTransport.maxIncomingBitrate);
    } catch (err) {
      // Non-fatal; some transport states don't support this.
    }
  }

  return transport;
}

module.exports = {
  createWorkers,
  getOrCreateRouter,
  closeRouter,
  createWebRtcTransport,
};
