import React, { useCallback, useEffect, useMemo, useRef, useState } from "https://esm.sh/react@18.3.1?bundle";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client?bundle";
import * as ExcalidrawLib from "https://esm.sh/@excalidraw/excalidraw@0.18.2?bundle";
import { io } from "https://esm.sh/socket.io-client@4.7.5?bundle";

const { Excalidraw, MainMenu, WelcomeScreen } = ExcalidrawLib;

const bootstrap = window.WHITEBOARD_BOOTSTRAP || {};
const SHARE_URL = bootstrap.shareUrl || window.location.href;

const serializeFiles = (files) => {
    if (!files) {
        return {};
    }
    if (files instanceof Map) {
        const result = {};
        for (const [id, file] of files.entries()) {
            result[id] = file;
        }
        return result;
    }
    if (typeof files === "object") {
        return files;
    }
    return {};
};

const deserializeFiles = (files) => {
    if (!files) {
        return new Map();
    }
    if (files instanceof Map) {
        return files;
    }
    const map = new Map();
    Object.entries(files).forEach(([key, value]) => {
        map.set(key, value);
    });
    return map;
};

const sanitizeAppState = (appState = {}) => {
    const cloned = { ...appState };
    delete cloned.collaborators;
    return cloned;
};

const applySceneToApi = (api, scene) => {
    if (!api || !scene) {
        return;
    }
    const files = deserializeFiles(scene.files);
    api.updateScene({
        elements: scene.elements || [],
        appState: {
            ...scene.appState,
            collaborators: new Map()
        },
        files
    });
};

const useWhiteboardSocket = (boardId, applyRemoteScene, setConnectionState) => {
    const socketRef = useRef(null);

    useEffect(() => {
        if (!boardId) {
            return () => undefined;
        }

        const socket = io({ transports: ["websocket", "polling"] });
        socketRef.current = socket;
        setConnectionState("connecting");

        const handleSync = (scene) => {
            if (scene && typeof scene === "object") {
                applyRemoteScene(scene);
            }
        };

        socket.on("connect", () => {
            setConnectionState("online");
            socket.emit("whiteboard_join", { board_id: boardId });
        });

        socket.on("disconnect", () => {
            setConnectionState("offline");
        });

        socket.on("reconnect_attempt", () => {
            setConnectionState("connecting");
        });

        socket.on("whiteboard_sync", handleSync);

        return () => {
            socket.off("whiteboard_sync", handleSync);
            socket.disconnect();
            socketRef.current = null;
        };
    }, [boardId, applyRemoteScene, setConnectionState]);

    const broadcastScene = useCallback((payload) => {
        const socket = socketRef.current;
        if (!socket || socket.disconnected) {
            return;
        }
        socket.emit("whiteboard_broadcast", {
            board_id: boardId,
            scene: payload
        });
    }, [boardId]);

    return broadcastScene;
};

const Toolbar = ({ onCopy, copied, connectionState }) => {
    const statusClass = connectionState === "online" ? "" : "disconnected";
    const statusLabel = connectionState === "online"
        ? "Онлайн"
        : connectionState === "connecting"
            ? "Подключение"
            : "Отключено";

    return (
        <div className="whiteboard-toolbar">
            <button className="primary" onClick={onCopy}>
                {copied ? "Ссылка скопирована" : "Скопировать приглашение"}
            </button>
            <div className="whiteboard-status" aria-live="polite">
                <span className={`whiteboard-status-dot ${statusClass}`}></span>
                <span>{statusLabel}</span>
            </div>
        </div>
    );
};

const Welcome = () => (
    <WelcomeScreen>
        <WelcomeScreen.Center>
            <WelcomeScreen.Center.Logo>
                <span role="img" aria-label="Доска">🧑‍🎨</span>
            </WelcomeScreen.Center.Logo>
            <WelcomeScreen.Center.Heading>
                Добро пожаловать в совместную доску
            </WelcomeScreen.Center.Heading>
            <WelcomeScreen.Center.Paragraph>
                Работайте с коллегами в реальном времени, не покидая GlassChat.
            </WelcomeScreen.Center.Paragraph>
        </WelcomeScreen.Center>
    </WelcomeScreen>
);

