import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

// Drives one call: joins the signaling room, negotiates a send transport and
// a receive transport, publishes local mic/camera, and consumes every other
// participant's producers as they appear. Returns everything a Room page
// needs to render.
export function useMediasoupRoom(roomCode) {
  const [connected, setConnected] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({}); // socketId -> { streams, name, avatarColor }
  const [chatMessages, setChatMessages] = useState([]);
  const [error, setError] = useState(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [screenSharing, setScreenSharing] = useState(false);

  const socketRef = useRef(null);
  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);
  const producersRef = useRef({}); // kind -> Producer
  const consumersRef = useRef({}); // consumerId -> Consumer
  const peerMetaRef = useRef({}); // socketId -> { name, avatarColor }

  const upsertRemoteStream = useCallback((socketId, track) => {
    setRemoteStreams((prev) => {
      const existing = prev[socketId]?.stream || new MediaStream();
      existing.addTrack(track);
      return {
        ...prev,
        [socketId]: {
          stream: existing,
          name: peerMetaRef.current[socketId]?.name || 'Participant',
          avatarColor: peerMetaRef.current[socketId]?.avatarColor || '#6C5CE7',
        },
      };
    });
  }, []);

  const consume = useCallback(
    async (producerId, socketId) => {
      const socket = socketRef.current;
      const device = deviceRef.current;
      socket.emit(
        'consume',
        { roomCode, transportId: recvTransportRef.current.id, producerId, rtpCapabilities: device.rtpCapabilities },
        async (res) => {
          if (res.error) return console.error(res.error);
          const consumer = await recvTransportRef.current.consume({
            id: res.id,
            producerId: res.producerId,
            kind: res.kind,
            rtpParameters: res.rtpParameters,
          });
          consumersRef.current[consumer.id] = consumer;
          upsertRemoteStream(socketId, consumer.track);
          socket.emit('resumeConsumer', { roomCode, consumerId: consumer.id }, () => {});
        }
      );
    },
    [roomCode, upsertRemoteStream]
  );

  const publish = useCallback(async (track, kind, appData = {}) => {
    const producer = await sendTransportRef.current.produce({ track, appData });
    producersRef.current[appData.source || kind] = producer;
    return producer;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      const socket = io('/', { withCredentials: true, path: '/socket.io' });
      socketRef.current = socket;

      socket.on('connect_error', (err) => setError(err.message));

      socket.on('peerJoined', (peer) => {
        peerMetaRef.current[peer.socketId] = { name: peer.name, avatarColor: peer.avatarColor };
      });

      socket.on('peerLeft', ({ socketId }) => {
        setRemoteStreams((prev) => {
          const next = { ...prev };
          delete next[socketId];
          return next;
        });
      });

      socket.on('newProducer', ({ producerId, socketId }) => consume(producerId, socketId));

      socket.on('producerClosed', ({ producerId }) => {
        // Remote track ended (e.g. camera off / screen share stopped).
        setRemoteStreams((prev) => {
          const next = { ...prev };
          Object.keys(next).forEach((sid) => {
            next[sid].stream.getTracks().forEach((t) => {
              if (t.id === producerId) next[sid].stream.removeTrack(t);
            });
          });
          return next;
        });
      });

      socket.on('chatMessage', (msg) => setChatMessages((prev) => [...prev, msg]));

      socket.emit('joinRoom', { roomCode }, async (res) => {
        if (cancelled) return;
        if (res.error) return setError(res.error);

        res.peers.forEach((p) => {
          peerMetaRef.current[p.socketId] = { name: p.name, avatarColor: p.avatarColor };
        });

        const device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities: res.rtpCapabilities });
        deviceRef.current = device;

        // Send transport
        socket.emit('createTransport', { roomCode, direction: 'send' }, async (info) => {
          const transport = device.createSendTransport(info);
          transport.on('connect', ({ dtlsParameters }, callback, errback) => {
            socket.emit('connectTransport', { roomCode, transportId: transport.id, dtlsParameters }, (r) =>
              r.error ? errback(new Error(r.error)) : callback()
            );
          });
          transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
            socket.emit('produce', { roomCode, transportId: transport.id, kind, rtpParameters, appData }, (r) =>
              r.error ? errback(new Error(r.error)) : callback({ id: r.id })
            );
          });
          sendTransportRef.current = transport;

          // Get local mic + camera and publish.
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
            setLocalStream(stream);
            await publish(stream.getAudioTracks()[0], 'audio', { source: 'mic' });
            await publish(stream.getVideoTracks()[0], 'video', { source: 'webcam' });
          } catch (err) {
            setError('Could not access camera/microphone: ' + err.message);
          }
        });

        // Receive transport
        socket.emit('createTransport', { roomCode, direction: 'recv' }, (info) => {
          const transport = device.createRecvTransport(info);
          transport.on('connect', ({ dtlsParameters }, callback, errback) => {
            socket.emit('connectTransport', { roomCode, transportId: transport.id, dtlsParameters }, (r) =>
              r.error ? errback(new Error(r.error)) : callback()
            );
          });
          recvTransportRef.current = transport;
          setConnected(true);
        });
      });
    }

    start();

    return () => {
      cancelled = true;
      socketRef.current?.emit('leaveRoom');
      socketRef.current?.disconnect();
      sendTransportRef.current?.close();
      recvTransportRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode]);

  const toggleMic = useCallback(() => {
    const producer = producersRef.current.mic;
    if (!producer) return;
    if (producer.paused) producer.resume();
    else producer.pause();
    setMicOn(producer.paused ? false : true);
  }, []);

  const toggleCam = useCallback(() => {
    const producer = producersRef.current.webcam;
    if (!producer) return;
    if (producer.paused) producer.resume();
    else producer.pause();
    setCamOn(producer.paused ? false : true);
  }, []);

  const toggleScreenShare = useCallback(async () => {
    if (screenSharing) {
      producersRef.current.screen?.close();
      socketRef.current.emit('closeProducer', { roomCode, producerId: producersRef.current.screen.id });
      delete producersRef.current.screen;
      setScreenSharing(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      track.onended = () => toggleScreenShare();
      await publish(track, 'video', { source: 'screen' });
      setScreenSharing(true);
    } catch (err) {
      // User cancelled the share picker; not an error worth surfacing.
    }
  }, [screenSharing, roomCode, publish]);

  const sendChatMessage = useCallback(
    (body) => {
      socketRef.current?.emit('chatMessage', { roomCode, body }, (res) => {
        if (res?.error) setError(res.error);
      });
    },
    [roomCode]
  );

  return {
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
  };
}
