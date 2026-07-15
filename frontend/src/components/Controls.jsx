export default function Controls({ micOn, camOn, screenSharing, onToggleMic, onToggleCam, onToggleScreen, onLeave }) {
  return (
    <div className="controls-bar">
      <button className={micOn ? 'ctrl-btn' : 'ctrl-btn off'} onClick={onToggleMic}>
        {micOn ? '🎤 Mute' : '🔇 Unmute'}
      </button>
      <button className={camOn ? 'ctrl-btn' : 'ctrl-btn off'} onClick={onToggleCam}>
        {camOn ? '📷 Stop Video' : '🚫 Start Video'}
      </button>
      <button className={screenSharing ? 'ctrl-btn on' : 'ctrl-btn'} onClick={onToggleScreen}>
        {screenSharing ? '🟥 Stop Share' : '🖥️ Share Screen'}
      </button>
      <button className="ctrl-btn leave" onClick={onLeave}>
        ☎️ Leave
      </button>
    </div>
  );
}
