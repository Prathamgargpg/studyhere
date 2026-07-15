require('dotenv').config();
const http = require('http');
const { Server } = require('socket.io');

const createApp = require('./app');
const { createWorkers } = require('./mediasoup/worker');
const { registerSignaling } = require('./socket/signaling');

async function main() {
  await createWorkers();

  const app = createApp();
  const server = http.createServer(app);

  const io = new Server(server, {
    cors: { origin: process.env.CLIENT_URL || 'http://localhost:5173', credentials: true },
  });
  registerSignaling(io);

  const port = process.env.PORT || 4000;
  server.listen(port, () => {
    console.log(`StudyHere backend listening on :${port}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
