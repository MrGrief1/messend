(function () {
    const overlay = document.getElementById('command-palette-overlay');
    const input = document.getElementById('command-palette-input');
    const resultsList = document.getElementById('command-palette-results');
    const commandButton = document.getElementById('workspace-command-button');
    const workspaceTitle = document.getElementById('workspace-active-room');
    const workspaceMeta = document.getElementById('workspace-room-meta');
    const statusDot = document.getElementById('workspace-status-dot');
    const themeButton = document.querySelector('[data-workspace-action="toggle-theme"]');
    const callButton = document.querySelector('[data-workspace-action="quick-call"]');

    const THEME_ORDER = ['dark', 'ocean', 'amoled', 'light'];
    const THEME_LABELS = {
        dark: 'Тёмная тема',
        ocean: 'Океан',
        amoled: 'AMOLED',
        light: 'Светлая тема'
    };

    const paletteState = {
        allActions: [],
        filtered: [],
        activeIndex: 0
    };
    let defaultMetaText = workspaceMeta ? workspaceMeta.textContent.trim() : '';
    let resetMetaTimer = null;

    function ensureDefaultMeta(text) {
        if (!workspaceMeta) return;
        defaultMetaText = text;
        workspaceMeta.dataset.defaultText = text;
    }

    function setMetaTemporary(text, timeout = 2400) {
        if (!workspaceMeta) return;
        if (resetMetaTimer) {
            clearTimeout(resetMetaTimer);
            resetMetaTimer = null;
        }
        workspaceMeta.textContent = text;
        resetMetaTimer = setTimeout(() => {
            workspaceMeta.textContent = workspaceMeta.dataset.defaultText || defaultMetaText;
        }, timeout);
    }

    function closePalette({ focusTrigger = false } = {}) {
        if (!overlay) return;
        overlay.classList.remove('active');
        overlay.setAttribute('aria-hidden', 'true');
        if (input) {
            input.value = '';
        }
        if (focusTrigger && commandButton) {
            commandButton.focus();
        }
    }

    function executeAction(action) {
        if (!action || typeof action.run !== 'function') {
            return;
        }
        try {
            action.run();
        } catch (err) {
            console.error('Command palette action failed', err);
        }
    }

    function renderActions() {
        if (!resultsList) return;
        resultsList.innerHTML = '';
        paletteState.filtered.forEach((action, index) => {
            const item = document.createElement('li');
            item.className = index === paletteState.activeIndex ? 'active' : '';
            item.dataset.index = String(index);
            const title = document.createElement('strong');
            title.textContent = action.label;
            const detail = document.createElement('span');
            detail.textContent = action.detail;
            item.append(title, detail);
            item.addEventListener('mouseenter', () => {
                paletteState.activeIndex = index;
                renderActions();
            });
            item.addEventListener('click', (event) => {
                event.preventDefault();
                paletteState.activeIndex = index;
                executeAction(paletteState.filtered[index]);
                closePalette();
            });
            resultsList.appendChild(item);
        });
        if (!paletteState.filtered.length) {
            const empty = document.createElement('li');
            empty.className = 'empty';
            empty.textContent = 'Ничего не найдено';
            resultsList.appendChild(empty);
        }
    }

    function filterActions(query) {
        const q = query.trim().toLowerCase();
        if (!q) {
            paletteState.filtered = paletteState.allActions.slice(0, 12);
        } else {
            paletteState.filtered = paletteState.allActions.filter((action) => {
                return action.keywords.some((word) => word.includes(q));
            }).slice(0, 12);
        }
        paletteState.activeIndex = 0;
        renderActions();
    }

    function collectRoomActions() {
        const actions = [];
        const items = document.querySelectorAll('.room-item');
        items.forEach((item) => {
            const name = item.getAttribute('data-room-name') || item.textContent.trim();
            const type = item.getAttribute('data-room-type');
            const keywords = [name.toLowerCase()];
            if (type) {
                keywords.push(type);
            }
            actions.push({
                label: name || 'Чат',
                detail: type === 'dm' ? 'Личное сообщение' : type === 'group' ? 'Групповой чат' : 'Канал',
                keywords,
                run() {
                    item.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    item.click();
                }
            });
        });
        return actions;
    }

    function baseActions() {
        return [
            {
                label: 'Создать группу или канал',
                detail: 'Открыть окно создания новой комнаты',
                keywords: ['создать', 'группа', 'канал', 'new'],
                run() {
                    if (typeof openModal === 'function') {
                        openModal('createRoomModal');
                    }
                }
            },
            {
                label: 'Найти пользователя',
                detail: 'Открыть поиск по пользователям',
                keywords: ['поиск', 'user', 'контакт'],
                run() {
                    if (typeof openModal === 'function') {
                        openModal('searchModal');
                    }
                }
            },
            {
                label: 'Открыть настройки профиля',
                detail: 'Редактировать имя, био и тему',
                keywords: ['настройки', 'profile', 'профиль'],
                run() {
                    if (typeof openInlineSettings === 'function') {
                        openInlineSettings();
                    } else if (typeof openModal === 'function') {
                        openModal('settingsModal');
                    }
                }
            },
            {
                label: 'Сменить тему интерфейса',
                detail: 'Переключение между темами: тёмная, океан, AMOLED, светлая',
                keywords: ['тема', 'theme', 'цвет'],
                run() {
                    cycleTheme();
                    setMetaTemporary(`Тема: ${themeLabel()}`);
                }
            },
            {
                label: 'Начать звонок',
                detail: 'Запустить мгновенный аудио/видео звонок',
                keywords: ['звонок', 'call', 'видео'],
                run() {
                    if (typeof startCall === 'function') {
                        startCall();
                    }
                }
            }
        ];
    }

    function refreshActions() {
        paletteState.allActions = [...baseActions(), ...collectRoomActions()];
        paletteState.filtered = paletteState.allActions.slice(0, 12);
        paletteState.activeIndex = 0;
        renderActions();
    }

    function openPalette() {
        if (!overlay) return;
        refreshActions();
        overlay.classList.add('active');
        overlay.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => {
            if (input) {
                input.focus();
                input.select();
            }
        });
    }

    function handleGlobalKey(event) {
        const isMod = event.metaKey || event.ctrlKey;
        if (isMod && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            if (overlay && overlay.classList.contains('active')) {
                closePalette({ focusTrigger: true });
            } else {
                openPalette();
            }
        } else if (event.key === 'Escape' && overlay && overlay.classList.contains('active')) {
            closePalette({ focusTrigger: true });
        }
    }

    function handlePaletteKey(event) {
        if (!overlay || !overlay.classList.contains('active')) return;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            paletteState.activeIndex = (paletteState.activeIndex + 1) % Math.max(paletteState.filtered.length, 1);
            renderActions();
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            paletteState.activeIndex = (paletteState.activeIndex - 1 + Math.max(paletteState.filtered.length, 1)) % Math.max(paletteState.filtered.length, 1);
            renderActions();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            const action = paletteState.filtered[paletteState.activeIndex];
            if (action) {
                executeAction(action);
                closePalette();
            }
        }
    }

    function cycleTheme() {
        const body = document.body;
        if (!body) return;
        const current = body.getAttribute('data-theme') || 'dark';
        const idx = THEME_ORDER.indexOf(current);
        const next = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
        body.setAttribute('data-theme', next);
        try {
            localStorage.setItem('appTheme', next);
        } catch (err) {
            console.warn('Unable to persist theme', err);
        }
        const themeSelect = document.getElementById('themeSelect');
        if (themeSelect) {
            themeSelect.value = next;
        }
        if (typeof selectedTheme !== 'undefined') {
            selectedTheme = next;
        }
    }

    function themeLabel() {
        const current = document.body.getAttribute('data-theme') || 'dark';
        return THEME_LABELS[current] || current;
    }

    function wireThemeButton() {
        if (!themeButton) return;
        themeButton.addEventListener('click', () => {
            cycleTheme();
            setMetaTemporary(`Тема: ${themeLabel()}`);
        });
    }

    function wireCallButton() {
        if (!callButton) return;
        callButton.addEventListener('click', () => {
            if (typeof startCall === 'function') {
                startCall();
            }
        });
    }

    function updateConnectionState() {
        if (!statusDot) return;
        const isConnected = typeof socket !== 'undefined' && socket && socket.connected;
        if (isConnected) {
            statusDot.style.background = 'var(--workspace-success)';
            statusDot.style.boxShadow = '0 0 8px rgba(49, 209, 88, 0.45)';
            ensureDefaultMeta(workspaceMeta.dataset.defaultText || defaultMetaText || 'На связи');
        } else {
            statusDot.style.background = 'var(--workspace-danger)';
            statusDot.style.boxShadow = '0 0 12px rgba(253, 93, 93, 0.4)';
            setMetaTemporary('Нет подключения к серверу', 3800);
        }
    }

    function observeSocket() {
        if (typeof socket !== 'undefined' && socket) {
            socket.on('connect', () => {
                updateConnectionState();
                setMetaTemporary('Подключено', 2000);
            });
            socket.on('disconnect', () => {
                updateConnectionState();
            });
        } else {
            setTimeout(observeSocket, 500);
        }
    }

    function observeActiveRoom() {
        const chatTitle = document.getElementById('chat-with-name');
        if (!chatTitle || !workspaceTitle || !workspaceMeta) {
            return;
        }
        const setFromRoom = () => {
            const text = chatTitle.textContent.trim();
            if (text) {
                workspaceTitle.textContent = text;
                let descriptor = 'Беседа';
                if (typeof currentRoomType !== 'undefined' && currentRoomType) {
                    descriptor = currentRoomType === 'dm' ? 'Личное сообщение' : currentRoomType === 'group' ? 'Групповой чат' : 'Канал';
                } else {
                    descriptor = 'Главная панель';
                }
                ensureDefaultMeta(descriptor);
                workspaceMeta.textContent = descriptor;
            } else {
                workspaceTitle.textContent = 'Главная';
                ensureDefaultMeta('Выберите чат или создайте новый');
                workspaceMeta.textContent = workspaceMeta.dataset.defaultText || 'Выберите чат или создайте новый';
            }
        };
        setFromRoom();
        const observer = new MutationObserver(setFromRoom);
        observer.observe(chatTitle, { characterData: true, childList: true, subtree: true });
    }

    function initializePalette() {
        if (!overlay || !input || !resultsList) {
            return;
        }
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                closePalette();
            }
        });
        if (commandButton) {
            commandButton.addEventListener('click', () => {
                if (overlay.classList.contains('active')) {
                    closePalette({ focusTrigger: true });
                } else {
                    openPalette();
                }
            });
        }
        input.addEventListener('input', (event) => {
            filterActions(event.target.value);
        });
    }

    function init() {
        ensureDefaultMeta(defaultMetaText || 'Выберите чат или создайте новый');
        initializePalette();
        observeActiveRoom();
        document.addEventListener('keydown', handleGlobalKey);
        document.addEventListener('keydown', handlePaletteKey);
        wireThemeButton();
        wireCallButton();
        observeSocket();
        updateConnectionState();
        if (typeof window !== 'undefined') {
            window.addEventListener('focus', updateConnectionState);
        }
        const roomList = document.getElementById('room-list');
        if (roomList) {
            const roomObserver = new MutationObserver(() => {
                refreshActions();
            });
            roomObserver.observe(roomList, { childList: true, subtree: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