const WhiteboardApp = () => {
    const excalidrawAPIRef = useRef(null);
    const isApplyingRemoteRef = useRef(false);
    const pendingSceneRef = useRef(null);
    const broadcastTimeoutRef = useRef(null);
    const latestRemoteSceneRef = useRef(null);
    const [connectionState, setConnectionState] = useState("connecting");
    const [copied, setCopied] = useState(false);

    const initialData = useMemo(() => {
        if (!bootstrap.initialScene) {
            return undefined;
        }
        const files = deserializeFiles(bootstrap.initialScene.files);
        return {
            ...bootstrap.initialScene,
            files
        };
    }, []);

    const applyRemoteScene = useCallback((scene) => {
        if (!scene) {
            return;
        }
        latestRemoteSceneRef.current = scene;
        const api = excalidrawAPIRef.current;
        if (!api) {
            return;
        }
        isApplyingRemoteRef.current = true;
        applySceneToApi(api, scene);
        pendingSceneRef.current = scene;
        window.requestAnimationFrame(() => {
            isApplyingRemoteRef.current = false;
        });
    }, []);

    const broadcastScene = useWhiteboardSocket(bootstrap.boardId, applyRemoteScene, setConnectionState);

    const scheduleBroadcast = useCallback(() => {
        if (broadcastTimeoutRef.current) {
            return;
        }
        broadcastTimeoutRef.current = window.setTimeout(() => {
            broadcastTimeoutRef.current = null;
            if (!pendingSceneRef.current) {
                return;
            }
            broadcastScene(pendingSceneRef.current);
        }, 350);
    }, [broadcastScene]);

    const handleChange = useCallback((elements, appState, files) => {
        if (isApplyingRemoteRef.current) {
            return;
        }
        const payload = {
            elements,
            appState: sanitizeAppState(appState),
            files: serializeFiles(files)
        };
        pendingSceneRef.current = payload;
        scheduleBroadcast();
    }, [scheduleBroadcast]);

    const handleCopy = useCallback(() => {
        if (!navigator.clipboard) {
            window.prompt("Скопируйте ссылку", SHARE_URL);
            return;
        }
        navigator.clipboard.writeText(SHARE_URL).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1800);
        }).catch(() => {
            window.prompt("Скопируйте ссылку", SHARE_URL);
        });
    }, []);

    const setApi = useCallback((api) => {
        excalidrawAPIRef.current = api;
        if (api && latestRemoteSceneRef.current) {
            isApplyingRemoteRef.current = true;
            applySceneToApi(api, latestRemoteSceneRef.current);
            window.requestAnimationFrame(() => {
                isApplyingRemoteRef.current = false;
            });
        }
    }, []);

    const renderMainMenu = useCallback(() => (
        <MainMenu>
            <MainMenu.Group title="Файл">
                <MainMenu.DefaultItems.LoadScene />
                <MainMenu.DefaultItems.SaveAsImage />
                <MainMenu.DefaultItems.Export />
                <MainMenu.DefaultItems.ClearCanvas />
            </MainMenu.Group>
            <MainMenu.Separator />
            <MainMenu.Group title="Оформление">
                <MainMenu.DefaultItems.ToggleTheme />
                <MainMenu.DefaultItems.ChangeCanvasBackground />
            </MainMenu.Group>
        </MainMenu>
    ), []);

    return (
        <>
            {!bootstrap.embed && (
                <Toolbar onCopy={handleCopy} copied={copied} connectionState={connectionState} />
            )}
            <Excalidraw
                excalidrawAPI={setApi}
                onChange={handleChange}
                initialData={initialData}
                langCode="ru-RU"
                UIOptions={{
                    canvasActions: {
                        saveToActiveFile: false,
                        saveFileToDisk: false,
                        share: false,
                        shortcuts: false,
                        toggleTheme: true,
                        export: true,
                        loadScene: true,
                        clearCanvas: true,
                        changeViewBackgroundColor: true
                    }
                }}
                name="Совместная доска"
                theme="dark"
                renderMainMenu={renderMainMenu}
                renderWelcomeScreen={() => <Welcome />}
            />
        </>
    );
};

const container = document.getElementById("whiteboard-root");
if (container) {
    const root = createRoot(container);
    root.render(<WhiteboardApp />);
}
