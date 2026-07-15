import { useEffect, useRef } from 'react';

export default function VideoTile({ stream, name, avatarColor = '#6C5CE7', muted = false, isLocal = false }) {
  const videoRef = useRef(null);
  const hasVideo = stream?.getVideoTracks().some((t) => t.readyState === 'live');

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream || null;
  }, [stream]);

  return (
    <div className="video-tile">
      {hasVideo ? (
        <video ref={videoRef} autoPlay playsInline muted={muted || isLocal} />
      ) : (
        <div className="video-tile-placeholder" style={{ background: avatarColor }}>
          <span>{name?.[0]?.toUpperCase() || '?'}</span>
        </div>
      )}
      <div className="video-tile-label">{name}{isLocal ? ' (you)' : ''}</div>
    </div>
  );
}
