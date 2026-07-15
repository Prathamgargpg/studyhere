import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useMediasoupRoom } from '../hooks/useMediasoup';
import VideoTile from '../components/VideoTile';
import Controls from '../components/Controls';
import ChatPanel from '../components/ChatPanel';
import api from '../api/axios';

export default function Room() {
  const { code } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [chatOpen, setChatOpen] = useState(false);
  const [initialMessages, setInitialMessages] = useState([]);

  const {
    connected,
    localStream,
    remoteStreams,
    chatMessages,
    error,
    micOn,
    camOn,
    screenSharing,
    toggleMic,
    toggleCam,
    toggleScreenShare,
    sendChatMessage,
  } = useMediasoupRoom(code);

  useEffect(() => {
    api.get(`/rooms/${code}/messages`).then(({ data }) => setInitialMessages(data.messages)).catch(() => {});
  }, [code]);

  const allMessages = [...initialMessages, ...chatMessages];
  const remoteEntries = Object.entries(remoteStreams);

  return (
    <div className="room-page">
      <header className="room-header">
        <div>
          <strong>Room:</strong> {code}
          <span className={connected ? 'status connected' : 'status'}>{connected ? 'Connected' : 'Connecting...'}</span>
        </div>
        <button className="link-btn" onClick={() => setChatOpen((v) => !v)}>{chatOpen ? 'Hide chat' : 'Show chat'}</button>
      </header>

      {error && <div className="form-error">{error}</div>}

      <div className="room-body">
        <div className="video-grid">
          <VideoTile stream={localStream} name={user?.name} avatarColor={user?.avatarColor} isLocal />
          {remoteEntries.map(([socketId, r]) => (
            <VideoTile key={socketId} stream={r.stream} name={r.name} avatarColor={r.avatarColor} />
          ))}
        </div>

        {chatOpen && (
          <ChatPanel messages={allMessages} onSend={sendChatMessage} currentUserId={user?.id} />
        )}
      </div>

      <Controls
        micOn={micOn}
        camOn={camOn}
        screenSharing={screenSharing}
        onToggleMic={toggleMic}
        onToggleCam={toggleCam}
        onToggleScreen={toggleScreenShare}
        onLeave={() => navigate('/dashboard')}
      />
    </div>
  );
}
