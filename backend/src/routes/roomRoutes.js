const express = require('express');
const { requireAuth } = require('../middleware/authMiddleware');
const {
  createRoom,
  listMyRooms,
  getRoomByCode,
  joinRoom,
  getChatHistory,
} = require('../controllers/roomController');

const router = express.Router();

router.use(requireAuth);

router.post('/', createRoom);
router.get('/', listMyRooms);
router.get('/:code', getRoomByCode);
router.post('/:code/join', joinRoom);
router.get('/:code/messages', getChatHistory);

module.exports = router;
