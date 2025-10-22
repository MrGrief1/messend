(function () {
    const rootElement = document.getElementById('whiteboard-root');
    const config = window.__WHITEBOARD_CONFIG__ || {};

    const showFallback = (message) => {
        if (rootElement) {
            rootElement.innerHTML = `<div class="whiteboard-fallback">${message}</div>`;
        }
    };

    if (!rootElement) {
        console.error('Whiteboard root element is missing');
        return;
    }

    if (!window.React || !window.ReactDOM || !window.Excalidraw || typeof io !== 'function') {
        showFallback('Не удалось загрузить интерфейс доски. Попробуйте обновить страницу.');
        return;
    }

    const { createElement: h, useState, useEffect, useMemo, useCallback, useRef } = window.React;
    const { createRoot } = window.ReactDOM;
    const { Excalidraw, restore, serializeAsJSON, getSceneVersion, THEME } = window.Excalidraw;

    const numericRoomId = Number(config.roomId);
    const roomIdentifier = Number.isFinite(numericRoomId) ? numericRoomId : config.roomId;
    if (!roomIdentifier) {
        showFallback('Комната недоступна или была удалена.');
        return;
    }

    const socket = io({ transports: ['websocket'], upgrade: false });

    const WhiteboardApp = () => {
        const [connectionState, setConnectionState] = useState('connecting');
        const [copyStatus, setCopyStatus] = useState(null);
        const [lastSync, setLastSync] = useState(config.initialScene ? new Date() : null);
        const sceneVersionRef = useRef(Number(config.initialSceneVersion) || 0);
        const ignoreChangeRef = useRef(false);
        const latestSceneRef = useRef(null);
        const broadcastRef = useRef(null);
        const excalidrawRef = useRef(null);
        const themeValue = (config.theme || '').toLowerCase() === 'light' ? THEME.LIGHT : THEME.DARK;

        useEffect(() => {
            document.title = `Общая доска — ${config.roomName || 'Совместная доска'}`;
        }, []);

        useEffect(() => {
            if (!copyStatus) return;
            const timer = window.setTimeout(() => setCopyStatus(null), 2400);
            return () => window.clearTimeout(timer);
        }, [copyStatus]);

        useEffect(() => () => {
            if (broadcastRef.current) {
                window.clearTimeout(broadcastRef.current);
            }
        }, []);

        const initialData = useMemo(() => {
            if (!config.initialScene) {
                return undefined;
            }
            try {
                const parsed = typeof config.initialScene === 'string'
                    ? JSON.parse(config.initialScene)
                    : config.initialScene;
                const restored = restore(parsed, null, null);
                const restoredVersion = typeof parsed?.version === 'number'
                    ? parsed.version
                    : getSceneVersion(restored.elements);
                if (Number.isFinite(restoredVersion)) {
                    sceneVersionRef.current = restoredVersion;
                }
                return restored;
            } catch (error) {
                console.warn('Не удалось восстановить сохранённую сцену Excalidraw:', error);
                return undefined;
            }
        }, []);

        const handleRemoteScene = useCallback((payload) => {
            if (!payload || payload.room_id == null || String(payload.room_id) !== String(roomIdentifier)) {
                return;
            }
            if (!payload.scene) {
                return;
            }

            const incomingVersion = Number(payload.version);
            if (Number.isFinite(incomingVersion) && incomingVersion <= sceneVersionRef.current) {
                return;
            }

            try {
                const parsedScene = typeof payload.scene === 'string'
                    ? JSON.parse(payload.scene)
                    : payload.scene;
                const restored = restore(parsedScene, null, null);
                const nextVersion = Number.isFinite(incomingVersion)
                    ? incomingVersion
                    : (typeof parsedScene?.version === 'number'
                        ? parsedScene.version
                        : getSceneVersion(restored.elements));
                ignoreChangeRef.current = true;
                sceneVersionRef.current = Number.isFinite(nextVersion) ? nextVersion : sceneVersionRef.current + 1;
                excalidrawRef.current?.updateScene(restored);
                setLastSync(new Date());
            } catch (error) {
                console.error('Не удалось применить изменения доски', error);
            }
        }, [roomIdentifier]);

        const handleRemoteClear = useCallback((payload) => {
            if (!payload || String(payload.room_id) !== String(roomIdentifier)) {
                return;
            }
            const api = excalidrawRef.current;
            if (api) {
                ignoreChangeRef.current = true;
                sceneVersionRef.current = 0;
                const currentAppState = api.getAppState ? api.getAppState() : {};
                api.updateScene({
                    elements: [],
                    files: {},
                    appState: {
                        ...currentAppState,
                        selectedElementIds: {},
                        selectedGroupIds: {},
                    },
                });
            }
            setLastSync(new Date());
        }, [roomIdentifier]);

        useEffect(() => {
            if (Number.isFinite(numericRoomId)) {
                socket.emit('join', { room_id: numericRoomId });
            }

            const handleConnect = () => setConnectionState('online');
            const handleDisconnect = () => setConnectionState('offline');
            const handleReconnectAttempt = () => setConnectionState('reconnecting');

            socket.on('connect', handleConnect);
            socket.on('disconnect', handleDisconnect);
            socket.io.on('reconnect_attempt', handleReconnectAttempt);
            socket.io.on('error', handleDisconnect);
            socket.on('whiteboard_draw', handleRemoteScene);
            socket.on('whiteboard_clear', handleRemoteClear);

            const handleBeforeUnload = () => {
                if (Number.isFinite(numericRoomId)) {
                    socket.emit('leave', { room_id: numericRoomId });
                }
            };
            window.addEventListener('beforeunload', handleBeforeUnload);

            return () => {
                socket.off('connect', handleConnect);
                socket.off('disconnect', handleDisconnect);
                socket.io.off('reconnect_attempt', handleReconnectAttempt);
                socket.io.off('error', handleDisconnect);
                socket.off('whiteboard_draw', handleRemoteScene);
                socket.off('whiteboard_clear', handleRemoteClear);
                window.removeEventListener('beforeunload', handleBeforeUnload);
                if (Number.isFinite(numericRoomId)) {
                    socket.emit('leave', { room_id: numericRoomId });
                }
                socket.close();
            };
        }, [handleRemoteClear, handleRemoteScene]);

        const handleChange = useCallback((elements, appState, files) => {
            if (ignoreChangeRef.current) {
                ignoreChangeRef.current = false;
                return;
            }

            latestSceneRef.current = { elements, appState, files };
            if (broadcastRef.current) {
                return;
            }

            broadcastRef.current = window.setTimeout(() => {
                broadcastRef.current = null;
                if (!latestSceneRef.current) {
                    return;
                }

                try {
                    const sceneString = serializeAsJSON(
                        latestSceneRef.current.elements,
                        latestSceneRef.current.appState,
                        latestSceneRef.current.files,
                        'local'
                    );
                    const version = getSceneVersion(latestSceneRef.current.elements);
                    sceneVersionRef.current = version;
                    socket.emit('whiteboard_draw', {
                        room_id: roomIdentifier,
                        scene: sceneString,
                        version,
                    });
                    setLastSync(new Date());
                } catch (error) {
                    console.error('Не удалось отправить обновления доски', error);
                } finally {
                    latestSceneRef.current = null;
                }
            }, 420);
        }, [roomIdentifier]);

        const handleCopyLink = useCallback(async () => {
            const link = `${window.location.origin}/whiteboard?room_id=${encodeURIComponent(roomIdentifier)}`;
            try {
                await navigator.clipboard.writeText(link);
                setCopyStatus('Ссылка скопирована');
            } catch (error) {
                try {
                    const tempInput = document.createElement('input');
                    tempInput.value = link;
                    document.body.appendChild(tempInput);
                    tempInput.select();
                    document.execCommand('copy');
                    document.body.removeChild(tempInput);
                    setCopyStatus('Ссылка скопирована');
                } catch (fallbackError) {
                    console.error('Clipboard copy failed', fallbackError);
                    setCopyStatus('Не удалось скопировать ссылку');
                }
            }
        }, [roomIdentifier]);

        const handleClearClick = useCallback(() => {
            if (!window.confirm('Очистить доску для всех участников?')) {
                return;
            }
            const api = excalidrawRef.current;
            if (api) {
                ignoreChangeRef.current = true;
                sceneVersionRef.current = 0;
                const currentAppState = api.getAppState ? api.getAppState() : {};
                api.updateScene({
                    elements: [],
                    files: {},
                    appState: {
                        ...currentAppState,
                        selectedElementIds: {},
                        selectedGroupIds: {},
                    },
                });
            }
            socket.emit('whiteboard_clear', { room_id: roomIdentifier });
            setLastSync(new Date());
        }, [roomIdentifier]);

        const handleReturn = useCallback(() => {
            const isMobileView = window.matchMedia('(max-width: 768px)').matches;
            if (!isMobileView && window.opener && !window.opener.closed) {
                window.close();
                return;
            }
            if (config.returnUrl) {
                window.location.href = config.returnUrl;
            } else if (window.history.length > 1) {
                window.history.back();
            } else {
                window.location.assign('/');
            }
        }, [config.returnUrl]);

        const connectionLabelMap = {
            connecting: 'Подключение…',
            online: 'Онлайн',
            reconnecting: 'Повторное подключение…',
            offline: 'Отключено',
        };
        const connectionLabel = connectionLabelMap[connectionState] || connectionLabelMap.connecting;
        const statusClass = `whiteboard-status whiteboard-status--${connectionState}`;
        const syncLabel = lastSync
            ? `Синхронизировано в ${lastSync.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
            : 'Изменения синхронизируются автоматически';

        return h('div', { className: 'whiteboard-app', 'data-theme': themeValue === THEME.LIGHT ? 'light' : 'dark' },
            h('header', { className: 'whiteboard-header' },
                h('div', { className: 'whiteboard-room' },
                    h('h1', { className: 'whiteboard-title' }, config.roomName || 'Совместная доска'),
                    h('span', { className: statusClass }, connectionLabel),
                    h('span', { className: 'whiteboard-hint' }, syncLabel),
                ),
                h('div', { className: 'whiteboard-actions' },
                    copyStatus ? h('span', { className: 'whiteboard-hint' }, copyStatus) : null,
                    h('button', { className: 'whiteboard-button', onClick: handleCopyLink }, 'Скопировать ссылку'),
                    h('button', { className: 'whiteboard-button danger', onClick: handleClearClick }, 'Очистить'),
                    h('button', { className: 'whiteboard-button ghost', onClick: handleReturn }, 'Вернуться')
                )
            ),
            h('div', { className: 'whiteboard-stage' },
                h('div', { className: 'whiteboard-excalidraw-container' },
                    h(Excalidraw, {
                        ref: excalidrawRef,
                        initialData,
                        onChange: handleChange,
                        theme: themeValue,
                        viewModeEnabled: false,
                        zenModeEnabled: false,
                        gridModeEnabled: false,
                        handleKeyboardGlobally: true,
                        name: config.roomName ? `Доска — ${config.roomName}` : 'Общая доска',
                        UIOptions: {
                            canvasActions: {
                                saveScene: true,
                                export: true,
                                loadScene: false,
                            },
                        },
                    })
                )
            )
        );
    };

    createRoot(rootElement).render(h(WhiteboardApp));
})();
