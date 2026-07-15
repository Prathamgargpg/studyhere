const { z } = require('zod');
const { customAlphabet } = require('nanoid');
const prisma = require('../config/prisma');

// Human-friendly join codes like "kdt-mvqp-3fz", avoiding ambiguous chars.
const nanoid = customAlphabet('abcdefghjkmnpqrstuvwxyz23456789', 4);
function generateRoomCode() {
  return `${nanoid()}-${nanoid()}-${nanoid()}`;
}

const createRoomSchema = z.object({
  name: z.string().min(1).max(80),
});

async function createRoom(req, res) {
  const parsed = createRoomSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const room = await prisma.room.create({
    data: {
      name: parsed.data.name,
      code: generateRoomCode(),
      ownerId: req.user.id,
      members: { create: { userId: req.user.id, role: 'host' } },
    },
  });

  return res.status(201).json({ room });
}

async function listMyRooms(req, res) {
  const memberships = await prisma.roomMember.findMany({
    where: { userId: req.user.id },
    include: { room: true },
    orderBy: { joinedAt: 'desc' },
  });
  return res.json({ rooms: memberships.map((m) => ({ ...m.room, myRole: m.role })) });
}

async function getRoomByCode(req, res) {
  const room = await prisma.room.findUnique({
    where: { code: req.params.code },
    include: { owner: { select: { id: true, name: true } } },
  });
  if (!room) return res.status(404).json({ error: 'Room not found' });
  return res.json({ room });
}

async function joinRoom(req, res) {
  const room = await prisma.room.findUnique({ where: { code: req.params.code } });
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.isLocked) return res.status(403).json({ error: 'This room is locked by the host' });

  const membership = await prisma.roomMember.upsert({
    where: { userId_roomId: { userId: req.user.id, roomId: room.id } },
    update: {},
    create: { userId: req.user.id, roomId: room.id, role: 'participant' },
  });

  return res.json({ room, membership });
}

async function getChatHistory(req, res) {
  const room = await prisma.room.findUnique({ where: { code: req.params.code } });
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const messages = await prisma.chatMessage.findMany({
    where: { roomId: room.id },
    include: { user: { select: { id: true, name: true, avatarColor: true } } },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  return res.json({ messages });
}

module.exports = { createRoom, listMyRooms, getRoomByCode, joinRoom, getChatHistory };
