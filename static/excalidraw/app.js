import React, { useCallback, useEffect, useMemo, useRef, useState } from 'https://esm.sh/react@18.2.0';
import { createRoot } from 'https://esm.sh/react-dom@18.2.0/client';
import { Excalidraw, getSceneVersion } from 'https://esm.sh/@excalidraw/excalidraw@0.17.6?bundle';

const contextScript = document.getElementById('whiteboard-context');
const context = contextScript ? JSON.parse(contextScript.textContent || '{}') : {};

const sessionId = String(context.sessionId || '');
const roomId = Number(context.roomId || 0);
const initialScene = context.initialScene || null;

const presenceElement = document.getElementById('whiteboardPresence');

const WhiteboardApp = () => {
  const excalidrawRef = useRef(null);
  const socketRef = useRef(null);
  const skipBroadcastRef = useRef(false);
  const pendingSceneRef = useRef(null);
  const flushTimerRef = useRef(null);
  const lastSentVersionRef = useRef(0);

  const [participants, setParticipants] = useState(1);
  const [statusText, setStatusText] = useState('Подключение...');

  const uiOptions = useMemo(() => ({
    canvasActions: {
      loadScene: false,
      saveToActiveFile: false,
      export: {
        saveFileToDisk: true,
        exportToClipboard: true,
        exportToPng: true,
        exportToSvg: true
      },
      changeViewBackgroundColor: true,
      clearCanvas: true,
      toggleTheme: true
    }
  }), []);

  const updatePresenceText = useCallback((people, status) => {
    if (presenceElement) {
      presenceElement.textContent = `Участников: ${people} • ${status}`;
    }
  }, []);

  useEffect(() => {
    updatePresenceText(participants, statusText);
  }, [participants, statusText, updatePresenceText]);

  const flushScene = useCallback(() => {
    if (!pendingSceneRef.current || !socketRef.current || !socketRef.current.connected) {
      return;
    }
    const payload = {
      session_id: sessionId,
      room_id: roomId,
      scene: pendingSceneRef.current
    };
    socketRef.current.emit('whiteboard_scene', payload);
    pendingSceneRef.current = null;
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) {
      return;
    }
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      flushScene();
    }, 280);
  }, [flushScene]);

  const handleChange = useCallback((elements, appState, files) => {
    if (skipBroadcastRef.current) {
      return;
    }

    const filteredElements = elements.filter((element) => !element.isDeleted);
    const version = getSceneVersion(filteredElements);
    if (version === lastSentVersionRef.current) {
      return;
    }

    lastSentVersionRef.current = version;

    const fileEntries = files ? Array.from(files.entries()) : [];
    const serializableScene = {
      elements: filteredElements,
      appState: {
        ...appState,
        collaborators: {}
      },
      files: Object.fromEntries(fileEntries)
    };

    pendingSceneRef.current = serializableScene;
    scheduleFlush();
  }, [scheduleFlush]);

  useEffect(() => {
    const socket = io('/', {
      transports: ['websocket', 'polling'],
      withCredentials: true
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setStatusText('В сети');
      socket.emit('join_whiteboard', {
        session_id: sessionId,
        room_id: roomId
      });
    });

    socket.on('disconnect', () => {
      setStatusText('Ожидание подключения');
    });

    socket.on('whiteboard_presence', (data) => {
      if (data && data.session_id === sessionId) {
        setParticipants(Math.max(1, Number(data.participants) || 1));
      }
    });

    socket.on('whiteboard_scene', (data) => {
      if (!data || data.session_id !== sessionId || !data.scene) {
        return;
      }
      const api = excalidrawRef.current;
      if (!api) {
        return;
      }

      skipBroadcastRef.current = true;
      try {
        api.updateScene({
          elements: data.scene.elements || [],
          appState: data.scene.appState || {},
          files: data.scene.files || {}
        });
        if (data.scene.elements) {
          lastSentVersionRef.current = getSceneVersion(data.scene.elements);
        }
      } finally {
        skipBroadcastRef.current = false;
      }
    });

    return () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
      }
      if (socket.connected) {
        socket.emit('leave_whiteboard', {
          session_id: sessionId,
          room_id: roomId
        });
      }
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, []);

  const initialData = useMemo(() => {
    if (!initialScene || typeof initialScene !== 'object') {
      return undefined;
    }
    return initialScene;
  }, []);

  return (
    React.createElement('div', { className: 'whiteboard-excalidraw-wrapper' },
      React.createElement(Excalidraw, {
        ref: (api) => {
          if (api) {
            excalidrawRef.current = api;
          }
        },
        initialData,
        langCode: 'ru-RU',
        onChange: handleChange,
        UIOptions: uiOptions,
        autoFocus: true,
        theme: 'dark'
      })
    )
  );
};

const rootElement = document.getElementById('whiteboardApp');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(React.createElement(WhiteboardApp));
}
