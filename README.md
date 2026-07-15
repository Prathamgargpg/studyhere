# StudyHere

A fully self-hosted video conferencing platform: JWT authentication, an
Express backend, a mediasoup **SFU** for multi-party WebRTC calls, Postgres
storage (via Prisma), a React frontend, and real-time chat over Socket.IO.

## Stack

| Layer      | Choice                                             |
|------------|-----------------------------------------------------|
| Frontend   | React + Vite, `mediasoup-client`, `socket.io-client` |
| Backend    | Node.js + Express, `mediasoup` (SFU), `socket.io`    |
| Auth       | JWT in an httpOnly cookie, bcrypt password hashing   |
| Database   | PostgreSQL via Prisma ORM                            |
| Realtime   | Socket.IO for signaling + chat; WebRTC for media     |

## Why an SFU (mediasoup)?

For group calls, each participant sends **one** upload stream to the server;
the server (an SFU — Selective Forwarding Unit) fans it out to every other
participant. This scales far better than mesh peer-to-peer, where every
participant would need N-1 upload streams.

## Project layout

```
studyhere/
  backend/     Express API, mediasoup SFU, Socket.IO signaling, Prisma schema
  frontend/    React app (auth pages, dashboard, call room)
  docker-compose.yml
```

## Quick start (Docker)

```bash
docker compose up --build
```
- Frontend: http://localhost:5173
- Backend:  http://localhost:4000
- Postgres: localhost:5432

For calls to work across two different devices/networks, set
`MEDIASOUP_ANNOUNCED_IP` in `docker-compose.yml` to your machine's real LAN
or public IP (not `127.0.0.1`), and make sure UDP ports `40000-40100` are
reachable.

## Manual local setup

### 1. Postgres
Run Postgres locally, or just: `docker run -p 5432:5432 -e POSTGRES_USER=studyhere -e POSTGRES_PASSWORD=studyhere -e POSTGRES_DB=studyhere postgres:16-alpine`

### 2. Backend
```bash
cd backend
cp .env.example .env      # edit DATABASE_URL / JWT_SECRET / MEDIASOUP_ANNOUNCED_IP
npm install
npx prisma migrate dev --name init
npm run dev                # http://localhost:4000
```

### 3. Frontend
```bash
cd frontend
npm install
npm run dev                 # http://localhost:5173
```

Open two browser windows (or a normal + incognito window) at
`http://localhost:5173`, register two different accounts, create a room in
one, and join it with the room code in the other.

## How it works

1. **Auth** — `POST /api/auth/register` / `login` issue a JWT stored in an
   httpOnly cookie. `requireAuth` middleware protects REST routes; the same
   token is verified during the Socket.IO handshake.
2. **Rooms** — a room has a short shareable `code`. Creating a room makes you
   its `host`; joining adds a `RoomMember` row.
3. **Signaling** — on entering a call, the client connects a Socket.IO
   channel, joins the room's mediasoup `Router`, creates a send transport and
   a receive transport, and publishes mic/camera tracks as **producers**.
4. **SFU fan-out** — when a peer produces a track, the server notifies every
   other peer in the room (`newProducer`), and each of them creates a
   **consumer** on their own receive transport to pull that stream.
5. **Screen share** — published as an extra video producer tagged
   `appData.source = 'screen'`.
6. **Chat** — messages are persisted (`ChatMessage` table) and broadcast live
   over the same Socket.IO room.

## Known limitations / next steps

- No TURN server is configured — calls across restrictive NATs/firewalls may
  fail. Add a TURN server (e.g. coturn) and pass its credentials into
  `webRtcTransport` ICE servers for production reliability.
- No recording, waiting rooms, or reactions yet — the data model (`Meeting`)
  has a start/end hook ready for a recording pipeline.
- Room locking (`Room.isLocked`) exists in the schema but isn't yet exposed
  in the UI — wire up a "lock room" button in the host's Room page.
- No horizontal scaling of Socket.IO/mediasoup across multiple server
  processes yet (would need the Socket.IO Redis adapter + consistent
  room-to-worker routing).
