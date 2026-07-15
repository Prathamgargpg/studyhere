import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/axios';
import { useAuth } from '../context/AuthContext';

export default function Dashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [rooms, setRooms] = useState([]);
  const [newRoomName, setNewRoomName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/rooms').then(({ data }) => setRooms(data.rooms)).catch(() => {});
  }, []);

  async function createRoom(e) {
    e.preventDefault();
    setError(null);
    try {
      const { data } = await api.post('/rooms', { name: newRoomName || 'Untitled study room' });
      navigate(`/room/${data.room.code}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create room');
    }
  }

  async function joinRoom(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/rooms/${joinCode.trim()}/join`);
      navigate(`/room/${joinCode.trim()}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not join room');
    }
  }

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>StudyHere</h1>
        <div>
          <span className="me">{user?.name}</span>
          <button className="link-btn" onClick={logout}>Log out</button>
        </div>
      </header>

      {error && <div className="form-error">{error}</div>}

      <div className="dashboard-grid">
        <form className="panel" onSubmit={createRoom}>
          <h2>Start a new room</h2>
          <input placeholder="Room name" value={newRoomName} onChange={(e) => setNewRoomName(e.target.value)} />
          <button type="submit">Create & Enter</button>
        </form>

        <form className="panel" onSubmit={joinRoom}>
          <h2>Join with a code</h2>
          <input placeholder="e.g. abcd-efgh-ijkl" value={joinCode} onChange={(e) => setJoinCode(e.target.value)} />
          <button type="submit">Join</button>
        </form>
      </div>

      <h2>Your rooms</h2>
      <ul className="room-list">
        {rooms.map((room) => (
          <li key={room.id} onClick={() => navigate(`/room/${room.code}`)}>
            <strong>{room.name}</strong>
            <span className="room-code">{room.code}</span>
          </li>
        ))}
        {rooms.length === 0 && <p className="muted">No rooms yet — create one above.</p>}
      </ul>
    </div>
  );
}
