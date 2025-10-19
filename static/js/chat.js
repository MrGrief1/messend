let socket;
let currentRoomId = null;
let currentRoomType = null; // 'dm', 'group', 'channel'
let currentUserRole = null; // 'member', 'admin' - роль текущего пользователя в комнате
let currentDMotherUserId = null; // ID собеседника в ЛС

// Элементы DOM
const chatWindow = document.getElementById('chat-window');
const messageInput = document.getElementById('message-input');
const chatHeader = document.getElementById('chat-header');
const chatInputArea = document.getElementById('chat-input-area');
const placeholderText = document.getElementById('placeholder-text');
const chatWithName = document.getElementById('chat-with-name');
const roomList = document.getElementById('room-list');
const callButton = document.getElementById('call-button');
const sendButton = document.getElementById('send-button');
// Доп. элементы заголовка чата
const membersBtn = document.getElementById('room-members-btn');
const roomSettingsBtn = document.getElementById('room-settings-btn');
const reactionPicker = document.getElementById('reaction-picker');
const unknownBanner = document.getElementById('unknown-contact-banner');
// Вызовы
let localStream = null;
let isMicEnabled = true;
let isCamEnabled = true;
let isScreenSharing = false; // состояние демонстрации экрана
let screenStream = null;     // текущий поток экрана (если активен)
let peerConnections = {}; // key: userId, value: RTCPeerConnection
let pendingIceByPeer = {}; // key: userId, value: array of ICE candidates, буфер до готовности PC
// RTCConfig с расширенными STUN серверами для P2P соединений
let rtcConfig = { 
    iceServers: [
        // Множество STUN серверов для лучшего определения публичных IP
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        // Альтернативные STUN серверы
        { urls: 'stun:stun.services.mozilla.com:3478' },
        { urls: 'stun:stun.stunprotocol.org:3478' },
    ],
    iceCandidatePoolSize: 10,
    iceTransportPolicy: 'all', // Собирать ВСЕ типы кандидатов (host, srflx, relay)
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
};
let isDialModalOpen = false;
let isCallModalOpen = false;

let reactionTargetMessageId = null; // ID сообщения, на которое мы реагируем

// ========== Browser Push Notifications ==========
let notificationsEnabled = false;

// Запрашиваем разрешение на уведомления
async function requestNotificationPermission() {
    if (!('Notification' in window)) {
        console.log('Браузер не поддерживает уведомления');
        return false;
    }
    
    if (Notification.permission === 'granted') {
        notificationsEnabled = true;
        return true;
    }
    
    if (Notification.permission !== 'denied') {
        const permission = await Notification.requestPermission();
        notificationsEnabled = (permission === 'granted');
        return notificationsEnabled;
    }
    
    return false;
}

// Показываем браузерное уведомление
function showBrowserNotification(title, options = {}) {
    // Не показываем если окно в фокусе
    if (document.hasFocus()) {
        return;
    }
    
    // Проверяем разрешение
    if (!notificationsEnabled || Notification.permission !== 'granted') {
        return;
    }
    
    try {
        const notification = new Notification(title, {
            icon: '/static/favicon.ico',
            badge: '/static/favicon.ico',
            ...options
        });
        
        // Закрываем уведомление через 5 секунд
        setTimeout(() => notification.close(), 5000);
        
        // При клике на уведомление - фокусируем окно
        notification.onclick = () => {
            window.focus();
            notification.close();
        };
    } catch (e) {
        console.error('Ошибка отображения уведомления:', e);
    }
}

// Инициализация Socket.IO
document.addEventListener('DOMContentLoaded', (event) => {
    // Применяем сохраненную тему до инициализации UI
    try {
        const savedTheme = localStorage.getItem('appTheme');
        if (savedTheme) {
            document.body.setAttribute('data-theme', savedTheme);
        }
    } catch {}
    
    // Запрашиваем разрешение на уведомления
    requestNotificationPermission();
    
    // Подключаемся к Socket.IO по текущему origin. Разрешаем стандартный апгрейд (polling -> websocket).
    socket = io({ transports: ['polling'], upgrade: false });

    socket.on('connect', () => console.log('WebSocket подключен!'));

    socket.on('receive_message', (data) => {
        console.log('Получено сообщение:', data);
        if (data.room_id == currentRoomId) {
            displayMessage(data);
            // Воспроизводим звук только если сообщение не от нас
            if (data.sender_id !== CURRENT_USER_ID && data.message_type !== 'system') {
                playMessageSound();
                // Показываем браузерное уведомление если окно не в фокусе
                showBrowserNotification('Новое сообщение', {
                    body: data.sender_name + ': ' + (data.content || 'Отправил медиафайл'),
                    tag: 'message-' + data.id
                });
            }
        }
    });

    socket.on('receive_message_with_unread', (data) => {
        const message = data.message;
        const unread_update = data.unread_update;

        if (message.room_id == currentRoomId) {
            // Если мы в этой комнате, просто отображаем сообщение
            displayMessage(message);
            // И сразу же помечаем как прочитанное
            markRoomAsRead(message.room_id); 
            // Воспроизводим звук только если сообщение не от нас
            if (message.sender_id !== CURRENT_USER_ID && message.message_type !== 'system') {
                playMessageSound();
            }
        } else {
            // Если мы не в этой комнате, обновляем счетчик и играем звук
            updateUnreadBadge(unread_update.room_id, unread_update.count);
            if (message.sender_id !== CURRENT_USER_ID && message.message_type !== 'system') {
                playMessageSound();
                // Показываем уведомление для сообщений из других комнат
                showBrowserNotification('Новое сообщение', {
                    body: message.sender_name + ': ' + (message.content || 'Отправил медиафайл'),
                    tag: 'message-' + message.id
                });
            }
        }
    });

    // Обновления опросов: приходят после голосования любого участника
    socket.on('poll_updated', (data) => {
        if (!data || !data.message_id || !data.poll) return;
        const container = document.querySelector(`.message-container[data-message-id='${String(data.message_id)}']`);
        if (!container) return;
        const pollEl = container.querySelector('.poll-container');
        if (!pollEl) return;
        renderPollResults(pollEl, data.message_id, data.poll);
    });

    // Присутствие и печатает
    socket.on('room_presence_snapshot', (data) => {
        // data.presence: { userId: true/false }
        // Можно отрисовать индикаторы в UI (упростим: шапка показывает онлайн-счётчик)
        updatePresenceHeader(data.presence);
    });
    socket.on('presence_update', (data) => {
        applyPresenceUpdate(data.user_id, data.online);
    });
    socket.on('typing', (data) => {
        showTypingIndicator(data.user_id, !!data.is_typing);
    });

    // Обработчик получения новой комнаты (ЛС или Группа)
    socket.on('new_room', (roomData) => {
        addNewRoomToSidebar(roomData);
        // Показываем уведомление, если модальное окно поиска не открыто (значит инициатор не мы)
        if (document.getElementById('searchModal').style.display !== 'flex') {
             alert(`Новый чат: ${roomData.name}`);
        }
    });

    // Обработчик обновления данных комнаты (например, название группы или имя контакта изменилось)
    socket.on('room_updated', (roomData) => {
        updateRoomInSidebar(roomData);
    });

    // НОВОЕ: Обработчик обновления реакций (Получаем полное состояние)
    socket.on('update_reactions', (data) => {
        updateMessageReactionsUI(data.message_id, data.reactions);
    });

    socket.on('message_edited', ({ message_id, content }) => {
        const container = document.querySelector(`.message-container[data-message-id="${message_id}"] .message`);
        if (container) {
            // Заменим текст до таймстемпа
            const ts = container.querySelector('.message-timestamp');
            const sender = container.querySelector('.message-sender');
            const media = container.querySelector('.message-media');
            container.innerHTML = ''; // Очищаем
            if (sender) container.appendChild(sender);
            if (media) container.appendChild(media); // Восстанавливаем медиа
            container.appendChild(document.createTextNode(content));
            if (ts) container.appendChild(ts);
        }
    });
    
    socket.on('call_card_updated', ({ message_id, duration, status }) => {
        // Обновление карточки звонка у всех участников
        const card = document.querySelector(`.call-card[data-message-id="${message_id}"]`);
        if (card) {
            const statusEl = card.querySelector('.call-card-subtitle');
            if (statusEl) statusEl.textContent = 'Завершен';
            
            const actionsEl = card.querySelector('.call-card-actions');
            if (actionsEl) actionsEl.remove();
            
            const durationEl = card.querySelector('.call-card-duration');
            if (durationEl) {
                durationEl.textContent = `Длительность: ${duration}`;
            } else {
                const newDurationEl = document.createElement('div');
                newDurationEl.className = 'call-card-duration';
                newDurationEl.textContent = `Длительность: ${duration}`;
                card.appendChild(newDurationEl);
            }
        }
    });
    
    socket.on('message_deleted', ({ message_id }) => {
        const container = document.querySelector(`.message-container[data-message-id="${message_id}"]`);
        if (container) container.remove();
    });

    socket.on('error', (data) => alert('Ошибка: ' + data.message));

    // Подтягиваем ICE/TURN с сервера (если настроено)
    fetch('/api/ice')
      .then(r => r.json())
      .then(cfg => { if (cfg && cfg.iceServers) rtcConfig.iceServers = cfg.iceServers; })
      .catch(() => {});

    // WebRTC сигналинг 1:1
    socket.on('webrtc_signal', async (data) => {
        const fromUser = data.sender_id;
        const signal = data.signal;
        await handleSignal(fromUser, signal);
    });

    // Входящий звонок 1:1 (popup + звук)
    socket.on('call_action', async (data) => {
        if (data.action === 'start') {
            // Входящий вызов
            showIncomingPopup(data.sender_id, data.sender_name);
            playRingtone();
        }
        if (data.action === 'accept') {
            // Собеседник принял — снимаем окно набора у звонящего и открываем основное окно звонка
            stopRingtone(); // Останавливаем звук ожидания
            if (isDialModalOpen) {
                closeDialModal();
            }
            // Открываем основное окно звонка, если оно еще не открыто
            if (!isCallModalOpen) {
                openCallModal();
            }
            // НЕ закрываем callModal если он уже открыт!
        }
        if (data.action === 'hangup' || data.action === 'end') {
            stopRingtone();
            hideIncomingPopup();
            endCall();
        }
        if (data.action === 'reject') {
            stopRingtone();
            hideIncomingPopup();
            endCall();
        }
    });

    // Групповые звонки уведомления
    socket.on('room_call_action', async (data) => {
        if (data.action === 'lobby_created') {
            // Показываем индикатор в чате группы что идет звонок
            // Но НЕ показываем приглашение (оно придет только при invite)
            if (data.room_id == currentRoomId && data.initiator_id !== CURRENT_USER_ID) {
                showCallLobbyIndicator(data.room_id);
            }
        }
        if (data.action === 'invite') {
            // Конкретное приглашение для этого пользователя
            if (data.target_user_id === CURRENT_USER_ID) {
                showGroupCallInvite(data.sender_name, data.room_id);
            }
        }
        if (data.action === 'end') {
            // Закрываем приглашение если оно открыто
            const inviteModal = document.getElementById('groupCallInviteModal');
            if (inviteModal) inviteModal.style.display = 'none';
            
            // Скрываем индикатор лобби
            hideCallLobbyIndicator();
            
            // Если мы уже в звонке - завершаем его
            if (isCallModalOpen || callStartTime) {
            endCall();
            }
        }
        if (data.action === 'update_participants') {
            // Обновляем количество участников в приглашении
            const countEl = document.getElementById('groupCallParticipantsCount');
            if (countEl && data.participants_count) {
                countEl.textContent = data.participants_count;
            }
        }
    });

    socket.on('room_deleted', (data) => {
        if (data.room_id == currentRoomId) {
            alert(`Комната "${data.room_name}" была удалена администратором.`);
            // Сбрасываем UI, как будто нас удалили
            chatHeader.style.display = 'none';
            chatInputArea.style.display = 'none';
            placeholderText.textContent = 'Выберите чат для общения.';
            placeholderText.style.display = 'block';
            currentRoomId = null;
            currentRoomType = null;
            currentUserRole = null;
        }
        // Удаляем комнату из сайдбара у всех участников
        const roomElement = document.querySelector(`.room-item[data-room-id="${data.room_id}"]`);
        if (roomElement) {
            roomElement.remove();
        }
    });

    // НОВОЕ: Управление участниками
    socket.on('member_list_updated', (data) => {
        if (data.room_id == currentRoomId && document.getElementById('membersModal').style.display === 'flex') {
            renderMembersList(data.members);
        }
    });

    socket.on('removed_from_room', (data) => {
        if (data.room_id == currentRoomId) {
            alert('Вы были удалены из этой комнаты.');
            
            // Закрываем все модальные окна
            document.querySelectorAll('.modal-overlay').forEach(modal => modal.style.display = 'none');
            
            // Сбрасываем текущее состояние чата
            chatHeader.style.display = 'none';
            chatInputArea.style.display = 'none';
            placeholderText.textContent = 'Выберите чат для общения.';
            placeholderText.style.display = 'block';
            currentRoomId = null;
            currentRoomType = null;
            currentUserRole = null;
            
            // Удаляем комнату из сайдбара
            const roomElement = document.querySelector(`.room-item[data-room-id="${data.room_id}"]`);
            if (roomElement) {
                roomElement.remove();
            }
        }
    });

    document.body.addEventListener('click', closeReactionPicker);
    
    // Предотвращаем закрытие пикера при клике внутри него
    reactionPicker.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    // Обработчики для кнопок контекстного меню
    document.getElementById('edit-message-btn').onclick = (event) => {
        event.stopPropagation();
        if (contextTargetMessage) {
            editMessage(contextTargetMessage.id, contextTargetMessage.content);
        }
        closeReactionPicker(); // Эта функция теперь также закрывает и контекстное меню
    };

    document.getElementById('delete-message-btn').onclick = (event) => {
        event.stopPropagation();
        if (contextTargetMessage) {
            deleteMessage(contextTargetMessage.id);
        }
        closeReactionPicker();
    };

    document.getElementById('select-message-btn').onclick = (event) => {
        event.stopPropagation();
        if (contextTargetMessage) {
            toggleSelectionMode(true);
            toggleMessageSelection(contextTargetMessage.id);
        }
        closeReactionPicker();
    };

    document.getElementById('cancel-editing-btn').onclick = cancelEditing;

    document.getElementById('cancel-selection-btn').onclick = (event) => {
        event.stopPropagation();
        toggleSelectionMode(false);
    };
    
    document.getElementById('delete-selected-btn').onclick = (event) => {
        event.stopPropagation();
        deleteSelectedMessages();
    };

    const confirmDeleteBtn = document.getElementById('confirm-delete-btn');
    if (confirmDeleteBtn) {
        confirmDeleteBtn.onclick = (event) => {
            event.stopPropagation();
            confirmDelete();
        };
    }
    
    messageInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            if (editingMessage) cancelEditing();
            if (selectionMode) toggleSelectionMode(false);
        }
    });

    // Перенесено внутрь инициализации: подписка на массовое удаление сообщений
    socket.on('messages_deleted', (data) => {
        if (data && data.message_ids) {
            data.message_ids.forEach(id => {
                const container = document.querySelector(`.message-container[data-message-id="${id}"]`);
                if (container) container.remove();
            });
        }
    });
    
    // ========== Socket обработчики для совместных функций ==========
    
    // Доска для рисования
    socket.on('whiteboard_draw', (data) => {
        if (!whiteboardCanvas || !whiteboardCtx) return;
        
        const fromX = data.fromX * whiteboardCanvas.width;
        const fromY = data.fromY * whiteboardCanvas.height;
        const toX = data.toX * whiteboardCanvas.width;
        const toY = data.toY * whiteboardCanvas.height;
        
        drawLine(fromX, fromY, toX, toY, data.color, data.size);
    });
    
    socket.on('whiteboard_clear', () => {
        if (whiteboardCtx && whiteboardCanvas) {
            whiteboardCtx.clearRect(0, 0, whiteboardCanvas.width, whiteboardCanvas.height);
        }
        if (whiteboardOverlayCtx && whiteboardOverlay) {
            whiteboardOverlayCtx.clearRect(0, 0, whiteboardOverlay.width, whiteboardOverlay.height);
        }
    });
    
    // Совместные документы
    socket.on('document_update', (data) => {
        if (!data.content) return;
        
        documentContent = data.content;
        const editor = document.getElementById('documentEditor');
        
        // Обновляем только если документ открыт и пользователь не редактирует
        if (editor && document.activeElement !== editor) {
            const scrollPos = editor.scrollTop;
            editor.innerHTML = data.content;
            editor.scrollTop = scrollPos;
        }
    });
    
    // Презентации
    socket.on('presentation_slide_change', (data) => {
        currentSlideIndex = data.slide_index;
        renderSlides();
    });
    
    // Инициализация счетчиков чатов
    updateChatCounts();
    
    // Добавляем обработчик правого клика для чатов
    document.addEventListener('contextmenu', (e) => {
        const roomItem = e.target.closest('.room-item');
        if (roomItem) {
            e.preventDefault();
            showRoomContextMenu(e, roomItem);
        }
    });
});

// --- Функции Чата (selectRoom обновлен) ---

let editingMessage = null;
let selectionMode = false;
let currentTab = 'chats'; // 'chats' или 'archive'

// ========== Функции для вкладок Чаты/Архив ==========

function switchToTab(tab) {
    currentTab = tab;
    
    const chatsTab = document.getElementById('chats-tab');
    const archiveTab = document.getElementById('archive-tab');
    const roomList = document.getElementById('room-list');
    const archiveList = document.getElementById('archive-list');
    
    if (tab === 'chats') {
        // Показываем обычные чаты
        chatsTab.classList.add('active');
        archiveTab.classList.remove('active');
        chatsTab.style.background = 'var(--color-primary)';
        chatsTab.style.color = 'white';
        archiveTab.style.background = 'var(--input-bg)';
        archiveTab.style.color = 'var(--text-color)';
        roomList.style.display = 'block';
        archiveList.style.display = 'none';
    } else {
        // Показываем архив
        chatsTab.classList.remove('active');
        archiveTab.classList.add('active');
        chatsTab.style.background = 'var(--input-bg)';
        chatsTab.style.color = 'var(--text-color)';
        archiveTab.style.background = 'var(--color-primary)';
        archiveTab.style.color = 'white';
        roomList.style.display = 'none';
        archiveList.style.display = 'block';
    }
    
    updateChatCounts();
}

function updateChatCounts() {
    const activeCount = document.querySelectorAll('#room-list .room-item').length;
    const archivedCount = document.querySelectorAll('#archive-list .room-item').length;
    
    const activeCountEl = document.getElementById('active-chats-count');
    const archivedCountEl = document.getElementById('archived-chats-count');
    
    if (activeCountEl) activeCountEl.textContent = activeCount > 0 ? `(${activeCount})` : '';
    if (archivedCountEl) archivedCountEl.textContent = archivedCount > 0 ? `(${archivedCount})` : '';
}

// Архивирование чата
async function archiveChat(roomId) {
    if (!roomId) return;
    
    try {
        const response = await fetch('/api/archive_chat', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({room_id: roomId})
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Перемещаем элемент из основного списка в архив
            const roomItem = document.querySelector(`#room-list .room-item[data-room-id="${roomId}"]`);
            if (roomItem) {
                roomItem.classList.add('archived');
                document.getElementById('archive-list').appendChild(roomItem);
                
                // Удаляем empty state если был
                const emptyState = document.getElementById('empty-state-archive');
                if (emptyState) emptyState.remove();
            }
            
            updateChatCounts();
            console.log('✅ Чат архивирован');
        } else {
            alert('Ошибка: ' + data.message);
        }
    } catch (error) {
        console.error('Ошибка архивирования:', error);
        alert('Не удалось архивировать чат');
    }
}

// Разархивирование чата
async function unarchiveChat(roomId) {
    if (!roomId) return;
    
    try {
        const response = await fetch('/api/unarchive_chat', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({room_id: roomId})
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Перемещаем элемент из архива в основной список
            const roomItem = document.querySelector(`#archive-list .room-item[data-room-id="${roomId}"]`);
            if (roomItem) {
                roomItem.classList.remove('archived');
                document.getElementById('room-list').appendChild(roomItem);
                
                // Удаляем empty state если был
                const emptyState = document.getElementById('empty-state-rooms');
                if (emptyState) emptyState.remove();
            }
            
            updateChatCounts();
            console.log('✅ Чат разархивирован');
        } else {
            alert('Ошибка: ' + data.message);
        }
    } catch (error) {
        console.error('Ошибка разархивирования:', error);
        alert('Не удалось разархивировать чат');
    }
}

// ========== Функции для нового UI ввода ==========

// Меню вложений
function toggleAttachMenu(event) {
    event.stopPropagation();
    event.preventDefault();
    
    const menu = document.getElementById('attach-menu');
    if (!menu) {
        console.error('attach-menu не найдено!');
        return;
    }
    
    const isVisible = menu.style.display === 'block';
    console.log('toggleAttachMenu вызвана, isVisible:', isVisible);
    
    if (isVisible) {
        menu.style.display = 'none';
        return;
    }
    
    // Закрываем все другие меню кроме attach-menu
    closeAllMenus('attach-menu');
    
    menu.style.display = 'block';
    console.log('Меню вложений открыто');
    
    // Закрываем при клике вне меню, игнорируя клики внутри модалок, чтобы не ломать стрелки/хоткеи
    setTimeout(() => {
        document.addEventListener('click', function closeMenu(e) {
            if (e.target.closest('.modal-overlay')) return;
            if (!e.target.closest('.attach-menu') && !e.target.closest('[onclick*="toggleAttachMenu"]')) {
                menu.style.display = 'none';
                document.removeEventListener('click', closeMenu);
            }
        });
    }, 100);
}

function openMediaPicker() {
    const menu = document.getElementById('attach-menu');
    if (menu) menu.style.display = 'none';
    
    const fileInput = document.getElementById('file-input');
    if (fileInput) {
        fileInput.click();
        console.log('Открыт выбор медиафайлов');
    }
}

function openDocPicker() {
    const menu = document.getElementById('attach-menu');
    if (menu) menu.style.display = 'none';
    
    const fileInput = document.getElementById('file-input-docs');
    if (fileInput) {
        fileInput.click();
        console.log('Открыт выбор документов');
    }
}

function createPoll() {
    const menu = document.getElementById('attach-menu');
    if (menu) menu.style.display = 'none';

    closePollBuilder();

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'pollBuilderModal';
    modal.innerHTML = `
        <div class="modal-content glass poll-builder">
            <div class="modal-header">
                <div class="modal-title">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M9 11l3 3L22 4" stroke-linecap="round" stroke-linejoin="round"></path>
                        <path d="M12 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14" stroke-linecap="round" stroke-linejoin="round"></path>
                    </svg>
                    <h3>Создать голосование</h3>
                </div>
                <button type="button" class="close-btn" onclick="closePollBuilder()">&times;</button>
            </div>
            <div class="modal-body poll-builder-body">
                <label class="poll-label" for="pollQuestion">Вопрос</label>
                <input type="text" id="pollQuestion" class="poll-input" placeholder="Например: когда встречаемся?" maxlength="200">

                <div class="poll-options-editor">
                    <div class="poll-options-header">
                        <span>Варианты ответов</span>
                        <button type="button" class="ghost-btn" onclick="addPollOption()">+ Добавить вариант</button>
                    </div>
                    <div id="pollOptionsList" class="poll-options-list"></div>
                </div>

                <div class="poll-settings">
                    <label class="poll-toggle">
                        <input type="checkbox" id="pollMultiple">
                        <span>Разрешить несколько ответов</span>
                    </label>
                    <label class="poll-toggle">
                        <input type="checkbox" id="pollAnonymous">
                        <span>Сделать голосование анонимным</span>
                    </label>
                </div>

                <div class="poll-preview-block">
                    <div class="poll-preview-title">Предпросмотр</div>
                    <div id="pollPreview" class="poll-preview"></div>
                </div>
            </div>
            <div class="modal-footer">
                <button type="button" class="primary-btn" onclick="submitPoll()">Опубликовать</button>
                <button type="button" class="secondary-btn" onclick="closePollBuilder()">Отмена</button>
            </div>
        </div>
    `;

    modal.addEventListener('click', (event) => {
        if (event.target === modal) {
            closePollBuilder();
        }
    });

    document.body.appendChild(modal);

    const questionInput = document.getElementById('pollQuestion');
    if (questionInput) {
        questionInput.addEventListener('input', updatePollPreview);
        setTimeout(() => questionInput.focus(), 50);
    }

    addPollOption();
    addPollOption();

    const multiple = document.getElementById('pollMultiple');
    const anonymous = document.getElementById('pollAnonymous');
    if (multiple) multiple.addEventListener('change', updatePollPreview);
    if (anonymous) anonymous.addEventListener('change', updatePollPreview);

    updatePollPreview();
}

function addPollOption(value = '') {
    const container = document.getElementById('pollOptionsList');
    if (!container) return;

    const rows = Array.from(container.querySelectorAll('.poll-option-editor-row'));
    if (rows.length >= 12) {
        alert('Можно добавить не более 12 вариантов.');
        return;
    }

    const row = document.createElement('div');
    row.className = 'poll-option-editor-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'poll-option-input';
    input.placeholder = Вариант ;
    input.maxLength = 100;
    input.value = value;
    input.addEventListener('input', updatePollPreview);

    const actions = document.createElement('div');
    actions.className = 'poll-option-actions';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'poll-option-action';
    upBtn.title = 'Переместить выше';
    upBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 15l6-6 6 6" stroke-linecap="round" stroke-linejoin="round"></path>
        </svg>
    `;
    upBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        movePollOption(row, -1);
    });

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'poll-option-action';
    downBtn.title = 'Переместить ниже';
    downBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 9l-6 6-6-6" stroke-linecap="round" stroke-linejoin="round"></path>
        </svg>
    `;
    downBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        movePollOption(row, 1);
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'poll-option-action danger';
    removeBtn.title = 'Удалить вариант';
    removeBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6" stroke-linecap="round" stroke-linejoin="round"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke-linecap="round" stroke-linejoin="round"></path>
        </svg>
    `;
    removeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        removePollOption(row);
    });

    actions.appendChild(upBtn);
    actions.appendChild(downBtn);
    actions.appendChild(removeBtn);

    row.appendChild(input);
    row.appendChild(actions);

    container.appendChild(row);

    input.focus();
    refreshPollOptionPlaceholders();
    updatePollPreview();
}

function movePollOption(row, direction) {
    const container = document.getElementById('pollOptionsList');
    if (!container) return;

    const rows = Array.from(container.children);
    const currentIndex = rows.indexOf(row);
    if (currentIndex === -1) return;

    const targetIndex = currentIndex + direction;
    if (targetIndex < 0 || targetIndex >= rows.length) return;

    if (direction < 0) {
        container.insertBefore(row, rows[targetIndex]);
    } else {
        container.insertBefore(row, rows[targetIndex].nextSibling);
    }

    refreshPollOptionPlaceholders();
    updatePollPreview();
}

function removePollOption(row) {
    const container = document.getElementById('pollOptionsList');
    if (!container) return;

    if (container.children.length <= 1) {
        const input = row.querySelector('.poll-option-input');
        if (input) {
            input.value = '';
            updatePollPreview();
        }
        return;
    }

    row.remove();
    refreshPollOptionPlaceholders();
    updatePollPreview();
}

function refreshPollOptionPlaceholders() {
    const container = document.getElementById('pollOptionsList');
    if (!container) return;

    const inputs = container.querySelectorAll('.poll-option-input');
    inputs.forEach((input, index) => {
        input.placeholder = Вариант ;
    });
}

function updatePollPreview() {
    const preview = document.getElementById('pollPreview');
    if (!preview) return;

    const questionInput = document.getElementById('pollQuestion');
    const question = questionInput ? questionInput.value.trim() : '';

    const options = Array.from(document.querySelectorAll('#pollOptionsList .poll-option-input'))
        .map((input) => input.value.trim())
        .filter((text) => text.length > 0);

    const multiple = !!(document.getElementById('pollMultiple') && document.getElementById('pollMultiple').checked);
    const anonymous = !!(document.getElementById('pollAnonymous') && document.getElementById('pollAnonymous').checked);

    if (options.length === 0) {
        preview.innerHTML = `<div class="poll-preview-placeholder">Добавьте варианты, чтобы увидеть, как участники будут голосовать.</div>`;
        return;
    }

    const optionsHtml = options.map((option) => `
        <div class="poll-preview-option">
            <span></span>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"></path>
            </svg>
        </div>
    `).join('');

    const footerParts = [];
    footerParts.push(multiple ? 'Можно выбрать несколько вариантов' : 'Один голос на участника');
    if (anonymous) footerParts.push('Голоса анонимные');

    preview.innerHTML = `
        <div class="poll-preview-question"></div>
        <div class="poll-preview-options"></div>
        <div class="poll-preview-footer"></div>
    `;
}

function closePollBuilder() {
    const modal = document.getElementById('pollBuilderModal');
    if (modal) modal.remove();
}

function submitPoll() {
    const questionInput = document.getElementById('pollQuestion');
    if (!questionInput) return;

    const question = questionInput.value.trim();
    const optionInputs = Array.from(document.querySelectorAll('#pollOptionsList .poll-option-input'));
    const options = optionInputs
        .map((input) => input.value.trim())
        .filter((text) => text.length > 0);

    const multiple = !!(document.getElementById('pollMultiple') && document.getElementById('pollMultiple').checked);
    const anonymous = !!(document.getElementById('pollAnonymous') && document.getElementById('pollAnonymous').checked);

    if (!question) {
        alert('Введите вопрос для голосования.');
        questionInput.focus();
        return;
    }

    if (options.length < 2) {
        alert('Добавьте как минимум два варианта ответа.');
        return;
    }

    if (!currentRoomId) {
        alert('Выберите чат, прежде чем создавать голосование.');
        return;
    }

    socket.emit('send_poll', {
        room_id: currentRoomId,
        question: question,
        options: options,
        multiple_choice: multiple,
        anonymous: anonymous
    });

    closePollBuilder();
}
// ========== СТИКЕРЫ ==========

// Встроенные стикер-паки
const stickerPacks = {
    emotions: {
        name: '😊 Эмоции',
        stickers: ['😀', '😂', '🤣', '😊', '😇', '🙂', '😉', '😍', '🥰', '😘', '😋', '😜', '🤪', '😎', '🤩', '🥳', '😏', '😒', '😞', '😔', '😢', '😭', '😤', '😠', '😱', '😨', '🤯', '😳', '🥺', '😬', '🙄', '😴', '🤤', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '😵', '🤠', '🥴', '😖', '😣', '😫', '😩', '🥱']
    },
    hands: {
        name: '👋 Жесты',
        stickers: ['👋', '🤚', '🖐', '✋', '🖖', '👌', '🤌', '🤏', '✌', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶']
    },
    animals: {
        name: '🐶 Животные',
        stickers: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒', '🐔', '🐧', '🐦', '🐤', '🐣', '🐥', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜', '🦟', '🦗', '🕷', '🦂', '🐢', '🐍', '🦎', '🦖', '🦕']
    },
    food: {
        name: '🍕 Еда',
        stickers: ['🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶', '🌽', '🥕', '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔', '🍟', '🍕', '🥪', '🥙', '🌮']
    },
    activities: {
        name: '⚽ Активности',
        stickers: ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷', '⛸', '🥌', '🎿', '⛷', '🏂', '🪂', '🏋', '🤼', '🤸', '🤺', '⛹', '🤾', '🏌', '🏇', '🧘', '🏊', '🤽', '🚣', '🧗', '🚴']
    },
    symbols: {
        name: '❤️ Символы',
        stickers: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮', '✝', '☪', '🕉', '☸', '✡', '🔯', '🕎', '☯', '☦', '🛐', '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓', '🆔', '⚛', '🉑', '☢', '☣', '📴']
    }
};

let currentStickerPack = 'emotions';

function toggleStickerPicker(event) {
    event.stopPropagation();
    event.preventDefault();
    
    // Создаем пикер если его нет
    let picker = document.getElementById('sticker-picker');
    
    if (!picker) {
        picker = createStickerPicker();
        document.body.appendChild(picker);
    }
    
    const isVisible = picker.style.display === 'block';
    
    if (isVisible) {
        picker.style.display = 'none';
        return;
    }
    
    closeAllMenus();
    picker.style.display = 'block';
    
    // Закрываем при клике вне пикера
    setTimeout(() => {
        document.addEventListener('click', function closePicker(e) {
            if (!e.target.closest('#sticker-picker') && !e.target.closest('[onclick*="toggleStickerPicker"]')) {
                picker.style.display = 'none';
                document.removeEventListener('click', closePicker);
            }
        });
    }, 100);
}

function createStickerPicker() {
    const picker = document.createElement('div');
    picker.id = 'sticker-picker';
    picker.className = 'sticker-picker glass';
    picker.style.cssText = `
        position: fixed;
        bottom: 80px;
        left: 20px;
        width: 380px;
        height: 450px;
        max-height: 80vh;
        background: var(--glass-bg);
        backdrop-filter: blur(var(--glass-blur)) saturate(180%);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-lg);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        z-index: 2000;
        display: none;
        overflow: hidden;
    `;
    
    // Вкладки паков
    const tabs = document.createElement('div');
    tabs.style.cssText = 'display: flex; border-bottom: 1px solid var(--glass-border); padding: 8px; gap: 4px; overflow-x: auto;';
    
    for (const [key, pack] of Object.entries(stickerPacks)) {
        const tab = document.createElement('button');
        tab.textContent = pack.name.split(' ')[0];
        tab.style.cssText = `
            padding: 6px 12px;
            border: none;
            background: ${key === currentStickerPack ? 'var(--color-primary)' : 'transparent'};
            color: var(--text-color);
            border-radius: var(--radius-md);
            cursor: pointer;
            font-size: 14px;
            transition: all 0.2s ease;
        `;
        tab.onclick = () => switchStickerPack(key);
        tabs.appendChild(tab);
    }
    
    picker.appendChild(tabs);
    
    // Контейнер для стикеров
    const container = document.createElement('div');
    container.id = 'sticker-container';
    container.style.cssText = 'padding: 12px; display: grid; grid-template-columns: repeat(8, 1fr); gap: 6px; height: calc(450px - 60px); overflow-y: auto;';
    
    renderStickers(container, currentStickerPack);
    picker.appendChild(container);
    
    return picker;
}

function switchStickerPack(packId) {
    currentStickerPack = packId;
    
    // Обновляем вкладки
    const tabs = document.querySelectorAll('#sticker-picker button');
    tabs.forEach((tab, index) => {
        const keys = Object.keys(stickerPacks);
        tab.style.background = keys[index] === packId ? 'var(--color-primary)' : 'transparent';
    });
    
    // Обновляем стикеры
    const container = document.getElementById('sticker-container');
    if (container) {
        renderStickers(container, packId);
    }
}

function renderStickers(container, packId) {
    container.innerHTML = '';
    const pack = stickerPacks[packId];
    
    if (!pack) return;
    
    pack.stickers.forEach(sticker => {
        const btn = document.createElement('button');
        btn.textContent = sticker;
        btn.style.cssText = `
            font-size: 32px;
            background: transparent;
            border: none;
            cursor: pointer;
            padding: 10px;
            border-radius: var(--radius-md);
            transition: all 0.2s ease;
            aspect-ratio: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 48px;
        `;
        btn.onmouseenter = (e) => e.target.style.transform = 'scale(1.3)';
        btn.onmouseleave = (e) => e.target.style.transform = 'scale(1)';
        btn.onclick = () => sendSticker(sticker);
        container.appendChild(btn);
    });
}

function sendSticker(sticker) {
    if (!currentRoomId) {
        alert('Выберите чат');
        return;
    }
    
    // Отправляем стикер как обычное сообщение
    socket.emit('send_message', {
        room_id: parseInt(currentRoomId),
        content: sticker
    });
    
    // Закрываем пикер
    const picker = document.getElementById('sticker-picker');
    if (picker) picker.style.display = 'none';
    
    console.log('Стикер отправлен:', sticker);
}

// Голосовые сообщения
let isRecordingVoice = false;
let voiceRecorder = null;
let voiceChunks = [];

function startVoiceRecording(event) {
    event.stopPropagation();
    event.preventDefault();
    
    if (isRecordingVoice) return;
    
    // Показываем индикатор записи
    const button = event.currentTarget;
    button.style.background = 'var(--color-danger)';
    button.style.animation = 'pulse 1s infinite';
    
    console.log('🎙️ Начало записи голосового сообщения...');
    
    // Запрашиваем доступ к микрофону
    navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => {
            isRecordingVoice = true;
            voiceRecorder = new MediaRecorder(stream);
            voiceChunks = [];
            
            voiceRecorder.ondataavailable = (e) => {
                voiceChunks.push(e.data);
            };
            
            voiceRecorder.onstop = async () => {
                const audioBlob = new Blob(voiceChunks, { type: 'audio/webm' });
                console.log('🎙️ Запись завершена, размер:', audioBlob.size);
                
                // Отправляем на сервер
                await sendVoiceMessage(audioBlob);
                
                // Останавливаем микрофон
                stream.getTracks().forEach(track => track.stop());
            };
            
            voiceRecorder.start();
            console.log('🎙️ Запись началась');
        })
        .catch(error => {
            console.error('Ошибка доступа к микрофону:', error);
            alert('Не удалось получить доступ к микрофону');
        });
}

function stopVoiceRecording(event) {
    event.stopPropagation();
    event.preventDefault();
    
    if (!isRecordingVoice || !voiceRecorder) return;
    
    // Убираем индикатор
    const button = event.currentTarget;
    button.style.background = '';
    button.style.animation = '';
    
    voiceRecorder.stop();
    isRecordingVoice = false;
    
    console.log('🎙️ Остановка записи...');
}

function closeAllMenus(exceptId = null) {
    const menus = document.querySelectorAll('.attach-menu, .call-dropdown-menu, .device-menu');
    menus.forEach(menu => {
        if (!exceptId || menu.id !== exceptId) {
            menu.style.display = 'none';
        }
    });
}

// Отправка голосового сообщения на сервер
async function sendVoiceMessage(audioBlob) {
    if (!currentRoomId) {
        alert('Выберите чат для отправки');
        return;
    }
    
    try {
        const formData = new FormData();
        formData.append('room_id', currentRoomId);
        formData.append('audio', audioBlob, `voice_${Date.now()}.webm`);
        
        console.log('📤 Отправка голосового сообщения...');
        
        const response = await fetch('/api/send_voice', {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        if (data.success) {
            console.log('✅ Голосовое сообщение отправлено!');
        } else {
            console.error('Ошибка отправки:', data.message);
            alert('Не удалось отправить голосовое сообщение: ' + data.message);
        }
    } catch (error) {
        console.error('Ошибка отправки голосового:', error);
        alert('Не удалось отправить голосовое сообщение');
    }
}

// Воспроизведение голосового сообщения
function playVoiceMessage(audioUrl) {
    const audio = new Audio(audioUrl);
    audio.play();
}

// Контекстное меню для чатов
let contextRoomId = null;

function showRoomContextMenu(event, roomItem) {
    const menu = document.getElementById('room-context-menu');
    const archiveBtn = document.getElementById('archive-room-btn');
    const unarchiveBtn = document.getElementById('unarchive-room-btn');
    
    contextRoomId = parseInt(roomItem.getAttribute('data-room-id'));
    const isArchived = roomItem.classList.contains('archived');
    
    // Показываем нужную кнопку
    if (isArchived) {
        archiveBtn.style.display = 'none';
        unarchiveBtn.style.display = 'flex';
    } else {
        archiveBtn.style.display = 'flex';
        unarchiveBtn.style.display = 'none';
    }
    
    // Позиционируем меню
    menu.style.display = 'block';
    menu.style.left = event.pageX + 'px';
    menu.style.top = event.pageY + 'px';
    
    // Закрываем при клике вне меню
    setTimeout(() => {
        document.addEventListener('click', function closeRoomMenu(e) {
            if (!e.target.closest('#room-context-menu')) {
                menu.style.display = 'none';
                document.removeEventListener('click', closeRoomMenu);
            }
        });
    }, 10);
}

// Обработчики кнопок контекстного меню чата
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('archive-room-btn').onclick = () => {
        if (contextRoomId) {
            archiveChat(contextRoomId);
            document.getElementById('room-context-menu').style.display = 'none';
        }
    };
    
    document.getElementById('unarchive-room-btn').onclick = () => {
        if (contextRoomId) {
            unarchiveChat(contextRoomId);
            document.getElementById('room-context-menu').style.display = 'none';
        }
    };
    
    document.getElementById('delete-room-context-btn').onclick = () => {
        if (contextRoomId) {
            // Открываем модальное окно управления комнатой для удаления
            selectRoomForSettings(contextRoomId);
            document.getElementById('room-context-menu').style.display = 'none';
        }
    };
});
let selectedMessages = new Set();

function toggleSelectionMode(enable) {
    selectionMode = enable;
    const bar = document.getElementById('selection-bar');
    const chatView = document.getElementById('chat-view');

    if (enable) {
        chatView.classList.add('selection-mode');
        bar.style.display = 'flex';
        // позиционирование контролируется CSS (центр main-content)
        bar.style.right = '';
        bar.style.bottom = '';
        updateSelectionCount();
    } else {
        chatView.classList.remove('selection-mode');
        bar.style.display = 'none';
        selectedMessages.clear();
        document.querySelectorAll('.message-container.selected').forEach(el => el.classList.remove('selected'));
    }
}

function toggleMessageSelection(messageId) {
    const stringId = String(messageId);
    const container = document.querySelector(`.message-container[data-message-id='${stringId}']`);
    if (!container) return;

    if (selectedMessages.has(stringId)) {
        selectedMessages.delete(stringId);
        container.classList.remove('selected');
    } else {
        selectedMessages.add(stringId);
        container.classList.add('selected');
    }

    if (selectedMessages.size === 0) {
        toggleSelectionMode(false);
    } else {
        updateSelectionCount();
    }
}

function updateSelectionCount() {
    document.getElementById('selection-count').textContent = `Выбрано: ${selectedMessages.size}`;
}

function deleteSelectedMessages() {
    if (selectedMessages.size === 0) return;
    openDeleteModal(Array.from(selectedMessages).map(id => parseInt(id)));
}

function cancelEditing() {
    editingMessage = null;
    document.getElementById('editing-banner').style.display = 'none';
    messageInput.value = '';
    // Кнопка отправки скрыта в UI, но переключатели оставляем на случай будущего возврата
    const si = document.getElementById('send-icon'); if (si) si.style.display = 'inline-block';
    const ei = document.getElementById('edit-confirm-icon'); if (ei) ei.style.display = 'none';
    const sbt = document.getElementById('send-button-text'); if (sbt) sbt.textContent = 'Отправить';
}

function setupRoomUI() {
    // По умолчанию разрешаем ввод
    chatInputArea.style.display = 'flex';
    if (messageInput) messageInput.disabled = false;
    if (sendButton) sendButton.disabled = false;
    if (messageInput) messageInput.placeholder = "Введите сообщение...";
    
    if (currentRoomType === 'dm') {
        if (callButton) callButton.style.display = 'inline-block';
        // Покажем баннер, если собеседник не в контактах
        const contactData = USER_CONTACTS.find(c => c.id == currentDMotherUserId);
        if (unknownBanner) unknownBanner.style.display = contactData ? 'none' : 'flex';
    } else if (currentRoomType === 'group' || currentRoomType === 'channel') {
        if (callButton) callButton.style.display = 'inline-block';
        // Кнопка участников убрана - доступна через три точки
        if (roomSettingsBtn) roomSettingsBtn.style.display = 'inline-block';
        if (unknownBanner) unknownBanner.style.display = 'none';
    } else {
        if (callButton) callButton.style.display = 'none';
        if (roomSettingsBtn) roomSettingsBtn.style.display = 'none';
        if (unknownBanner) unknownBanner.style.display = 'none';
        // Проверка для каналов: если тип 'channel' и роль не 'admin'
        if (currentRoomType === 'channel' && currentUserRole !== 'admin') {
            // Блокируем ввод для обычных пользователей в каналах
            if (messageInput) messageInput.disabled = true;
            if (sendButton) sendButton.disabled = true;
            if (messageInput) messageInput.placeholder = "Только администраторы могут писать в этом канале.";
        }
    }
}

function updateUnreadBadge(roomId, count) {
    const roomElement = document.querySelector(`.room-item[data-room-id="${roomId}"]`);
    if (!roomElement) return;

    let badge = roomElement.querySelector('.unread-badge');
    
    if (count > 0) {
        if (!badge) {
            // Создаем бейдж если его нет
            badge = document.createElement('span');
            badge.className = 'unread-badge';
            roomElement.appendChild(badge);
        }
        badge.textContent = count > 99 ? '99+' : count;
        badge.style.display = 'block';
    } else {
        if (badge) {
            badge.remove();
        }
    }
}

async function markRoomAsRead(roomId) {
    // Сначала обновляем UI немедленно
    updateUnreadBadge(roomId, 0);

    // Затем отправляем запрос на сервер
    try {
        await fetch('/api/mark_room_as_read', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ room_id: parseInt(roomId) })
        });
    } catch (error) {
        console.error('Не удалось отметить комнату как прочитанную:', error);
    }
}

async function loadChatHistory(roomId) {
    try {
        const response = await fetch(`/api/chat_history/${roomId}`);
        if (response.ok) {
            const messages = await response.json();
            messages.forEach(message => displayMessage(message));
        } else {
            console.error('Не удалось загрузить историю чата:', response.status);
            placeholderText.textContent = "Ошибка загрузки истории.";
            placeholderText.style.display = 'block';
        }
    } catch (error) {
        console.error('Ошибка при загрузке истории:', error);
    }
}

let selectedFiles = [];

function handleFileSelect(event) {
    const files = Array.from(event.target.files);
    selectedFiles = selectedFiles.concat(files);
    displayFilePreview();
    event.target.value = ''; // Сброс input для повторного выбора
}

function removeFileFromPreview(index) {
    selectedFiles.splice(index, 1);
    displayFilePreview();
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Б';
    if (!bytes) return '';
    const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    const formatted = size.toFixed(size < 10 && unitIndex > 0 ? 1 : 0);
    return `${formatted} ${units[unitIndex]}`;
}

function displayFilePreview() {
    const previewArea = document.getElementById('file-preview-area');
    const container = document.getElementById('file-preview-container');
    
    if (selectedFiles.length === 0) {
        previewArea.style.display = 'none';
        return;
    }
    
    previewArea.style.display = 'block';
    container.innerHTML = '';
    
    selectedFiles.forEach((file, index) => {
        const preview = document.createElement('div');
        preview.className = 'file-preview-item';
        
        const removeBtn = document.createElement('button');
        removeBtn.className = 'file-preview-remove';
        removeBtn.innerHTML = '×';
        removeBtn.onclick = () => removeFileFromPreview(index);
        
        if (file.type.startsWith('image/')) {
            const img = document.createElement('img');
            img.src = URL.createObjectURL(file);
            preview.appendChild(img);
        } else if (file.type.startsWith('video/')) {
            const video = document.createElement('video');
            video.src = URL.createObjectURL(file);
            video.controls = true;
            preview.appendChild(video);
        } else {
            const generic = document.createElement('div');
            generic.className = 'file-preview-generic';
            generic.innerHTML = `<span class="material-icons-round">description</span><div><strong>${file.name}</strong><span>${formatFileSize(file.size)}</span></div>`;
            preview.appendChild(generic);
        }

        preview.appendChild(removeBtn);
        container.appendChild(preview);
    });
}

async function sendMessage() {
    const content = messageInput.value.trim();

    if (editingMessage) {
        if (content && content !== editingMessage.content) {
            socket.emit('edit_message', {
                message_id: editingMessage.id,
                content: content
            });
        }
        cancelEditing();
        return;
    }
    
    if (selectedFiles.length > 0) {
        // Отправка файлов
        await sendFilesMessage(content);
        selectedFiles = [];
        displayFilePreview();
    } else if (content && currentRoomId) {
        // Обычное текстовое сообщение
        socket.emit('send_message', {
            room_id: parseInt(currentRoomId),
            content: content
        });
    }
    
    messageInput.value = '';
    messageInput.focus();
}

async function sendFilesMessage(caption) {
    const formData = new FormData();
    formData.append('room_id', currentRoomId);
    formData.append('caption', caption || '');
    
    selectedFiles.forEach(file => {
        formData.append('files', file);
    });
    
    try {
        const response = await fetch('/api/send_media', {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        if (!data.success) {
            alert('Ошибка отправки файлов: ' + (data.message || 'неизвестная ошибка'));
        }
    } catch (error) {
        console.error('Ошибка отправки файлов:', error);
        alert('Не удалось отправить файлы');
    }
}

function displayMessage(data) {
    // Проверяем тип сообщения
    if (data.message_type === 'system') {
        // Системное сообщение
        const systemMsg = document.createElement('div');
        systemMsg.className = 'system-message';
        systemMsg.textContent = data.content;
        systemMsg.setAttribute('data-message-id', data.id);
        chatWindow.appendChild(systemMsg);
        chatWindow.scrollTop = chatWindow.scrollHeight;
        return;
    }
    
    if (data.message_type === 'call') {
        // Карточка звонка
        const isVideo = data.content.includes('видеозвонок');
        const isIncoming = data.content.includes('Входящий');
        const card = document.createElement('div');
        card.className = 'call-card';
        card.setAttribute('data-message-id', data.id);
        card.setAttribute('data-call-id', data.id);
        
        const statusText = data.call_duration ? 'Завершен' : 'Активен';
        
        card.innerHTML = `
            <div class="call-card-header">
                <div class="call-card-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2">
                        ${isVideo ? 
                            '<path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>' :
                            '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>'
                        }
                    </svg>
                </div>
                <div class="call-card-info">
                    <h4 class="call-card-title">${data.content}</h4>
                    <p class="call-card-subtitle">${statusText}</p>
                </div>
            </div>
            ${data.call_duration ? `<div class="call-card-duration">Длительность: ${data.call_duration}</div>` : ''}
        `;
        
        chatWindow.appendChild(card);
        chatWindow.scrollTop = chatWindow.scrollHeight;
        return;
    }
    
    // Голосовое сообщение
    if (data.message_type === 'voice' && data.media_url) {
        const voiceContainer = document.createElement('div');
        voiceContainer.className = `message-container ${data.sender_id == CURRENT_USER_ID ? 'sent' : 'received'}`;
        voiceContainer.setAttribute('data-message-id', data.id);
        
        const voiceContent = `
            <div class="message ${data.sender_id == CURRENT_USER_ID ? 'sent' : 'received'}" style="padding: 12px 16px;">
                ${data.sender_id != CURRENT_USER_ID ? `<span class="message-sender">${data.sender_name || 'Пользователь'}</span>` : ''}
                <div style="display: flex; align-items: center; gap: 10px;">
                    <button onclick="playVoiceMessage('${data.media_url}')" style="background: transparent; border: none; cursor: pointer; padding: 0; display: flex;">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="12" cy="12" r="10" fill="var(--color-primary)" opacity="0.2"/>
                            <polygon points="10,8 16,12 10,16" fill="var(--color-primary)"/>
                        </svg>
                    </button>
                    <audio id="voice-${data.id}" src="${data.media_url}" preload="metadata"></audio>
                    <div style="flex: 1;">
                        <div style="font-size: 11px; opacity: 0.8;">🎤 Голосовое сообщение</div>
                        <div id="voice-duration-${data.id}" style="font-size: 10px; opacity: 0.6;">0:00</div>
                    </div>
                </div>
                <span class="message-timestamp">${new Date(data.timestamp).toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'})}</span>
            </div>
        `;
        
        voiceContainer.innerHTML = voiceContent;
        chatWindow.appendChild(voiceContainer);
        chatWindow.scrollTop = chatWindow.scrollHeight;
        
        // Загружаем длительность
        const audio = document.getElementById(`voice-${data.id}`);
        if (audio) {
            audio.addEventListener('loadedmetadata', () => {
                const duration = Math.floor(audio.duration);
                const minutes = Math.floor(duration / 60);
                const seconds = duration % 60;
                const durationEl = document.getElementById(`voice-duration-${data.id}`);
                if (durationEl) {
                    durationEl.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
                }
            });
        }
        
        return;
    }
    
    // Обычное текстовое сообщение
    const messageContainer = document.createElement('div');
    messageContainer.classList.add('message-container');
    messageContainer.setAttribute('data-message-id', data.id);

    // НОВОЕ: Индикатор выделения
    const indicator = document.createElement('div');
    indicator.className = 'selection-indicator';
    messageContainer.appendChild(indicator);

    const innerContainer = document.createElement('div');
    innerContainer.className = 'message-container-inner';

    const messageElement = document.createElement('div');
    messageElement.classList.add('message');
    
    const isSent = data.sender_id == CURRENT_USER_ID;
    messageContainer.classList.add(isSent ? 'sent' : 'received');
    innerContainer.classList.add(isSent ? 'sent' : 'received'); // For alignment
    messageElement.classList.add(isSent ? 'sent' : 'received');

    // --- EVENT LISTENERS ---

    // Right-click anywhere on the row to open context menu
    messageContainer.oncontextmenu = (event) => openMessageContextMenu(event, data);

    // Left-click anywhere on the row
    messageContainer.onclick = (event) => {
        event.stopPropagation(); // Stop from bubbling to body

        if (selectionMode) {
            toggleMessageSelection(data.id);
        } else {
            // If not in selection mode, a click on the message bubble opens the reaction picker
            // We check if the click target is the bubble or inside it
            if (messageElement.contains(event.target)) {
                openReactionPicker(event, data.id, messageElement); // Pass messageElement for positioning
            }
        }
    };
    
    // Добавляем имя отправителя (для Групп и Каналов, если сообщение не от нас)
    if ((currentRoomType === 'group' || currentRoomType === 'channel') && !isSent) {
        const senderName = document.createElement('span');
        senderName.classList.add('message-sender');
        senderName.textContent = '@' + data.sender_username;
        messageElement.appendChild(senderName);
    }

    // Опрос
    if (data.message_type === 'poll') {
        const container = document.createElement('div');
        container.className = `message-container ${data.sender_id == CURRENT_USER_ID ? 'sent' : 'received'}`;
        container.setAttribute('data-message-id', data.id);
        const inner = document.createElement('div');
        inner.className = `message ${data.sender_id == CURRENT_USER_ID ? 'sent' : 'received'}`;
                const poll = data.poll || {};
        const pollBox = document.createElement('div');
        pollBox.className = 'poll-container';

        const questionEl = document.createElement('div');
        questionEl.className = 'poll-question';
        questionEl.textContent = poll.question || 'Голосование';
        pollBox.appendChild(questionEl);

        const optionsWrap = document.createElement('div');
        optionsWrap.className = 'poll-options';
        pollBox.appendChild(optionsWrap);

        const footer = document.createElement('div');
        footer.className = 'poll-footer';

        const tip = document.createElement('span');
        tip.className = 'poll-tip';
        footer.appendChild(tip);

        const total = document.createElement('span');
        total.className = 'poll-total';
        footer.appendChild(total);

        pollBox.appendChild(footer);

        container.appendChild(inner);
        chatWindow.appendChild(container);
        // Рендерим варианты и текущие результаты
        renderPollOptionsAndResults(pollBox, data.id, poll);
        chatWindow.scrollTop = chatWindow.scrollHeight;
        return;
    }

    // НОВОЕ: Обработка галереи медиа
    if (data.media_items && data.media_items.length > 0) {
        const gallery = document.createElement('div');
        gallery.className = 'message-media-gallery';
        if (data.media_items.length > 1) {
            gallery.classList.add(`gallery-grid-${Math.min(data.media_items.length, 4)}`);
        }

        data.media_items.forEach(item => {
            if (item.type === 'image') {
                const img = document.createElement('img');
                img.src = item.url;
                img.alt = 'Изображение';
                img.onclick = () => window.open(item.url, '_blank');
                gallery.appendChild(img);
            } else if (item.type === 'video') {
                const video = document.createElement('video');
                video.src = item.url;
                video.controls = true;
                video.preload = 'metadata';
                gallery.appendChild(video);
            }
        });
        messageElement.appendChild(gallery);
    }
    
    // Добавляем текст если есть
    if (data.content) {
        const textNode = document.createElement('p');
        textNode.textContent = data.content;
        messageElement.appendChild(textNode);
    }
    
    // Добавление времени
    const timestampSpan = document.createElement('span');
    timestampSpan.classList.add('message-timestamp');
    const date = new Date(data.timestamp);
    timestampSpan.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    messageElement.appendChild(timestampSpan);

    innerContainer.appendChild(messageElement);

    // НОВОЕ: Добавляем контейнер для реакций
    const reactionsContainer = document.createElement('div');
    reactionsContainer.classList.add('reactions-container');
    innerContainer.appendChild(reactionsContainer);
    
    messageContainer.appendChild(innerContainer);
    chatWindow.appendChild(messageContainer);

    // НОВОЕ: Отображаем существующие реакции
    if (data.reactions && Object.keys(data.reactions).length > 0) {
        updateMessageReactionsUI(data.id, data.reactions);
    }

    chatWindow.scrollTop = chatWindow.scrollHeight;
}

// --- НОВОЕ: Функции Реакций и редактирования ---
function editMessage(messageId, currentContent) {
    // Если сообщение для редактирования - только медиа без текста
    const contentToEdit = currentContent || '';
    
    editingMessage = { id: messageId, content: contentToEdit };

    // Показываем баннер
    const banner = document.getElementById('editing-banner');
    document.getElementById('editing-banner-text').textContent = contentToEdit;
    banner.style.display = 'flex';

    // Обновляем поле ввода
    messageInput.value = contentToEdit;
    messageInput.focus();

    // Обновляем кнопку отправки
    const si2 = document.getElementById('send-icon'); if (si2) si2.style.display = 'none';
    const ei2 = document.getElementById('edit-confirm-icon'); if (ei2) ei2.style.display = 'inline-block';
    const sbt2 = document.getElementById('send-button-text'); if (sbt2) sbt2.textContent = 'Сохранить';
}

function deleteMessage(messageId) {
    openDeleteModal([messageId]);
}

let contextTargetMessage = null; // Храним данные о сообщении для контекстного меню

function openMessageContextMenu(event, messageData) {
    event.preventDefault();
    event.stopPropagation();

    const isSent = messageData.sender_id == CURRENT_USER_ID;
    if (!isSent) return; // Меню только для своих сообщений

    contextTargetMessage = messageData;

    const menu = document.getElementById('message-context-menu');
    menu.style.display = 'block';

    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;

    let left = event.clientX;
    let top = event.clientY;

    // Корректировка, чтобы меню не выходило за пределы экрана
    if (left + menuWidth > windowWidth) {
        left = windowWidth - menuWidth - 5;
    }
    if (top + menuHeight > windowHeight) {
        top = windowHeight - menuHeight - 5;
    }
    
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}

function openReactionPicker(event, messageId, messageElementRef) {
    event.stopPropagation(); 
    
    reactionTargetMessageId = messageId;
    const messageElement = messageElementRef || event.currentTarget;

    // Позиционируем пикер НАД сообщением
    const rect = messageElement.getBoundingClientRect();
    reactionPicker.style.bottom = `${window.innerHeight - rect.top + 5}px`;
    reactionPicker.style.top = 'auto';
    
    if (messageElement.classList.contains('sent')) {
        reactionPicker.style.left = 'auto';
        reactionPicker.style.right = `${window.innerWidth - rect.right}px`;
    } else {
        reactionPicker.style.left = `${rect.left}px`;
        reactionPicker.style.right = 'auto';
    }
    
    reactionPicker.style.display = 'flex';
}

// Вызывается из body.onclick
function closeReactionPicker() {
    if (reactionPicker.style.display === 'flex') {
        reactionPicker.style.display = 'none';
        reactionPicker.classList.remove('expanded');
        
        // Сбрасываем все скрытые эмоции
        const hiddenReactions = reactionPicker.querySelectorAll('.hidden-reaction');
        hiddenReactions.forEach(reaction => {
            reaction.style.display = '';
            reaction.style.visibility = '';
        });
        
        // Показываем кнопку "..." снова
        const moreBtn = reactionPicker.querySelector('.reaction-more');
        if (moreBtn) {
            moreBtn.style.display = '';
        }
        
        reactionTargetMessageId = null;
    }
    const contextMenu = document.getElementById('message-context-menu');
    if (contextMenu.style.display === 'block') {
        contextMenu.style.display = 'none';
        contextTargetMessage = null;
    }
}

function expandReactionPicker(event) {
    if (event) event.stopPropagation();
    const picker = document.getElementById('reaction-picker');
    
    // Показываем все скрытые эмоции
    const hiddenReactions = picker.querySelectorAll('.hidden-reaction');
    hiddenReactions.forEach(reaction => {
        reaction.style.display = 'inline-block';
        reaction.style.visibility = 'visible';
    });
    
    // Скрываем кнопку "..."
    const moreBtn = picker.querySelector('.reaction-more');
    if (moreBtn) {
        moreBtn.style.display = 'none';
    }
    
    // Расширяем пикер
    picker.classList.add('expanded');
    
    console.log('Пикер расширен. Показано эмоций:', hiddenReactions.length);
}

function sendReaction(emoji) {
    if (reactionTargetMessageId) {
        // Отправляем событие 'add' через SocketIO
        socket.emit('react_to_message', {
            message_id: reactionTargetMessageId,
            emoji: emoji,
            action: 'add'
        });
    }
    closeReactionPicker();
}

function toggleReaction(messageId, emoji, isReactedByMe) {
    // Переключаем реакцию: если уже стоит - удаляем, если нет - добавляем
    const action = isReactedByMe ? 'remove' : 'add';
    socket.emit('react_to_message', {
        message_id: messageId,
        emoji: emoji,
        action: action
    });
}

function updateMessageReactionsUI(messageId, reactions) {
    // Обновляем UI на основе полного состояния реакций, полученного от сервера
    const messageContainer = document.querySelector(`.message-container[data-message-id="${messageId}"]`);
    if (!messageContainer) return;

    const reactionsContainer = messageContainer.querySelector('.reactions-container');
    reactionsContainer.innerHTML = ''; // Очищаем текущие реакции

    // Рендерим обновленный список
    for (const emoji in reactions) {
        const userIds = reactions[emoji];
        const count = userIds.length;
        const isReactedByMe = userIds.includes(CURRENT_USER_ID);

        const reactionElement = document.createElement('span');
        reactionElement.classList.add('reaction');
        if (isReactedByMe) {
            reactionElement.classList.add('reacted-by-me');
        }
        reactionElement.textContent = `${emoji} ${count}`;
        
        // Добавляем обработчик клика для переключения реакции
        reactionElement.onclick = (event) => {
            event.stopPropagation(); // Предотвращаем срабатывание пикера сообщения
            toggleReaction(messageId, emoji, isReactedByMe);
        };

        reactionsContainer.appendChild(reactionElement);
    }
}

// --- Управление Сайдбаром (Обновлено для Аватаров) ---

function addNewRoomToSidebar(room) {
    let existingElement = document.querySelector(`.room-item[data-room-id="${room.id}"]`);
    if (existingElement) {
        return updateRoomInSidebar(room);
    }

    const emptyState = document.getElementById('empty-state-rooms');
    if (emptyState) emptyState.remove();

    const li = document.createElement('li');
    li.classList.add('room-item');
    li.setAttribute('data-room-id', room.id);
    li.setAttribute('data-room-name', room.name);
    li.setAttribute('data-room-type', room.type);
    li.setAttribute('data-user-role', room.role);
    li.setAttribute('data-dm-other-id', room.dm_other_user_id || '');
    
    const icon = document.createElement('span');
    icon.classList.add('room-icon');
    // Обработка аватара и иконок
    if (room.avatar_url) {
         icon.innerHTML = `<img src="${room.avatar_url}" alt="Avatar">`;
    } else if (room.type === 'dm') {
        icon.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="8" r="5"></circle>
            <path d="M20 21a8 8 0 1 0-16 0"></path>
        </svg>`;
    } else if (room.type === 'group') {
        icon.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
        </svg>`;
    } else if (room.type === 'channel') {
        icon.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>`;
    }
    // Индикатор онлайн ТОЛЬКО для личных чатов (DM)
    if (room.type === 'dm' && room.dm_other_user_id) {
        const dot = document.createElement('span');
        dot.className = 'presence-dot';
        dot.setAttribute('data-user-id', room.dm_other_user_id);
        icon.appendChild(dot);
    }
    
    const nameText = document.createElement('span');
    nameText.classList.add('room-name-text');
    nameText.textContent = room.name;

    li.appendChild(icon);
    li.appendChild(nameText);
    
    // Добавляем бейдж непрочитанных, если есть
    if (room.unread_count && room.unread_count > 0) {
        const badge = document.createElement('span');
        badge.className = 'unread-badge';
        badge.textContent = room.unread_count > 99 ? '99+' : room.unread_count;
        li.appendChild(badge);
    }

    li.onclick = () => selectRoom(li);
    roomList.insertBefore(li, roomList.firstChild);
    return li;
}

function updateRoomInSidebar(room) {
    let element = document.querySelector(`.room-item[data-room-id="${room.id}"]`);
    if (element) {
        element.setAttribute('data-room-name', room.name);
        element.setAttribute('data-user-role', room.role);
        
        // Обновляем текст имени
        const nameText = element.querySelector('.room-name-text');
        if (nameText) nameText.textContent = room.name;

        // НОВОЕ: Обновляем аватар
        const iconSpan = element.querySelector('.room-icon');
        if (iconSpan) {
            if (room.avatar_url) {
                if (!iconSpan.querySelector('img')) {
                    iconSpan.innerHTML = `<img src="${room.avatar_url}" alt="Avatar">`;
                } else {
                    iconSpan.querySelector('img').src = room.avatar_url;
                }
            } else {
                 // Если аватара нет, возвращаем иконку
                 if (room.type === 'dm') {
                     iconSpan.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                         <circle cx="12" cy="8" r="5"></circle>
                         <path d="M20 21a8 8 0 1 0-16 0"></path>
                     </svg>`;
                 } else if (room.type === 'group') {
                     iconSpan.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                     </svg>`;
                 } else if (room.type === 'channel') {
                     iconSpan.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                         <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                     </svg>`;
                 }
            }
        }

        // Обновляем/добавляем presence-dot ТОЛЬКО для личных чатов (DM)
        if (room.type === 'dm' && room.dm_other_user_id) {
            let dot = iconSpan.querySelector('.presence-dot');
            if (!dot) {
                dot = document.createElement('span');
                dot.className = 'presence-dot';
                dot.setAttribute('data-user-id', room.dm_other_user_id);
                iconSpan.appendChild(dot);
            } else {
                dot.setAttribute('data-user-id', room.dm_other_user_id);
            }
        } else {
            // Удаляем индикатор если это не DM
            const existingDot = iconSpan.querySelector('.presence-dot');
            if (existingDot) {
                existingDot.remove();
            }
        }

        // Если это текущая открытая комната, обновляем заголовок и роль
        if (currentRoomId == room.id) {
            chatWithName.textContent = room.name;
            currentUserRole = room.role;
            setupRoomUI();
        }
    }
    return element;
}

// --- НОВОЕ: Контекстные Настройки (Контакт/Группа) ---

function openContextSettings() {
    if (currentRoomType === 'dm') {
        openContactSettings();
    } else if (currentRoomType === 'group' || currentRoomType === 'channel') {
        openRoomSettings();
    }
}

// 1. Настройки Контакта (Переименование)
async function openContactSettings() {
    if (!currentDMotherUserId) return;
    
    const modal = document.getElementById('contactSettingsModal');
    document.getElementById('contactSettingsId').value = currentDMotherUserId;
    
    // Находим текущее кастомное имя и другие данные контакта
    const contactData = USER_CONTACTS.find(c => c.id == currentDMotherUserId);
    if (contactData) {
        // Заполняем username
        const usernameEl = document.getElementById('contactUsername');
        if (usernameEl) usernameEl.textContent = `@${contactData.username}`;
        
        // Заполняем кастомное имя для редактирования
        if (contactData.display_name !== `@${contactData.username}`) {
            document.getElementById('contactCustomName').value = contactData.display_name;
        } else {
            document.getElementById('contactCustomName').value = '';
        }
    }
    
    // Получаем информацию о пользователе (био, аватар, статистику)
    try {
        const response = await fetch(`/api/search_user?q=${contactData.username}`);
        const data = await response.json();
        
        if (data.success && data.results && data.results.length > 0) {
            const user = data.results[0];
            
            // Заполняем био
            const bioEl = document.getElementById('contactBio');
            if (bioEl) bioEl.textContent = user.bio || 'Био не указано';
        }
    } catch (e) {
        console.log('Не удалось загрузить информацию о контакте:', e);
    }
    
    // Заполняем аватар (если есть в room-icon)
    const roomElement = document.querySelector(`.room-item[data-dm-other-id="${currentDMotherUserId}"]`);
    if (roomElement) {
        const avatarImg = roomElement.querySelector('.room-icon img');
        const avatarPreview = document.getElementById('contactAvatarPreview');
        if (avatarImg && avatarPreview) {
            avatarPreview.innerHTML = `<img src="${avatarImg.src}" alt="Avatar" style="width: 100%; height: 100%; object-fit: cover; border-radius: inherit;">`;
        }
    }
    
    // Получаем статистику сообщений для текущей комнаты
    if (currentRoomId) {
        try {
            const response = await fetch(`/api/chat_history/${currentRoomId}`);
            const messages = await response.json();
            
            const messagesCountEl = document.getElementById('contactMessagesCount');
            if (messagesCountEl) messagesCountEl.textContent = messages.length || '0';
        } catch (e) {
            console.log('Не удалось загрузить статистику сообщений:', e);
        }
    }
    
    // Статус онлайн (пока просто "недавно")
    const lastSeenEl = document.getElementById('contactLastSeen');
    if (lastSeenEl) lastSeenEl.textContent = 'недавно';
    
    // Проверяем, заблокирован ли пользователь
    try {
        // Простая проверка через попытку отправки сообщения (не выполняется, просто проверяем состояние)
        // Обновляем кнопку блокировки в зависимости от статуса
        const isBlocked = blockedUsers.has(parseInt(contactId));
        updateBlockButton(isBlocked);
    } catch (e) {
        console.log('Не удалось проверить статус блокировки:', e);
    }
    
    modal.style.display = 'flex';
}

async function saveContactSettings() {
    const contactId = document.getElementById('contactSettingsId').value;
    const customName = document.getElementById('contactCustomName').value;
    const messageBox = document.getElementById('contactSettingsMessage');

    try {
        const response = await fetch('/api/update_contact', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ contact_id: parseInt(contactId), custom_name: customName }),
        });
        const data = await response.json();

        if (data.success) {
            showMessage(messageBox, data.message, 'success');
            // Обновляем локальный список USER_CONTACTS
            const contactData = USER_CONTACTS.find(c => c.id == contactId);
            if (contactData) {
                contactData.display_name = customName || `@${contactData.username}`;
            }
            // Сервер отправит событие 'room_updated' для обновления UI.
            setTimeout(() => closeModal({target: document.getElementById('contactSettingsModal'), forceClose: true}), 500);
        } else {
            showMessage(messageBox, data.message, 'error');
        }
    } catch (error) {
        showMessage(messageBox, 'Ошибка сети.', 'error');
    }
}

// 2. Настройки Комнаты (Название, Участники, Аватар)
async function openRoomSettings() {
    const modal = document.getElementById('roomSettingsModal');
    document.getElementById('roomSettingsId').value = currentRoomId;
    document.getElementById('roomSettingsTitle').textContent = `Управление: ${chatWithName.textContent}`;
    
    // Получаем текущие данные комнаты из сайдбара
    const roomElement = document.querySelector(`.room-item[data-room-id="${currentRoomId}"]`);
    const roomName = roomElement.getAttribute('data-room-name');
    const roomType = roomElement.getAttribute('data-room-type');
    
    // Заполняем информационную секцию
    const nameDisplay = document.getElementById('roomSettingsNameDisplay');
    const typeDisplay = document.getElementById('roomSettingsTypeDisplay');
    if (nameDisplay) nameDisplay.textContent = roomName;
    if (typeDisplay) {
        const typeText = roomType === 'group' ? 'Группа' : roomType === 'channel' ? 'Канал' : 'Чат';
        typeDisplay.textContent = typeText;
    }
    
    // Заполняем поля редактирования (только для админов)
    document.getElementById('roomSettingsName').value = roomName;

    // Получаем текущий аватар
    const avatarImg = roomElement.querySelector('.room-icon img');
    const avatarPreview = document.getElementById('roomSettingsAvatarPreview');
    if (avatarImg && avatarPreview) {
        avatarPreview.innerHTML = `<img src="${avatarImg.src}" alt="Avatar" style="width: 100%; height: 100%; object-fit: cover; border-radius: inherit;">`;
        // Показываем кнопку удаления, если аватар загружен
        const removeBtn = document.getElementById('removeRoomAvatarBtn');
        if (removeBtn) removeBtn.style.display = 'inline-block';
    } else {
        // Возвращаем иконку по умолчанию
        if (avatarPreview) {
            avatarPreview.innerHTML = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
            </svg>`;
        }
        const removeBtn = document.getElementById('removeRoomAvatarBtn');
        if (removeBtn) removeBtn.style.display = 'none';
    }
    
    document.getElementById('roomSettingsAvatar').value = avatarImg ? avatarImg.src : '';
    
    // Обновляем текст кнопки в зависимости от типа
    const membersButtonText = document.getElementById('members-button-text');
    if (membersButtonText) {
        membersButtonText.textContent = roomType === 'channel' ? 'Подписчики' : 'Участники';
    }
    
    // Получаем количество участников/подписчиков
    try {
        const response = await fetch(`/api/room_members/${currentRoomId}`);
        const data = await response.json();
        if (data.success) {
            const membersCountEl = document.getElementById('roomMembersCount');
            if (membersCountEl) membersCountEl.textContent = data.members.length;
        }
    } catch (e) {
        console.log('Не удалось загрузить количество участников:', e);
    }
    
    // Получаем статистику комнаты
    try {
        const response = await fetch(`/api/chat_history/${currentRoomId}`);
        const messages = await response.json();
        
        // Подсчитываем сообщения
        const messagesCountEl = document.getElementById('roomMessagesCount');
        if (messagesCountEl) messagesCountEl.textContent = messages.length || '0';
        
        // Подсчитываем медиа (фото и видео)
        let mediaCount = 0;
        messages.forEach(msg => {
            if (msg.media_items && msg.media_items.length > 0) {
                mediaCount += msg.media_items.length;
            }
            if (msg.media_url) {
                mediaCount++;
            }
        });
        const mediaCountEl = document.getElementById('roomMediaCount');
        if (mediaCountEl) mediaCountEl.textContent = mediaCount;
        
        // Подсчитываем ссылки (простой подсчет http/https в тексте)
        let linksCount = 0;
        messages.forEach(msg => {
            if (msg.content) {
                const urlRegex = /https?:\/\/[^\s]+/g;
                const matches = msg.content.match(urlRegex);
                if (matches) linksCount += matches.length;
            }
        });
        const linksCountEl = document.getElementById('roomLinksCount');
        if (linksCountEl) linksCountEl.textContent = linksCount;
    } catch (e) {
        console.log('Не удалось загрузить статистику комнаты:', e);
    }

    const adminSettings = document.getElementById('admin-only-settings');
    
    if (currentUserRole === 'admin') {
        adminSettings.style.display = 'block';
        populateAddMembersSelector();
    } else {
        adminSettings.style.display = 'none';
    }
    
    modal.style.display = 'flex';
}

function populateAddMembersSelector() {
    const selector = document.getElementById('addRoomMembersSelect');
    selector.innerHTML = '';
    // TODO: Для лучшего UX нужно запросить список участников группы и исключить их.
    // Пока показываем все контакты. Бэкенд отфильтрует тех, кто уже в группе.

    if (USER_CONTACTS.length === 0) {
        selector.innerHTML = '<p class="empty-state small">У вас нет контактов.</p>';
        return;
    }

    USER_CONTACTS.forEach(contact => {
        const div = document.createElement('div');
        div.classList.add('contact-checkbox');
        div.innerHTML = `<input type="checkbox" id="add-member-${contact.id}" value="${contact.id}">
                         <label for="add-member-${contact.id}">${contact.display_name}</label>`;
        selector.appendChild(div);
    });
}

async function updateRoomDetails() {
    const roomId = document.getElementById('roomSettingsId').value;
    const name = document.getElementById('roomSettingsName').value;
    const avatarUrl = document.getElementById('roomSettingsAvatar').value;
    const messageBox = document.getElementById('roomSettingsMessage');

    try {
        const response = await fetch('/api/update_room', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ room_id: parseInt(roomId), name: name, avatar_url: avatarUrl }),
        });
        const data = await response.json();

        if (data.success) {
            showMessage(messageBox, data.message, 'success');
            // Сервер отправит 'room_updated' для обновления UI у всех.
        } else {
            showMessage(messageBox, data.message, 'error');
        }
    } catch (error) {
        showMessage(messageBox, 'Ошибка сети.', 'error');
    }
}

async function addRoomMembers() {
    const roomId = document.getElementById('roomSettingsId').value;
    const messageBox = document.getElementById('roomSettingsMessage');

    const selectedMembers = [];
    document.querySelectorAll('#addRoomMembersSelect input[type="checkbox"]:checked').forEach(checkbox => {
        selectedMembers.push(parseInt(checkbox.value));
    });

    if (selectedMembers.length === 0) return;

    try {
        const response = await fetch('/api/add_room_members', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ room_id: parseInt(roomId), members: selectedMembers }),
        });
        const data = await response.json();

        if (data.success) {
            showMessage(messageBox, data.message, 'success');
            // Сбрасываем галочки
            document.querySelectorAll('#addRoomMembersSelect input[type="checkbox"]:checked').forEach(cb => cb.checked = false);
        } else {
            showMessage(messageBox, data.message, 'error');
        }
    } catch (error) {
        showMessage(messageBox, 'Ошибка сети.', 'error');
    }
}


// --- Утилиты (Modal, Search, CreateRoom, Settings) ---
function clearChatWindow() {
    chatWindow.innerHTML = '<div class="placeholder-text" id="placeholder-text" style="display: none;"></div>';
}

// === Присутствие/Печатает и Тест соединения ===
let typingTimeoutId = null;
function throttleTyping() {
    socket.emit('typing', { room_id: parseInt(currentRoomId), is_typing: true });
    if (typingTimeoutId) clearTimeout(typingTimeoutId);
    typingTimeoutId = setTimeout(() => {
        socket.emit('typing', { room_id: parseInt(currentRoomId), is_typing: false });
    }, 1200);
}

function updatePresenceHeader(presenceMap) {
    try {
        // Убрали отображение счетчика онлайн в заголовке
        // Только обновляем зеленые кружки на аватарах
        
        document.querySelectorAll('.presence-dot')
            .forEach(dot => {
                const uid = parseInt(dot.getAttribute('data-user-id'));
                if (!isNaN(uid) && presenceMap) {
                    if (presenceMap[uid]) {
                        dot.classList.add('online');
                    } else {
                        dot.classList.remove('online');
                    }
                }
            });
    } catch(e) {
        console.error('Ошибка обновления присутствия:', e);
    }
}

function applyPresenceUpdate(userId, online) {
    // Обновляем все точки присутствия для данного пользователя
    document.querySelectorAll(`.presence-dot[data-user-id="${userId}"]`).forEach(dot => {
        if (online) {
            dot.classList.add('online');
        } else {
            dot.classList.remove('online');
        }
    });
}

function showTypingIndicator(userId, isTyping) {
    const box = document.getElementById('callInfo');
    if (!box) return;
    if (isTyping) {
        box.style.display = 'block';
        box.textContent = 'Кто-то печатает…';
        clearTimeout(box._hideTimer);
        box._hideTimer = setTimeout(() => { box.style.display = 'none'; }, 1500);
    }
}

async function runConnectivityTest() {
    const box = document.getElementById('connectivityResult');
    try {
        console.log('[Connectivity Test] Начало диагностики сети...');
        
        // Media permissions
        let audioOk = false, videoOk = false;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
            audioOk = stream.getAudioTracks().length > 0;
            videoOk = stream.getVideoTracks().length > 0;
            stream.getTracks().forEach(t => t.stop());
        } catch (e) {
            console.warn('[Connectivity Test] Ошибка доступа к медиа:', e);
        }

        // ICE candidates - собираем и анализируем
        const pc = new RTCPeerConnection(rtcConfig);
        const candidates = [];
        pc.onicecandidate = (ev) => { 
            if (ev.candidate) {
                candidates.push(ev.candidate.candidate);
                console.log('[Connectivity Test] Получен кандидат:', ev.candidate.candidate);
            }
        };
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await pc.setLocalDescription(offer);
        await new Promise(res => setTimeout(res, 3000)); // Даём больше времени для сбора кандидатов
        pc.close();
        
        // Анализируем типы кандидатов
        const hasHost = candidates.some(c => c.includes('typ host'));
        const hasSrflx = candidates.some(c => c.includes('typ srflx'));
        const hasRelay = candidates.some(c => c.includes('typ relay'));
        
        console.log('[Connectivity Test] Результаты:');
        console.log('  - Host кандидаты (локальные):', hasHost ? 'Да' : 'Нет');
        console.log('  - Srflx кандидаты (через STUN):', hasSrflx ? 'Да' : 'Нет');
        console.log('  - Relay кандидаты (через TURN):', hasRelay ? 'Да' : 'Нет');
        console.log('  - Всего кандидатов:', candidates.length);
        
        // Определяем возможность P2P соединения
        let summary = `Камера: ${videoOk ? '✅' : '❌'}, Микрофон: ${audioOk ? '✅' : '❌'}\n`;
        summary += `ICE кандидаты: Host: ${hasHost ? '✅' : '❌'}, Srflx: ${hasSrflx ? '✅' : '❌'}, Relay: ${hasRelay ? '✅' : '❌'}\n`;
        
        if (hasSrflx) {
            summary += 'P2P соединения через интернет: ВОЗМОЖНЫ ✅';
            showMessage(box, summary, 'success');
        } else if (hasRelay) {
            summary += 'P2P через интернет: требуется TURN сервер ⚠️';
            showMessage(box, summary, 'warning');
        } else {
            summary += 'P2P через интернет: НЕВОЗМОЖНЫ (только локальная сеть) ❌';
            showMessage(box, summary, 'error');
        }
    } catch (err) {
        console.error('[Connectivity Test] Ошибка:', err);
        showMessage(box, 'Тест не выполнен: ' + err.message, 'error');
    }
}

function handleKeyPress(event) {
    if (event.key === 'Enter' && !messageInput.disabled) sendMessage();
    else {
        if (currentRoomId) throttleTyping();
    }
}

// --- Видеозвонки ---
function openCallModal() {
    if (isCallModalOpen) return; // Предотвращаем повторное открытие
    openModal('callModal');
    document.getElementById('callTitle').textContent = currentRoomType === 'dm' ? `Звонок: ${chatWithName.textContent}` : `Групповой звонок: ${chatWithName.textContent}`;
    isCallModalOpen = true;
    
    // Закрываем диалоговое окно набора если оно открыто
    closeDialModal();
}

function openDialModal(title = 'Идёт вызов…', status = '') {
    const dialTitle = document.getElementById('dialTitle');
    const dialStatus = document.getElementById('dialStatus');
    if (dialTitle) dialTitle.textContent = title;
    if (dialStatus) dialStatus.textContent = status;
    openModal('dialModal');
    isDialModalOpen = true;
}

function setDialStatus(text) {
    const dialStatus = document.getElementById('dialStatus');
    if (dialStatus) dialStatus.textContent = text || '';
}

function closeDialModal() {
    const overlay = document.getElementById('dialModal');
    if (overlay) overlay.style.display = 'none';
    isDialModalOpen = false;
}

function cancelDialing() {
    endCall();
}

async function ensureLocalMedia() {
    if (localStream) return localStream;
    try {
        // Пытаемся получить аудио+видео
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: true
        });
    } catch (e1) {
        // Если камера занята/нет — пробуем только аудио
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                video: false
            });
            isCamEnabled = false;
        } catch (e2) {
            // Если и аудио занято — пробрасываем исходную ошибку
            alert('Нет доступа к микрофону/камере');
            throw e1;
        }
    }
    const localVideo = document.getElementById('localVideo');
    if (localVideo) {
        localVideo.srcObject = localStream;
        // ИСПРАВЛЕНИЕ ЭХА: локальное видео всегда muted чтобы не было эха
        localVideo.muted = true;
    }
    isMicEnabled = true;
    
    // Обновляем визуальное состояние кнопок
    const micBtn = document.getElementById('toggleMicBtn');
    const camBtn = document.getElementById('toggleCamBtn');
    if (micBtn) {
        micBtn.classList.remove('disabled');
        micBtn.classList.add('enabled');
    }
    if (camBtn) {
        camBtn.classList.remove('disabled');
        camBtn.classList.add(isCamEnabled ? 'enabled' : 'disabled');
    }
    
    return localStream;
}

async function openCall() {
    console.log('openCall() начата');
    try {
        // ВАЖНО: Сначала устанавливаем время начала звонка
        callStartTime = Date.now();
        console.log('callStartTime установлен:', callStartTime);
        
        // Используем новую функцию с поддержкой аудио/видео режима
        console.log('Запрос доступа к медиа...');
        await ensureLocalMediaWithMode();
        console.log('Доступ к медиа получен');
        
        // Сразу открываем окно звонка (без промежуточного dialModal)
        openCallModal();
        console.log('Модальное окно звонка открыто');
        
        // Показываем индикатор активного звонка (теперь callStartTime уже установлен)
        showCallIndicator();
        console.log('Индикатор звонка показан');
        
        updateCallIndicatorInfo(
            currentRoomType === 'dm' ? chatWithName.textContent : `Групповой звонок`,
            isAudioOnly ? 'Аудиозвонок' : 'Видеозвонок'
        );
        
        // Добавляем карточку звонка в чат
        const callCardData = {
            id: Date.now(),
            direction: 'outgoing',
            type: isAudioOnly ? 'audio' : 'video',
            status: 'active'
        };
        console.log('Добавление карточки звонка:', callCardData);
        addCallCard(callCardData);
        
    if (currentRoomType === 'dm') {
        await startP2PCall(parseInt(currentDMotherUserId), false);
        socket.emit('call_action', { target_user_id: parseInt(currentDMotherUserId), action: 'start' });
    } else if (currentRoomType === 'group' || currentRoomType === 'channel') {
            // Для группового звонка - создаем лобби, но НЕ рассылаем приглашения
            // Уведомляем сервер что звонок начат (для показа индикатора в чате)
            socket.emit('room_call_action', { 
                room_id: parseInt(currentRoomId), 
                action: 'lobby_created',
                initiator_id: CURRENT_USER_ID
            });
            
            // Сохраняем ID активного группового звонка
            activeGroupCallRoomId = currentRoomId;
            
            // Показываем кнопку "Пригласить участников" в окне звонка
            showInviteButton();
        }
    } catch (error) {
        console.error('Ошибка при начале звонка:', error);
        alert('Не удалось начать звонок. Проверьте доступ к камере/микрофону.');
        endCall();
    }
}

// Переиспользуем кнопку «Позвонить» - по умолчанию видеозвонок
function startCall() {
    console.log('startCall() вызвана. currentRoomType:', currentRoomType, 'currentRoomId:', currentRoomId);
    
    // Проверяем что выбрана комната
    if (!currentRoomId) {
        alert('Выберите чат для звонка');
        return;
    }
    
    // Проверяем блокировку перед звонком (для DM)
    if (currentRoomType === 'dm' && currentDMotherUserId) {
        if (blockedUsers.has(parseInt(currentDMotherUserId))) {
            alert('Вы не можете позвонить заблокированному пользователю.');
            return;
        }
    }
    
    isAudioOnly = false; // По умолчанию видео
    console.log('Вызов openCall()');
    openCall(); 
}

// --- Вспомогательные элементы входящего звонка ---
let ringtoneAudio = null;
let incomingFromUserId = null;
// ========== Звуковые уведомления ==========
let audioContext = null;
let ringtoneOscillator = null;
let ringtoneGainNode = null;
let ringtoneInterval = null;
let currentRingtone = localStorage.getItem('selectedRingtone') || 'marimba';

// Библиотека мелодий рингтонов
const ringtones = {
    marimba: {
        name: 'Marimba (iPhone)',
        notes: [
            {freq: 523.25, start: 0, duration: 0.18},
            {freq: 659.25, start: 0.2, duration: 0.18},
            {freq: 880.0, start: 0.4, duration: 0.25},
            {freq: 659.25, start: 0.7, duration: 0.18},
            {freq: 987.77, start: 0.88, duration: 0.32}
        ],
        interval: 2200
    },
    ascending: {
        name: 'Подъём',
        notes: [
            {freq: 392.0, start: 0, duration: 0.25},
            {freq: 523.25, start: 0.32, duration: 0.25},
            {freq: 659.25, start: 0.64, duration: 0.28},
            {freq: 784.0, start: 0.97, duration: 0.35}
        ],
        interval: 2500
    },
    ripple: {
        name: 'Волна',
        notes: [
            {freq: 698.46, start: 0, duration: 0.22},
            {freq: 440.0, start: 0.24, duration: 0.22},
            {freq: 587.33, start: 0.48, duration: 0.22},
            {freq: 880.0, start: 0.72, duration: 0.36}
        ],
        interval: 2300
    },
    gentle: {
        name: 'Спокойствие',
        notes: [
            {freq: 493.88, start: 0, duration: 0.6},
            {freq: 392.0, start: 0.65, duration: 0.55}
        ],
        interval: 2700
    },
    cheerful: {
        name: 'Настроение',
        notes: [
            {freq: 523.25, start: 0, duration: 0.16},
            {freq: 659.25, start: 0.18, duration: 0.16},
            {freq: 783.99, start: 0.36, duration: 0.16},
            {freq: 1046.5, start: 0.56, duration: 0.28},
            {freq: 880.0, start: 0.92, duration: 0.24}
        ],
        interval: 2400
    }
};


// ========== Функции для работы с аватарками в placeholder ==========
async function loadUserAvatar(placeholderElement, userId) {
    if (!placeholderElement) return;
    
    try {
        // Получаем данные пользователя
        const response = await fetch(`/api/user/${userId}`);
        const data = await response.json();
        
        if (data.success && data.user && data.user.avatar_url) {
            const avatarDiv = placeholderElement.querySelector('.video-placeholder-avatar');
            if (avatarDiv) {
                avatarDiv.innerHTML = `<img src="${data.user.avatar_url}" alt="Avatar">`;
            }
        }
    } catch (error) {
        console.error('Ошибка загрузки аватарки:', error);
    }
}

// Создаём AudioContext при первом использовании
function getAudioContext() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioContext;
}

// Воспроизводим входящий звонок
function playRingtone() {
    try {
        stopRingtone();
        
        const ctx = getAudioContext();
        const ringtone = ringtones[currentRingtone] || ringtones.marimba;
        
        const playRingtoneTone = () => {
            ringtone.notes.forEach(note => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                
                osc.connect(gain);
                gain.connect(ctx.destination);
                
                osc.frequency.value = note.freq;
                osc.type = 'sine';
                gain.gain.value = 0.2;
                
                // Плавное затухание для мягкости
                gain.gain.setValueAtTime(0.2, ctx.currentTime + note.start);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + note.start + note.duration);
                
                osc.start(ctx.currentTime + note.start);
                osc.stop(ctx.currentTime + note.start + note.duration);
            });
        };
        
        playRingtoneTone();
        ringtoneInterval = setInterval(playRingtoneTone, ringtone.interval);
        
    } catch (e) {
        console.error('Ошибка воспроизведения рингтона:', e);
    }
}

function stopRingtone() {
    try {
        if (ringtoneInterval) {
            clearInterval(ringtoneInterval);
            ringtoneInterval = null;
        }
        if (ringtoneOscillator) {
            ringtoneOscillator.stop();
            ringtoneOscillator = null;
        }
        if (ringtoneGainNode) {
            ringtoneGainNode = null;
        }
    } catch (e) {
        // Игнорируем ошибки при остановке
    }
}

// Звук уведомления о новом сообщении
function playMessageSound() {
    try {
        const ctx = getAudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        osc.frequency.value = 800;
        osc.type = 'sine';
        gain.gain.value = 0.2;
        
        // Быстрый звук "плинь"
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
        
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.1);
    } catch (e) {
        console.error('Ошибка воспроизведения звука сообщения:', e);
    }
}

// ===== РИНГТОНЫ: выбор и предпрослушка =====
function previewRingtone() {
    try {
        const sel = document.getElementById('settingsRingtone');
        if (!sel) return;
        const val = sel.value;
        // сохраняем выбор
        try { localStorage.setItem('selectedRingtone', val); } catch {}
        currentRingtone = val;
        // проигрываем короткий предпросмотр
        stopRingtone();
        const ctx = getAudioContext();
        const ring = ringtones[currentRingtone] || ringtones.marimba;
        ring.notes.forEach(note => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = note.freq;
            osc.type = 'sine';
            gain.gain.value = 0.2;
            gain.gain.setValueAtTime(0.2, ctx.currentTime + note.start);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + note.start + note.duration);
            osc.start(ctx.currentTime + note.start);
            osc.stop(ctx.currentTime + note.start + note.duration);
        });
    } catch (e) {
        console.error('previewRingtone error:', e);
    }
}

// ===== ОПРОСЫ (UI) =====
function renderPollOptionsAndResults(pollContainer, messageId, poll) {
    const optionsWrap = pollContainer.querySelector('.poll-options');
    if (!optionsWrap) return;

    optionsWrap.innerHTML = '';

    const footerTip = pollContainer.querySelector('.poll-tip');
    const totalLabel = pollContainer.querySelector('.poll-total');
    const totalVotes = Array.isArray(poll.results)
        ? poll.results.reduce((sum, count) => sum + (Number(count) || 0), 0)
        : 0;

    (poll.options || []).forEach((optText, idx) => {
        const votes = Array.isArray(poll.results) ? (Number(poll.results[idx]) || 0) : 0;
        const percent = totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : 0;

        const row = document.createElement('div');
        row.className = 'poll-option-row';

        const bar = document.createElement('div');
        bar.className = 'poll-bar';
        bar.style.width = `${percent}%`;
        row.appendChild(bar);

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'poll-vote-btn';
        button.innerHTML = `
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"></path>
            </svg>
        `;
        row.appendChild(button);

        const content = document.createElement('div');
        content.className = 'poll-option-content';

        const textSpan = document.createElement('span');
        textSpan.className = 'poll-option-text';
        textSpan.textContent = optText;
        content.appendChild(textSpan);

        const votesSpan = document.createElement('span');
        votesSpan.className = 'poll-option-votes';
        votesSpan.textContent = totalVotes > 0 ? `${votes} · ${percent}%` : `${votes}`;
        content.appendChild(votesSpan);

        row.appendChild(content);

        const castVote = (event) => {
            event.stopPropagation();
            if (!poll.multiple_choice) {
                socket.emit('vote_poll', { message_id: messageId, selected: idx });
            } else {
                socket.emit('vote_poll', { message_id: messageId, selected: [idx] });
            }
            row.classList.add('poll-option-voted');
            setTimeout(() => row.classList.remove('poll-option-voted'), 420);
        };

        button.addEventListener('click', castVote);
        row.addEventListener('click', castVote);

        optionsWrap.appendChild(row);
    });

    if (footerTip) {
        const tips = [];
        tips.push(poll.multiple_choice ? 'Можно выбрать несколько вариантов' : 'Выберите один вариант');
        if (poll.anonymous) {
            tips.push('Голосование анонимное');
        }
        footerTip.textContent = tips.join(' · ');
    }

    if (totalLabel) {
        totalLabel.textContent = totalVotes > 0 ? `Голосов: ${totalVotes}` : 'Голосов пока нет';
    }
}
function renderPollResults(pollContainer, messageId, poll) {
    // Просто переиспользуем общий рендер
    renderPollOptionsAndResults(pollContainer, messageId, poll);
}
function showIncomingPopup(fromUserId, fromName) {
    incomingFromUserId = fromUserId;
    const popup = document.getElementById('incomingCallPopup');
    const text = document.getElementById('incomingCallText');
    text.textContent = `${fromName} звонит вам`;
    popup.style.display = 'flex';
    
    // Показываем браузерное уведомление о входящем звонке
    showBrowserNotification('Входящий звонок', {
        body: fromName + ' звонит вам',
        tag: 'call-' + fromUserId,
        requireInteraction: true // Уведомление не закроется автоматически
    });
}
function hideIncomingPopup() {
    const popup = document.getElementById('incomingCallPopup');
    if (popup) popup.style.display = 'none';
    incomingFromUserId = null;
}

async function acceptIncomingCall() {
    stopRingtone();
    hideIncomingPopup();
    
    // Открываем основное окно звонка сразу
    openCallModal();
    
    // Показываем индикатор звонка
    showCallIndicator();
    updateCallIndicatorInfo('Входящий звонок', 'Подключение...');
    
    // Добавляем карточку входящего звонка в чат
    const callCardData = {
        id: Date.now(),
        direction: 'incoming',
        type: isAudioOnly ? 'audio' : 'video',
        status: 'active'
    };
    addCallCard(callCardData);
    
    try {
        await ensureLocalMediaWithMode();
        await startP2PCall(incomingFromUserId, true);
        // Сообщаем звонящему, что вызов принят (снимает у него «Соединение…»)
        socket.emit('call_action', { target_user_id: parseInt(incomingFromUserId), action: 'accept' });
    } catch (error) {
        console.error('Ошибка при ответе на звонок:', error);
        alert('Не удалось ответить на звонок. Проверьте доступ к камере/микрофону.');
        endCall();
    }
}
function rejectIncomingCall() {
    stopRingtone();
    if (incomingFromUserId) {
        socket.emit('call_action', { target_user_id: incomingFromUserId, action: 'reject' });
    }
    hideIncomingPopup();
}

function createPeerConnection(remoteUserId) {
    const pc = new RTCPeerConnection(rtcConfig);
    
    // Локальные дорожки - добавляем с явным указанием stream для лучшей совместимости
    localStream.getTracks().forEach(t => {
        console.log(`[RTC ${remoteUserId}] Добавление трека:`, t.kind, t.enabled);
        pc.addTrack(t, localStream);
    });
    // Входящее медиа
    pc.ontrack = (ev) => {
        // Safari iOS часто не присылает streams в ontrack → собираем из ev.track
        const stream = (ev.streams && ev.streams[0]) ? ev.streams[0] : new MediaStream([ev.track]);
        attachRemoteStream(remoteUserId, stream);
        // Как только получили первый удалённый трек — открываем основное окно, закрываем «набор»
        if (!isCallModalOpen) {
            openCallModal();
        }
        // Закрываем окошко ожидания без условий — к этому моменту соединение уже установлено
        closeDialModal();
    };
    // ICE - отправляем ВСЕ кандидаты (включая IPv6) для максимальной совместимости
    pc.onicecandidate = (ev) => {
        if (ev.candidate) {
            const candidateStr = ev.candidate.candidate;
            // Логируем тип кандидата для диагностики
            const type = candidateStr.includes('typ host') ? 'host' : 
                        candidateStr.includes('typ srflx') ? 'srflx' : 
                        candidateStr.includes('typ relay') ? 'relay' : 'unknown';
            console.log(`[RTC ${remoteUserId}] ICE кандидат (${type}):`, candidateStr.substring(0, 50) + '...');
            
            socket.emit('webrtc_signal', {
                target_user_id: remoteUserId,
                signal: { type: 'ice', candidate: ev.candidate }
            });
        } else {
            console.log(`[RTC ${remoteUserId}] ICE gathering завершен`);
        }
    };
	// Диагностика ICE/RTC
	pc.onicecandidateerror = (ev) => {
		console.warn(`[RTC ${remoteUserId}] ICE ошибка: ${ev.errorText} (${ev.errorCode}) - ${ev.url || 'N/A'}`);
	};
	pc.onicegatheringstatechange = () => {
		console.log(`[RTC ${remoteUserId}] iceGatheringState: ${pc.iceGatheringState}`);
	};
	pc.oniceconnectionstatechange = () => {
		console.log(`[RTC ${remoteUserId}] iceConnectionState: ${pc.iceConnectionState}`);
		if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
			console.log(`[RTC ${remoteUserId}] ✅ ICE соединение установлено!`);
		}
		if (pc.iceConnectionState === 'failed') {
			console.error(`[RTC ${remoteUserId}] ❌ ICE соединение не удалось! Попробуйте:
1. Проверить настройки брандмауэра
2. Убедиться что UDP порты не заблокированы
3. Проверить доступность STUN/TURN серверов`);
		}
	};
	// ГЛАВНЫЙ ОБРАБОТЧИК СОСТОЯНИЯ: закрываем модалку «ожидание», когда WebRTC соединение переходит в состояние connected
	pc.onconnectionstatechange = () => {
		console.log(`[RTC ${remoteUserId}] connectionState: ${pc.connectionState}`);
		if (pc.connectionState === 'connected') {
			console.log(`[RTC ${remoteUserId}] ✅ Соединение установлено!`);
			if (!isCallModalOpen) {
                openCallModal();
            }
			closeDialModal();
		}
		if (pc.connectionState === 'failed') {
			console.error(`[RTC ${remoteUserId}] ❌ Соединение не удалось!`);
		}
	};
	pc.onsignalingstatechange = () => {
		console.log(`[RTC ${remoteUserId}] signalingState: ${pc.signalingState}`);
	};
    // Если у нас уже были кандидат(ы) для этого пользователя до создания PC
    if (pendingIceByPeer[remoteUserId] && pendingIceByPeer[remoteUserId].length) {
        const queued = pendingIceByPeer[remoteUserId];
        delete pendingIceByPeer[remoteUserId];
        queued.forEach(async cand => {
            try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch {}
        });
    }
    return pc;
}

function attachRemoteStream(userId, stream) {
    let container = document.getElementById(`remoteContainer-${userId}`);
    let video = document.getElementById(`remoteVideo-${userId}`);
    let placeholder = document.getElementById(`remotePlaceholder-${userId}`);
    
    if (!container) {
        // Создаем контейнер для видео и placeholder
        container = document.createElement('div');
        container.id = `remoteContainer-${userId}`;
        container.style.position = 'relative';
        container.style.width = '100%';
        container.style.height = '100%';
        container.style.minHeight = '200px';
        
        // Создаем видео элемент
        video = document.createElement('video');
        video.id = `remoteVideo-${userId}`;
        video.autoplay = true; 
        video.playsInline = true;
        video.muted = false; // ВАЖНО: не mute чтобы слышать собеседника
        video.setAttribute('playsinline', 'true');
        video.setAttribute('webkit-playsinline', 'true');
        video.style.width = '100%';
        video.style.height = '100%';
        video.style.objectFit = 'cover';
        video.style.transition = 'opacity 0.3s ease';
        
        // Создаем placeholder
        placeholder = document.createElement('div');
        placeholder.id = `remotePlaceholder-${userId}`;
        placeholder.className = 'video-placeholder';
        placeholder.innerHTML = `
            <div class="video-placeholder-avatar">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                    <circle cx="12" cy="7" r="4"></circle>
                </svg>
            </div>
            <div class="video-placeholder-text">Камера выключена</div>
        `;
        
        container.appendChild(video);
        container.appendChild(placeholder);
        document.getElementById('remoteVideos').appendChild(container);
        
        // Загружаем аватарку пользователя
        loadUserAvatar(placeholder, userId);
    }
    
    video.srcObject = stream;
    
    // Отслеживаем треки - если видеотрек заканчивается, показываем placeholder
    if (stream) {
        const videoTracks = stream.getVideoTracks();
        if (videoTracks.length > 0) {
            video.style.opacity = '1';
            placeholder.classList.remove('active');
            
            videoTracks.forEach(track => {
                track.onended = () => {
                    console.log(`Видеотрек от ${userId} завершен`);
                    video.style.opacity = '0';
                    placeholder.classList.add('active');
                };
            });
        } else {
            // Нет видеотрека - только аудио
            video.style.opacity = '0';
            placeholder.classList.add('active');
        }
    }
    
    // Попытка воспроизведения
    try {
        const playPromise = video.play();
        if (playPromise !== undefined) {
            playPromise
                .then(() => console.log(`✅ Удалённое видео ${userId} запущено`))
                .catch((error) => console.log(`Видео ${userId} ожидает взаимодействия`));
        }
    } catch (error) {
        // Autoplay заблокирован
    }
}

async function startP2PCall(otherUserId, isAnswerSide) {
    const pc = createPeerConnection(otherUserId);
    peerConnections[otherUserId] = pc;
    // Небольшая телеметрия состояния для отладки подключений
    try {
        pc.oniceconnectionstatechange = () => {
            if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                closeDialModal();
                if (!isCallModalOpen) openCallModal();
            }
        };
    } catch {}

    if (!isAnswerSide) {
        // Явно запрашиваем прием аудио/видео треков собеседника
        // Добавляем опции для лучшей совместимости с мобильными
        const offerOptions = {
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
            voiceActivityDetection: true
        };
        
        const offer = await pc.createOffer(offerOptions);
        await pc.setLocalDescription(offer);
        
        console.log(`[RTC ${otherUserId}] Offer создан:`, {
            audio: offer.sdp.includes('m=audio'),
            video: offer.sdp.includes('m=video')
        });
        
        socket.emit('webrtc_signal', { target_user_id: otherUserId, signal: { type: 'offer', sdp: offer } });
    }
}

async function handleSignal(fromUser, signal) {
    let pc = peerConnections[fromUser];
    if (!pc && signal.type !== 'ice') {
        // создаем при первом сигнале (обычно offer)
        await ensureLocalMedia();
        pc = createPeerConnection(fromUser);
        peerConnections[fromUser] = pc;
    }
    if (!signal || !signal.type) return;
    if (signal.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        
        // Явно запрашиваем прием аудио/видео при ответе
        const answerOptions = {
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
            voiceActivityDetection: true
        };
        
        const answer = await pc.createAnswer(answerOptions);
        await pc.setLocalDescription(answer);
        
        console.log(`[RTC ${fromUser}] Answer создан:`, {
            audio: answer.sdp.includes('m=audio'),
            video: answer.sdp.includes('m=video')
        });
        
        socket.emit('webrtc_signal', { target_user_id: fromUser, signal: { type: 'answer', sdp: answer } });
    } else if (signal.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    } else if (signal.type === 'ice' && signal.candidate) {
        if (!pc) {
            // Буферизуем ICE до момента создания PC
            if (!pendingIceByPeer[fromUser]) pendingIceByPeer[fromUser] = [];
            pendingIceByPeer[fromUser].push(signal.candidate);
            return;
        }
        try { await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch {}
    }
}

// Примитивная групп. реализация: все участники получают список участников и устанавливают P2P между собой
async function joinGroupCall(roomId) {
    await ensureLocalMedia();
    if (typeof window.SFU_JOIN === 'function') {
        try {
            await window.SFU_JOIN(parseInt(roomId), localStream);
            return;
        } catch (e) {
            console.warn('SFU join failed, fallback to mesh:', e);
        }
    }
    // Fallback: P2P mesh
    const res = await fetch(`/api/room_members/${roomId}`);
    const data = await res.json();
    if (!data.success) return;
    for (const m of data.members) {
        if (m.id === CURRENT_USER_ID) continue;
        await startP2PCall(m.id, false);
    }
}

function toggleMic() {
    if (!localStream) return;
    isMicEnabled = !isMicEnabled;
    localStream.getAudioTracks().forEach(t => t.enabled = isMicEnabled);
    
    const btn = document.getElementById('toggleMicBtn');
    if (btn) {
        btn.classList.remove('enabled', 'disabled');
        btn.classList.add(isMicEnabled ? 'enabled' : 'disabled');
    }
}

async function toggleCam() {
    if (!localStream) return;
    
    const videoTracks = localStream.getVideoTracks();
    const localVideo = document.getElementById('localVideo');
    const localPlaceholder = document.getElementById('localVideoPlaceholder');
    
    if (videoTracks.length > 0) {
        // Переключаем состояние камеры
    isCamEnabled = !isCamEnabled;
        
        if (!isCamEnabled) {
            // ВЫКЛЮЧАЕМ камеру
            console.log('Выключение камеры - создание черного видео...');
            
            // Создаем черный видеотрек вместо null
            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 480;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'black';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            // Создаем stream из черного canvas
            const blackStream = canvas.captureStream(1); // 1 FPS
            const blackTrack = blackStream.getVideoTracks()[0];
            
            // Заменяем треки у всех peer connections черным видео
            for (const id in peerConnections) {
                const sender = peerConnections[id].getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    await sender.replaceTrack(blackTrack);
                    console.log(`Отправлен черный экран для peer ${id}`);
                }
            }
            
            // Останавливаем оригинальные треки камеры
            videoTracks.forEach(t => {
                t.enabled = false;
                t.stop();
            });
            
            // Показываем placeholder локально
            if (localVideo) localVideo.style.opacity = '0';
            if (localPlaceholder) {
                localPlaceholder.classList.add('active');
                loadUserAvatar(localPlaceholder, CURRENT_USER_ID);
            }
            
            console.log('✅ Камера выключена, отправляется черный экран');
        } else {
            // ВКЛЮЧАЕМ камеру заново - запрашиваем новый трек
            console.log('Включение камеры...');
            try {
                const constraints = selectedCamId 
                    ? { video: { deviceId: { exact: selectedCamId } } }
                    : { video: true };
                    
                const videoStream = await navigator.mediaDevices.getUserMedia(constraints);
                const newVideoTrack = videoStream.getVideoTracks()[0];
                console.log('Новый видеотрек получен:', newVideoTrack);
                
                // Удаляем старые остановленные видео треки из localStream (если есть)
                const oldVideoTracks = localStream.getVideoTracks();
                console.log('Удаление старых треков:', oldVideoTracks.length);
                oldVideoTracks.forEach(t => localStream.removeTrack(t));
                
                // Добавляем новый трек
                localStream.addTrack(newVideoTrack);
                console.log('Новый трек добавлен в localStream');
                
                // ВАЖНО: Обновляем srcObject с новым stream
                if (localVideo) {
                    // Создаем новый MediaStream с аудио и новым видео
                    const newStream = new MediaStream([
                        ...localStream.getAudioTracks(),
                        newVideoTrack
                    ]);
                    console.log('Обновление localVideo.srcObject, треков:', newStream.getTracks().length);
                    localVideo.srcObject = newStream;
                    localVideo.style.opacity = '1';
                    localVideo.style.display = 'block';
                    
                    // Обеспечиваем воспроизведение
                    try {
                        await localVideo.play();
                        console.log('localVideo.play() успешно');
                    } catch (e) {
                        console.log('Автовоспроизведение заблокировано:', e);
                    }
                }
                
                // Скрываем placeholder
                if (localPlaceholder) {
                    localPlaceholder.classList.remove('active');
                    console.log('Placeholder скрыт');
                }
                
                // Добавляем трек во все соединения
                for (const id in peerConnections) {
                    const sender = peerConnections[id].getSenders().find(s => !s.track || s.track.kind === 'video');
                    if (sender) {
                        await sender.replaceTrack(newVideoTrack);
                        console.log(`Трек заменен для peer ${id}`);
                    } else {
                        // Если sender нет, добавляем трек
                        peerConnections[id].addTrack(newVideoTrack, localStream);
                        console.log(`Трек добавлен для peer ${id}`);
                    }
                }
                
                console.log('✅ Камера включена заново, видео восстановлено');
            } catch (error) {
                console.error('❌ Не удалось включить камеру:', error);
                alert('Не удалось получить доступ к камере');
                isCamEnabled = false;
            }
        }
    } else if (!isCamEnabled) {
        // Если видео трека нет и хотим включить - запрашиваем камеру
        try {
            const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
            const videoTrack = videoStream.getVideoTracks()[0];
            
            localStream.addTrack(videoTrack);
            
            // Обновляем localVideo
            if (localVideo) {
                // Создаем новый MediaStream
                const newStream = new MediaStream([
                    ...localStream.getAudioTracks(),
                    videoTrack
                ]);
                localVideo.srcObject = newStream;
                localVideo.style.opacity = '1';
                
                // Воспроизводим
                try {
                    await localVideo.play();
                } catch (e) {
                    console.log('Автовоспроизведение:', e);
                }
            }
            
            // Скрываем placeholder
            if (localPlaceholder) {
                localPlaceholder.classList.remove('active');
            }
            
            // Обновляем все peer connections
            for (const id in peerConnections) {
                const sender = peerConnections[id].getSenders().find(s => s.track && s.track.kind === 'video');
                if (!sender) {
                    // Добавляем новый sender если его нет
                    peerConnections[id].addTrack(videoTrack, localStream);
                } else {
                    // Заменяем трек
                    await sender.replaceTrack(videoTrack);
                }
            }
            
            isCamEnabled = true;
            isAudioOnly = false; // Больше не аудио-режим
            
            console.log('Камера включена (первый раз)');
        } catch (error) {
            console.error('Не удалось включить камеру:', error);
            alert('Не удалось получить доступ к камере');
            isCamEnabled = false;
        }
    }
    
    const btn = document.getElementById('toggleCamBtn');
    if (btn) {
        btn.classList.remove('enabled', 'disabled');
        btn.classList.add(isCamEnabled ? 'enabled' : 'disabled');
    }
}

function setShareBtnState(sharing) {
    const btn = document.getElementById('shareScreenBtn');
    if (!btn) return;
    btn.classList.remove('enabled', 'disabled');
    if (sharing) btn.classList.add('enabled');
}

function stopScreenShare() {
    // Уже не шарим экран
    if (!isScreenSharing) return;
    isScreenSharing = false;
    try {
        if (screenStream) {
            screenStream.getTracks().forEach(t => t.stop());
        }
    } catch {}
    screenStream = null;

    // Возвращаем камеру (если есть)
    const camTrack = localStream && localStream.getVideoTracks ? localStream.getVideoTracks()[0] : null;
    for (const id in peerConnections) {
        const sender = peerConnections[id].getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(camTrack || null);
    }

    const localVideo = document.getElementById('localVideo');
    if (localVideo) {
        // Если нет видео-дорожки камеры — показываем исходный localStream (аудио) или пусто
        if (camTrack) {
            localVideo.srcObject = localStream;
        } else if (localStream) {
            localVideo.srcObject = localStream; // может быть только аудио
        } else {
            localVideo.srcObject = null;
        }
    }

    setShareBtnState(false);
}

async function shareScreen() {
    // Переключатель: если уже идёт демонстрация — останавливаем её
    if (isScreenSharing) {
        stopScreenShare();
        return;
    }

    try {
        const screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screen.getVideoTracks()[0];
        screenStream = screen;
        isScreenSharing = true;

        // Заменяем видео-дорожку во всех соединениях
        for (const id in peerConnections) {
            const sender = peerConnections[id].getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) sender.replaceTrack(screenTrack);
        }

        // Локальный превью: экран + текущие аудио-дорожки
        const localVideo = document.getElementById('localVideo');
        if (localVideo) {
            const newStream = new MediaStream([screenTrack, ...(localStream ? localStream.getAudioTracks() : [])]);
            localVideo.srcObject = newStream;
        }

        setShareBtnState(true);

        // Если пользователь завершил шаринг через UI браузера — корректно откатываемся
        screenTrack.onended = () => {
            stopScreenShare();
        };
    } catch (e) {
        // Пользователь мог отменить выбор экрана — тихо выходим
        isScreenSharing = false;
        screenStream = null;
        setShareBtnState(false);
    }
}

function endCall() {
    console.log('endCall() вызвана. callStartTime:', callStartTime);
    
    // Рассчитываем длительность звонка
    let duration = '00:00';
    if (callStartTime) {
        const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        duration = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        console.log('Рассчитанная длительность звонка:', duration, '(', elapsed, 'сек)');
    } else {
        console.warn('callStartTime не установлен! Длительность будет 00:00');
    }
    
    // Обновляем последнюю карточку звонка через Socket.IO (для сохранения в БД)
    const lastCallCard = chatWindow.querySelector('.call-card:last-of-type');
    console.log('Найдена карточка звонка:', lastCallCard);
    
    if (lastCallCard) {
        const messageId = lastCallCard.getAttribute('data-message-id');
        console.log('messageId карточки:', messageId);
        
        if (messageId && currentRoomId) {
            // Отправляем обновление через Socket.IO
            console.log('Отправка update_call_card:', {messageId, duration, status: 'ended'});
            socket.emit('update_call_card', {
                message_id: parseInt(messageId),
                duration: duration,
                status: 'ended'
            });
        }
        
        // Локальное обновление UI
        const statusEl = lastCallCard.querySelector('.call-card-subtitle');
        if (statusEl) statusEl.textContent = 'Завершен';
        
        // Удаляем кнопки действий
        const actionsEl = lastCallCard.querySelector('.call-card-actions');
        if (actionsEl) actionsEl.remove();
        
        // Добавляем длительность
        const durationEl = lastCallCard.querySelector('.call-card-duration');
        if (durationEl) {
            durationEl.textContent = `Длительность: ${duration}`;
        } else {
            const newDurationEl = document.createElement('div');
            newDurationEl.className = 'call-card-duration';
            newDurationEl.textContent = `Длительность: ${duration}`;
            lastCallCard.appendChild(newDurationEl);
        }
    }
    
    for (const id in peerConnections) {
        try { peerConnections[id].close(); } catch {}
    }
    peerConnections = {};
    pendingIceByPeer = {};

    // Останавливаем демонстрацию экрана, если активна
    if (isScreenSharing && screenStream) {
        try { screenStream.getTracks().forEach(t => t.stop()); } catch {}
    }
    isScreenSharing = false;
    screenStream = null;
    
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    
    // Скрываем индикатор активного звонка
    hideCallIndicator();
    
    // Скрываем индикатор лобби если он есть
    hideCallLobbyIndicator();
    
    // Скрываем кнопку приглашения
    hideInviteButton();
    
    // Сбрасываем режим звонка
    isAudioOnly = false;
    
    // Очищаем состояние группового звонка
    activeGroupCallRoomId = null;
    groupCallParticipantsSet.clear();
    
    // Сбрасываем состояние кнопок
    isMicEnabled = true;
    isCamEnabled = true;
    
    // Очистка UI
    const remoteVideos = document.getElementById('remoteVideos');
    if (remoteVideos) remoteVideos.innerHTML = '';
    const localVideo = document.getElementById('localVideo');
    if (localVideo) localVideo.srcObject = null;
    
    // Закрываем модальные окна звонков и снимаем любые таймеры/состояния
    const callModal = document.getElementById('callModal');
    const dialModal = document.getElementById('dialModal');
    if (callModal) {
        callModal.style.display = 'none';
        isCallModalOpen = false;
    }
    if (dialModal) {
        dialModal.style.display = 'none';
        isDialModalOpen = false;
    }
    stopRingtone();
    hideIncomingPopup();
    
    // Сообщаем другим об окончании (для DM)
    if (currentRoomType === 'dm' && currentDMotherUserId) {
        try { socket.emit('call_action', { target_user_id: parseInt(currentDMotherUserId), action: 'hangup' }); } catch {}
    }
    if (currentRoomType !== 'dm' && currentRoomId) {
        socket.emit('room_call_action', { room_id: parseInt(currentRoomId), action: 'end' });
    }
}

function showMessage(element, message, type) {
    element.textContent = message;
    element.className = 'modal-message';
    if (type === 'error') element.classList.add('message-error');
    else if (type === 'success') element.classList.add('message-success');
    element.style.display = 'block';
}

async function startDM(userId, buttonElement) {
    const messageBox = document.getElementById('searchMessage');
    buttonElement.disabled = true;
    buttonElement.textContent = '...';

    try {
        const response = await fetch('/api/start_dm', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ contact_id: userId }),
        });
        const data = await response.json();
        if (data.success) {
            const newRoomElement = addNewRoomToSidebar(data.room);
            selectRoom(newRoomElement);
            closeModal({target: document.getElementById('searchModal'), forceClose: true}); 
        } else {
            showMessage(messageBox, data.message, 'error');
            buttonElement.disabled = false;
            buttonElement.textContent = 'Начать чат';
        }
    } catch (error) {
        showMessage(messageBox, 'Ошибка сети.', 'error');
        buttonElement.disabled = false;
        buttonElement.textContent = 'Начать чат';
    }
}

function createRoom() {
    const name = document.getElementById('roomName').value.trim();
    const type = document.getElementById('roomType').value;
    const messageBox = document.getElementById('createRoomMessage');

    const members = [];
    document.querySelectorAll('#roomMembersSelect input[type="checkbox"]:checked').forEach(cb => {
        members.push(parseInt(cb.value));
    });

    if (!name) {
        showMessage(messageBox, 'Укажите название комнаты.', 'error');
        return;
    }

    fetch('/api/create_room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type, members })
    })
    .then(r => r.json())
    .then(data => {
        if (data.success) {
            showMessage(messageBox, 'Комната создана.', 'success');
            const el = addNewRoomToSidebar(data.room);
            selectRoom(el);
            setTimeout(() => closeModal({ target: document.getElementById('createRoomModal'), forceClose: true }), 400);
        } else {
            showMessage(messageBox, data.message || 'Ошибка создания.', 'error');
        }
    })
    .catch(() => showMessage(messageBox, 'Ошибка сети.', 'error'));
}

function saveSettings() {
    const username = document.getElementById('settingsUsername').value.trim();
    const bio = document.getElementById('settingsBio').value.trim();
    const theme = document.getElementById('settingsTheme').value;
    const messageBox = document.getElementById('settingsMessage');

    fetch('/api/update_profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, bio, theme })
    })
    .then(r => r.json())
    .then(data => {
        if (data.success) {
            showMessage(messageBox, data.message, 'success');
            document.body.setAttribute('data-theme', data.theme);
            try { localStorage.setItem('appTheme', data.theme); } catch {}
            document.getElementById('current-username-display').textContent = `@${data.username}`;
            setTimeout(() => closeModal({ target: document.getElementById('settingsModal'), forceClose: true }), 400);
        } else {
            showMessage(messageBox, data.message || 'Ошибка обновления.', 'error');
        }
    })
    .catch(() => showMessage(messageBox, 'Ошибка сети.', 'error'));
}

function searchUsers() {
    const queryInput = document.getElementById('searchQuery');
    const messageBox = document.getElementById('searchMessage');
    const resultsBox = document.getElementById('searchResults');

    const q = (queryInput.value || '').trim();
    if (!q) {
        showMessage(messageBox, 'Введите запрос.', 'error');
        return;
    }

    messageBox.style.display = 'none';
    resultsBox.innerHTML = '';

    fetch(`/api/search_user?q=${encodeURIComponent(q)}`)
        .then(r => r.json())
        .then(data => {
            if (!data.success) {
                showMessage(messageBox, data.message || 'Не найдено.', 'error');
                return;
            }
            if (!data.results || data.results.length === 0) {
                resultsBox.innerHTML = '<p class="empty-state small">Никого не найдено.</p>';
                return;
            }
            data.results.forEach(user => {
                const div = document.createElement('div');
                div.className = 'search-result';
                div.innerHTML = `<div><span class="result-username">@${user.username}</span></div>`;
                const btn = document.createElement('button');
                btn.textContent = 'Начать чат';
                btn.onclick = () => startDM(user.id, btn);
                div.appendChild(btn);
                resultsBox.appendChild(div);
            });
        })
        .catch(() => showMessage(messageBox, 'Ошибка сети.', 'error'));
}

// Открытие/закрытие модалок
function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
    try {
        // Прячем нижнюю навигацию на мобильных при открытии любых модалок
        if (window.innerWidth <= 768) {
            window._mobileNavLock = true;
            const mobileNav = document.getElementById('telegram-mobile-nav');
            if (mobileNav) {
                mobileNav.classList.add('hidden');
                mobileNav.style.animation = 'none'; // отключаем CSS-анимацию, которая может снимать класс
            }
        }
    } catch {}
}

function closeModal(event) {
    // Принудительное закрытие: closeModal({ target: element, forceClose: true })
    if (event && event.forceClose && event.target) {
        event.target.style.display = 'none';
        return;
    }
    const target = event && event.target;
    const current = event && event.currentTarget;
    const overlay = current && current.classList && current.classList.contains('modal-overlay') ? current : null;
    const overlayId = overlay && overlay.id ? overlay.id : '';
    // Клик по крестику
    if (target && target.classList && target.classList.contains('close-btn')) {
        const overlay = target.closest('.modal-overlay');
        if (overlay) overlay.style.display = 'none';
        return;
    }
    // Клик по оверлею
    if (current && target === current) {
        // Не закрываем звонки по клику по фону — только по кнопке «X»
        if (overlayId === 'callModal' || overlayId === 'dialModal' || overlayId === 'incomingCallPopup') return;
        current.style.display = 'none';
    }

    // Разблокируем и показываем навигацию, если нет открытых модалок
    try {
        if (window.innerWidth <= 768) {
            const anyOpen = Array.from(document.querySelectorAll('.modal-overlay'))
                .some(m => m.style.display === 'flex');
            if (!anyOpen) {
                window._mobileNavLock = false;
                const mobileNav = document.getElementById('telegram-mobile-nav');
                if (mobileNav) {
                    mobileNav.classList.remove('hidden');
                    mobileNav.style.animation = ''; // вернем анимации
                }
            }
        }
    } catch {}
}

// --- Неизвестные контакты: добавить/заблокировать ---
async function addUnknownToContacts() {
    if (!currentDMotherUserId) return;
    try {
        const response = await fetch('/api/start_dm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact_id: parseInt(currentDMotherUserId) }) });
        const data = await response.json();
        if (data.success) {
            USER_CONTACTS.push({ id: parseInt(currentDMotherUserId), username: (data.room.name || '').replace('@',''), display_name: data.room.name || '' });
            unknownBanner.style.display = 'none';
            alert('Контакт добавлен.');
        } else {
            alert(data.message || 'Не удалось добавить.');
        }
    } catch {
        alert('Ошибка сети.');
    }
}

async function blockUnknownContact() {
    if (!currentDMotherUserId) return;
    try {
        const response = await fetch('/api/block_user', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: parseInt(currentDMotherUserId) }) });
        const data = await response.json();
        if (data.success) {
            alert('Пользователь заблокирован.');
            unknownBanner.style.display = 'none';
            messageInput.disabled = true; sendButton.disabled = true;
            messageInput.placeholder = 'Вы заблокировали этого пользователя.';
        } else {
            alert(data.message || 'Не удалось заблокировать.');
        }
    } catch {
        alert('Ошибка сети.');
    }
}

// ========== Настройки эффекта стекла ==========

// Загрузка сохраненных настроек стекла при загрузке страницы
window.addEventListener('DOMContentLoaded', () => {
    loadGlassSettings();
});
// --- Аватар: загрузка/удаление ---
async function uploadAvatarFile(event) {
    const files = event.target.files;
    if (!files || !files[0]) return;
    const form = new FormData();
    form.append('avatar', files[0]);
    const messageBox = document.getElementById('avatarMessage');
    try {
        const resp = await fetch('/api/upload_avatar', { method: 'POST', body: form });
        const data = await resp.json();
        if (data.success) {
            // Обновляем превью и мини-аватар в сайдбаре
            const settingsImg = document.getElementById('settings-avatar-img');
            const sidebarImg = document.getElementById('my-avatar-img');
            if (settingsImg) settingsImg.src = data.avatar_url;
            if (sidebarImg) sidebarImg.src = data.avatar_url;
            showMessage(messageBox, 'Аватар обновлён.', 'success');
        } else {
            showMessage(messageBox, data.message || 'Не удалось загрузить аватар.', 'error');
        }
    } catch {
        showMessage(messageBox, 'Ошибка сети.', 'error');
    }
}

async function removeAvatar() {
    const messageBox = document.getElementById('avatarMessage');
    try {
        const resp = await fetch('/api/remove_avatar', { method: 'POST' });
        const data = await resp.json();
        if (data.success) {
            const settingsImg = document.getElementById('settings-avatar-img');
            const sidebarImg = document.getElementById('my-avatar-img');
            if (settingsImg) settingsImg.src = '';
            if (sidebarImg) sidebarImg.src = '';
            showMessage(messageBox, 'Аватар удалён.', 'success');
        } else {
            showMessage(messageBox, data.message || 'Не удалось удалить аватар.', 'error');
        }
    } catch {
        showMessage(messageBox, 'Ошибка сети.', 'error');
    }
}

function loadGlassSettings() {
    const opacity = localStorage.getItem('glassOpacity') || '0.15';
    const blur = localStorage.getItem('glassBlur') || '40';
    const border = localStorage.getItem('glassBorder') || '0.2';
    
    const opacityInput = document.getElementById('glassOpacity');
    const blurInput = document.getElementById('glassBlur');
    const borderInput = document.getElementById('glassBorder');
    const opacityValue = document.getElementById('opacityValue');
    const blurValue = document.getElementById('blurValue');
    const borderValue = document.getElementById('borderValue');
    
    if (opacityInput) opacityInput.value = opacity;
    if (blurInput) blurInput.value = blur;
    if (borderInput) borderInput.value = border;
    
    if (opacityValue) opacityValue.textContent = opacity;
    if (blurValue) blurValue.textContent = blur + 'px';
    if (borderValue) borderValue.textContent = border;
    
    applyGlassSettings(opacity, blur, border);
}

function updateGlassEffect() {
    const opacity = document.getElementById('glassOpacity').value;
    const blur = document.getElementById('glassBlur').value;
    const border = document.getElementById('glassBorder').value;
    
    // Обновление отображаемых значений
    document.getElementById('opacityValue').textContent = opacity;
    document.getElementById('blurValue').textContent = blur + 'px';
    document.getElementById('borderValue').textContent = border;
    
    // Применение настроек
    applyGlassSettings(opacity, blur, border);
    
    // Сохранение в localStorage
    localStorage.setItem('glassOpacity', opacity);
    localStorage.setItem('glassBlur', blur);
    localStorage.setItem('glassBorder', border);
}

function applyGlassSettings(opacity, blur, border) {
    const root = document.documentElement;
    root.style.setProperty('--glass-opacity', opacity);
    root.style.setProperty('--glass-blur', blur + 'px');
    root.style.setProperty('--glass-border-opacity', border);
    
    // Пересчет производных значений
    const hoverOpacity = parseFloat(opacity) + 0.05;
    root.style.setProperty('--glass-bg', `rgba(255, 255, 255, ${opacity})`);
    root.style.setProperty('--glass-border', `rgba(255, 255, 255, ${border})`);
    root.style.setProperty('--glass-bg-hover', `rgba(255, 255, 255, ${hoverOpacity})`);
}

function resetGlassEffect() {
    document.getElementById('glassOpacity').value = '0.15';
    document.getElementById('glassBlur').value = '40';
    document.getElementById('glassBorder').value = '0.2';
    
    updateGlassEffect();
    
    alert('Настройки эффекта стекла сброшены по умолчанию!');
}

// === НОВОЕ: Встроенные настройки ===

let selectedTheme = document.body.getAttribute('data-theme') || 'dark';

function openInlineSettings() {
    // Скрываем чат, показываем настройки
    document.getElementById('chat-view').style.display = 'none';
    document.getElementById('settings-view-inline').style.display = 'flex';
    
    // Загружаем текущие настройки стекла
    loadGlassSettingsInline();

    // Устанавливаем выбранный рингтон в селекте (если есть модалка настроек)
    try {
        const saved = localStorage.getItem('selectedRingtone') || 'marimba';
        const sel1 = document.getElementById('settingsRingtone');
        const sel2 = document.getElementById('inlineSettingsRingtone');
        if (sel1) sel1.value = saved;
        if (sel2) sel2.value = saved;
    } catch {}

    // Скрываем нижнюю навигацию на мобильных
    try {
        if (window.innerWidth <= 768) {
            window._mobileNavLock = true;
            const mobileNav = document.getElementById('telegram-mobile-nav');
            if (mobileNav) mobileNav.classList.add('hidden');
        }
    } catch {}
}

function closeInlineSettings() {
    // Показываем чат, скрываем настройки
    document.getElementById('chat-view').style.display = 'flex';
    document.getElementById('settings-view-inline').style.display = 'none';
    
    // На мобильных возвращаемся к списку чатов
    if (window.innerWidth <= 768) {
        const sidebar = document.querySelector('.sidebar');
        const mainContent = document.getElementById('main-content');
        const mobileNav = document.getElementById('telegram-mobile-nav');
        
        // Показываем список чатов
        if (sidebar) sidebar.classList.remove('mobile-hidden');
        if (mainContent) mainContent.classList.remove('mobile-chat-open');
        
        // Показываем навигацию обратно
        if (mobileNav) {
            mobileNav.classList.remove('hidden');
        }
        window._mobileNavLock = false;
        
        // Активируем кнопку "Чаты" в навигации
        document.querySelectorAll('.telegram-nav-item').forEach(item => {
            item.classList.remove('active');
        });
        const chatsTab = document.querySelector('.telegram-nav-item[data-nav="chats"]');
        if (chatsTab) {
            chatsTab.classList.add('active');
        }
    }
}

function selectTheme(theme) {
    selectedTheme = theme;
    
    // Обновляем визуальное выделение
    document.querySelectorAll('.theme-option').forEach(opt => {
        if (opt.getAttribute('data-theme') === theme) {
            opt.classList.add('active');
        } else {
            opt.classList.remove('active');
        }
    });
    
    // Мгновенная preview темы
    document.body.setAttribute('data-theme', theme);
    try { localStorage.setItem('appTheme', theme); } catch {}
}

function loadGlassSettingsInline() {
    const opacity = localStorage.getItem('glassOpacity') || '0.15';
    const blur = localStorage.getItem('glassBlur') || '40';
    const border = localStorage.getItem('glassBorder') || '0.2';
    
    const opacityInput = document.getElementById('inline-glassOpacity');
    const blurInput = document.getElementById('inline-glassBlur');
    const borderInput = document.getElementById('inline-glassBorder');
    
    if (opacityInput) opacityInput.value = opacity;
    if (blurInput) blurInput.value = blur;
    if (borderInput) borderInput.value = border;
    
    updateGlassEffectInline();
}

function updateGlassEffectInline() {
    const opacity = document.getElementById('inline-glassOpacity').value;
    const blur = document.getElementById('inline-glassBlur').value;
    const border = document.getElementById('inline-glassBorder').value;
    
    // Обновление отображаемых значений
    document.getElementById('inline-opacityValue').textContent = opacity;
    document.getElementById('inline-blurValue').textContent = blur + 'px';
    document.getElementById('inline-borderValue').textContent = border;
    
    // Применение настроек
    applyGlassSettings(opacity, blur, border);
    
    // Сохранение в localStorage
    localStorage.setItem('glassOpacity', opacity);
    localStorage.setItem('glassBlur', blur);
    localStorage.setItem('glassBorder', border);
}

function resetGlassEffectInline() {
    document.getElementById('inline-glassOpacity').value = '0.15';
    document.getElementById('inline-glassBlur').value = '40';
    document.getElementById('inline-glassBorder').value = '0.2';
    
    updateGlassEffectInline();
    
    alert('Настройки эффекта стекла сброшены по умолчанию!');
}

async function uploadAvatarFileInline(event) {
    const files = event.target.files;
    if (!files || !files[0]) return;
    const form = new FormData();
    form.append('avatar', files[0]);
    const messageBox = document.getElementById('inline-settingsMessage');
    try {
        const resp = await fetch('/api/upload_avatar', { method: 'POST', body: form });
        const data = await resp.json();
        if (data.success) {
            // Обновляем превью
            const inlineImg = document.getElementById('inline-settings-avatar-img');
            const settingsImg = document.getElementById('settings-avatar-img');
            const sidebarImg = document.getElementById('my-avatar-img');
            if (inlineImg) inlineImg.src = data.avatar_url;
            if (settingsImg) settingsImg.src = data.avatar_url;
            if (sidebarImg) sidebarImg.src = data.avatar_url;
            showMessage(messageBox, 'Аватар обновлён.', 'success');
        } else {
            showMessage(messageBox, data.message || 'Не удалось загрузить аватар.', 'error');
        }
    } catch {
        showMessage(messageBox, 'Ошибка сети.', 'error');
    }
}

async function removeAvatarInline() {
    const messageBox = document.getElementById('inline-settingsMessage');
    try {
        const resp = await fetch('/api/remove_avatar', { method: 'POST' });
        const data = await resp.json();
        if (data.success) {
            const inlineImg = document.getElementById('inline-settings-avatar-img');
            const settingsImg = document.getElementById('settings-avatar-img');
            const sidebarImg = document.getElementById('my-avatar-img');
            if (inlineImg) inlineImg.src = '';
            if (settingsImg) settingsImg.src = '';
            if (sidebarImg) sidebarImg.src = '';
            showMessage(messageBox, 'Аватар удалён.', 'success');
        } else {
            showMessage(messageBox, data.message || 'Не удалось удалить аватар.', 'error');
        }
    } catch {
        showMessage(messageBox, 'Ошибка сети.', 'error');
    }
}

async function saveInlineSettings() {
    const username = document.getElementById('inline-settingsUsername').value.trim();
    const bio = document.getElementById('inline-settingsBio').value.trim();
    const theme = selectedTheme;
    const messageBox = document.getElementById('inline-settingsMessage');

    fetch('/api/update_profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, bio, theme })
    })
    .then(r => r.json())
    .then(data => {
        if (data.success) {
            showMessage(messageBox, data.message, 'success');
            document.body.setAttribute('data-theme', data.theme);
            try { localStorage.setItem('appTheme', data.theme); } catch {}
            document.getElementById('current-username-display').textContent = `@${data.username}`;
            
            // Также обновим старую модалку если она используется
            const settingsUsername = document.getElementById('settingsUsername');
            const settingsBio = document.getElementById('settingsBio');
            if (settingsUsername) settingsUsername.value = data.username;
            if (settingsBio) settingsBio.value = data.bio;
            
            setTimeout(() => {
                closeInlineSettings();
            }, 1000);
        } else {
            showMessage(messageBox, data.message || 'Ошибка обновления.', 'error');
        }
    })
    .catch(() => showMessage(messageBox, 'Ошибка сети.', 'error'));
}

// ВНИМАНИЕ: обработчик перенесён в DOMContentLoaded выше, чтобы socket был инициализирован

let activeDeleteModal = {
    ids: [],
    deleteForAll: false
};

function openDeleteModal(messageIds) {
    const modal = document.getElementById('delete-confirm-modal');
    const confirmText = document.getElementById('delete-confirm-text');
    const otherUserBlock = document.getElementById('delete-for-other-user-block');
    const otherUserCheckbox = document.getElementById('delete-for-other-user-checkbox');
    const otherUserLabel = document.getElementById('delete-for-other-user-label');
    
    activeDeleteModal.ids = messageIds;

    if (messageIds.length === 1 && currentRoomType === 'dm') {
        const roomName = document.getElementById('chat-with-name').textContent;
        confirmText.textContent = `Вы уверены, что хотите удалить это сообщение?`;
        otherUserLabel.textContent = `Также удалить для ${roomName}`;
        otherUserBlock.style.display = 'block';
        otherUserCheckbox.checked = true; // По умолчанию включено
    } else {
        confirmText.textContent = `Вы уверены, что хотите удалить ${messageIds.length} сообщения?`;
        otherUserBlock.style.display = 'none';
    }
    
    modal.style.display = 'flex';
}

function confirmDelete() {
    const checkbox = document.getElementById('delete-for-other-user-checkbox');
    activeDeleteModal.deleteForAll = checkbox.checked;

    if (activeDeleteModal.ids.length > 1) {
        socket.emit('delete_messages', { message_ids: activeDeleteModal.ids });
    } else if (activeDeleteModal.ids.length === 1) {
        // Здесь можно передать флаг deleteForAll, если бэкенд его поддерживает
        socket.emit('delete_message', { message_id: activeDeleteModal.ids[0] });
    }
    
    closeModal({target: document.getElementById('delete-confirm-modal'), forceClose: true});
    toggleSelectionMode(false); // Выходим из режима выделения
}

function togglePictureInPicture() {
    // Выбираем приоритетно первое удалённое видео, иначе — локальное
    let videoElement = document.querySelector('#remoteVideos video');
    if (!videoElement) {
        videoElement = document.getElementById('localVideo');
    }

    if (!videoElement) {
        alert('Нет активного видео для режима "Картинка в картинке"');
        return;
    }

    if (document.pictureInPictureElement) {
        document.exitPictureInPicture()
            .catch(error => console.error('Не удалось выйти из режима PiP:', error));
        return;
    }

    if (!document.pictureInPictureEnabled) {
        alert('Ваш браузер не поддерживает режим "Картинка в картинке".');
        return;
    }

    // Некоторые браузеры требуют, чтобы видео было не скрыто и воспроизводилось
    try {
        if (videoElement.paused && typeof videoElement.play === 'function') {
            const p = videoElement.play();
            if (p && typeof p.then === 'function') {
                p.catch(() => {});
            }
        }
    } catch {}

    videoElement.requestPictureInPicture()
        .catch(error => {
            console.error('Не удалось войти в режим PiP:', error);
            alert('Не удалось свернуть видео. Убедитесь, что видео активно и имеет звук/картинку.');
        });
}

// --- НОВОЕ: Функции управления участниками ---

async function openMembersModal() {
    if (!currentRoomId) return;

    openModal('membersModal');
    
    // Меняем заголовок в зависимости от типа комнаты
    const modalTitle = document.querySelector('#membersModal .modal-header h3');
    if (modalTitle) {
        modalTitle.textContent = currentRoomType === 'channel' ? 'Подписчики' : 'Участники';
    }
    
    const container = document.getElementById('membersListContainer');
    const messageBox = document.getElementById('membersMessage');
    container.innerHTML = '<p>Загрузка...</p>';

    try {
        const response = await fetch(`/api/room_members/${currentRoomId}`);
        const data = await response.json();
        if (data.success) {
            renderMembersList(data.members);
        } else {
            showMessage(messageBox, data.error || 'Не удалось загрузить список.', 'error');
        }
    } catch (error) {
        showMessage(messageBox, 'Ошибка сети.', 'error');
    }
}

function renderMembersList(members) {
    const container = document.getElementById('membersListContainer');
    container.innerHTML = '';

    members.sort((a, b) => { // Админы всегда сверху
        if (a.role === 'admin' && b.role !== 'admin') return -1;
        if (a.role !== 'admin' && b.role === 'admin') return 1;
        return a.username.localeCompare(b.username);
    });

    members.forEach(member => {
        const item = document.createElement('div');
        item.className = 'member-item';

        const info = document.createElement('div');
        info.className = 'member-info';
        info.innerHTML = `
            <span class="member-username">@${member.username}</span>
            <span class="member-role ${member.role === 'admin' ? 'admin' : ''}">${member.role}</span>
        `;
        item.appendChild(info);

        // Кнопки управления видны только админам и не для самих себя
        if (currentUserRole === 'admin' && member.id !== CURRENT_USER_ID) {
            const actions = document.createElement('div');
            actions.className = 'member-actions';

            if (member.role !== 'admin') {
                actions.innerHTML += `<button class="icon-btn" title="Сделать администратором" onclick="manageMember(${member.id}, 'promote')">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg>
                </button>`;
            } else {
                actions.innerHTML += `<button class="icon-btn" title="Понизить до участника" onclick="manageMember(${member.id}, 'demote')">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                </button>`;
            }
            actions.innerHTML += `<button class="icon-btn" title="Удалить из комнаты" style="color:var(--color-danger);" onclick="manageMember(${member.id}, 'remove')">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>`;
            
            item.appendChild(actions);
        }

        container.appendChild(item);
    });
}

async function manageMember(targetUserId, action) {
    const messageBox = document.getElementById('membersMessage');
    const confirmationText = {
        promote: 'Вы уверены, что хотите сделать этого пользователя администратором?',
        demote: 'Вы уверены, что хотите понизить этого администратора до участника?',
        remove: 'Вы уверены, что хотите удалить этого пользователя из комнаты?'
    }[action];
    
    if (!confirm(confirmationText)) return;

    try {
        const response = await fetch('/api/manage_room_member', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                room_id: parseInt(currentRoomId),
                target_user_id: targetUserId,
                action: action
            })
        });
        const data = await response.json();
        
        if (data.success) {
            showMessage(messageBox, data.message, 'success');
            // UI обновится автоматически через сокет
        } else {
            showMessage(messageBox, data.message || 'Произошла ошибка.', 'error');
        }
    } catch (error) {
        showMessage(messageBox, 'Ошибка сети.', 'error');
    }
}

async function deleteRoom() {
    const roomId = document.getElementById('roomSettingsId').value;
    const roomName = document.getElementById('roomSettingsName').value;
    const messageBox = document.getElementById('roomSettingsMessage');

    if (!confirm(`Вы уверены, что хотите навсегда удалить комнату "${roomName}"? Это действие необратимо.`)) {
        return;
    }

    try {
        const response = await fetch('/api/delete_room', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ room_id: parseInt(roomId) })
        });
        const data = await response.json();
        
        if (data.success) {
            // UI обновится у всех через сокет, включая самого админа
            closeModal({target: document.getElementById('roomSettingsModal'), forceClose: true});
        } else {
            showMessage(messageBox, data.message || 'Произошла ошибка.', 'error');
        }
    } catch (error) {
        showMessage(messageBox, 'Ошибка сети.', 'error');
    }
}

// === НОВОЕ: Мобильная навигация (Telegram стиль) ===
function toggleMobileTab(tabName) {
    const sidebarContent = document.querySelector('.sidebar-content');
    const allTabs = document.querySelectorAll('.mobile-tab');
    
    if (tabName === 'chats') {
        // Переключаем видимость списка чатов
        if (sidebarContent.classList.contains('show')) {
            sidebarContent.classList.remove('show');
            document.getElementById('tab-chats').classList.remove('active');
        } else {
            sidebarContent.classList.add('show');
            allTabs.forEach(tab => tab.classList.remove('active'));
            document.getElementById('tab-chats').classList.add('active');
        }
    }
}

// Закрытие чата на мобильных (возврат к списку чатов)
function closeMobileChat() {
    if (window.innerWidth <= 768) {
        // Показываем sidebar (список чатов)
        const sidebar = document.querySelector('.sidebar');
        const mainContent = document.getElementById('main-content');
        const mobileNav = document.getElementById('telegram-mobile-nav');
        
        if (sidebar) sidebar.classList.remove('mobile-hidden');
        if (mainContent) mainContent.classList.remove('mobile-chat-open');
        
        // Показываем навигацию обратно
        if (mobileNav) {
            mobileNav.classList.remove('hidden');
        }
        
        // Активируем кнопку "Чаты" в навигации
        document.querySelectorAll('.telegram-nav-item').forEach(item => {
            item.classList.remove('active');
        });
        const chatsTab = document.querySelector('.telegram-nav-item[data-nav="chats"]');
        if (chatsTab) {
            chatsTab.classList.add('active');
        }
        
        // Сбрасываем текущий чат
        currentRoomId = null;
        currentRoomType = null;
        currentUserRole = null;
        
        // Скрываем элементы чата
        chatHeader.style.display = 'none';
        chatInputArea.style.display = 'none';
        placeholderText.style.display = 'block';
        placeholderText.textContent = 'Выберите чат слева, чтобы начать общение.';
    }
}

// Закрываем список чатов при выборе комнаты на мобильных
function selectRoom(element) {
    const roomId = element.getAttribute('data-room-id');
    const roomName = element.getAttribute('data-room-name');
    const roomType = element.getAttribute('data-room-type');
    const userRole = element.getAttribute('data-user-role');

    if (roomId == currentRoomId) return;

    // A. Выходим из предыдущей комнаты SocketIO
    if (currentRoomId) {
        socket.emit('leave', { room_id: parseInt(currentRoomId) });
    }

    // B. Обновляем интерфейс
    document.querySelectorAll('.room-item').forEach(item => {
        item.classList.remove('active');
    });
    element.classList.add('active');

    chatHeader.style.display = 'flex';
    placeholderText.style.display = 'none';
    chatWithName.textContent = roomName;
    
    clearChatWindow();

    // C. Устанавливаем новую комнату
    currentRoomId = roomId;
    currentRoomType = roomType;
    currentUserRole = userRole;

    currentDMotherUserId = element.getAttribute('data-dm-other-id');

    setupRoomUI();

    // D. Загружаем историю
    loadChatHistory(roomId);

    // E. Вступаем в новую комнату SocketIO
    socket.emit('join', { room_id: parseInt(currentRoomId) });
    
    // F. Сбрасываем счетчик непрочитанных
    markRoomAsRead(roomId);
    
    // НОВОЕ: На мобильных переключаемся на экран чата (Telegram-стиль)
    if (window.innerWidth <= 768) {
        const sidebar = document.querySelector('.sidebar');
        const mainContent = document.getElementById('main-content');
        const backBtn = document.querySelector('.mobile-back-btn');
        const mobileNav = document.getElementById('telegram-mobile-nav');
        
        // Скрываем список чатов, показываем переписку
        if (sidebar) sidebar.classList.add('mobile-hidden');
        if (mainContent) mainContent.classList.add('mobile-chat-open');
        if (backBtn) backBtn.style.display = 'flex';
        
        // Скрываем нижнюю навигацию
        if (mobileNav) {
            mobileNav.classList.add('hidden');
            mobileNav.style.animation = 'none';
        }
        window._mobileNavLock = true;
    }
    
    if (!messageInput.disabled) {
        messageInput.focus();
    }
}

// ========== Глобальные функции для диагностики WebRTC ==========
// Используйте в консоли браузера (F12) для отладки звонков

// Показать состояние всех активных RTC соединений
window.rtcDebug = function() {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('           WebRTC Диагностика');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Конфигурация ICE:', rtcConfig);
    console.log('───────────────────────────────────────────────────────────');
    console.log('Активные соединения:', Object.keys(peerConnections).length);
    
    Object.entries(peerConnections).forEach(([userId, pc]) => {
        console.log('───────────────────────────────────────────────────────────');
        console.log(`Пользователь ${userId}:`);
        console.log('  connectionState:', pc.connectionState);
        console.log('  iceConnectionState:', pc.iceConnectionState);
        console.log('  iceGatheringState:', pc.iceGatheringState);
        console.log('  signalingState:', pc.signalingState);
        
        // Получаем статистику
        pc.getStats().then(stats => {
            const candidates = [];
            stats.forEach(report => {
                if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
                    candidates.push({
                        type: report.type,
                        candidateType: report.candidateType,
                        protocol: report.protocol,
                        address: report.address || report.ip,
                        port: report.port
                    });
                }
            });
            if (candidates.length > 0) {
                console.log(`  ICE кандидаты пользователя ${userId}:`, candidates);
            }
        });
    });
    
    console.log('═══════════════════════════════════════════════════════════');
};

// Показать локальный медиа-поток
window.rtcLocalStream = function() {
    if (!localStream) {
        console.log('❌ Локальный поток не активен');
        return;
    }
    console.log('═══════════════════════════════════════════════════════════');
    console.log('           Локальный медиа-поток');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('ID:', localStream.id);
    console.log('Активен:', localStream.active);
    console.log('Аудио треки:', localStream.getAudioTracks().map(t => ({
        id: t.id,
        enabled: t.enabled,
        muted: t.muted,
        readyState: t.readyState
    })));
    console.log('Видео треки:', localStream.getVideoTracks().map(t => ({
        id: t.id,
        enabled: t.enabled,
        muted: t.muted,
        readyState: t.readyState,
        settings: t.getSettings()
    })));
    console.log('═══════════════════════════════════════════════════════════');
};

// Тест сбора ICE кандидатов
window.rtcTestIce = async function() {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('           Тест сбора ICE кандидатов');
    console.log('═══════════════════════════════════════════════════════════');
    
    const pc = new RTCPeerConnection(rtcConfig);
    const candidates = { host: [], srflx: [], relay: [] };
    
    pc.onicecandidate = (ev) => {
        if (ev.candidate) {
            const c = ev.candidate.candidate;
            console.log('Получен кандидат:', c);
            
            if (c.includes('typ host')) candidates.host.push(c);
            else if (c.includes('typ srflx')) candidates.srflx.push(c);
            else if (c.includes('typ relay')) candidates.relay.push(c);
        } else {
            console.log('───────────────────────────────────────────────────────────');
            console.log('ICE gathering завершен!');
            console.log('───────────────────────────────────────────────────────────');
            console.log('Host кандидаты (локальные IP):', candidates.host.length);
            candidates.host.forEach(c => console.log('  ', c));
            console.log('───────────────────────────────────────────────────────────');
            console.log('Srflx кандидаты (публичные IP через STUN):', candidates.srflx.length);
            candidates.srflx.forEach(c => console.log('  ', c));
            console.log('───────────────────────────────────────────────────────────');
            console.log('Relay кандидаты (через TURN):', candidates.relay.length);
            candidates.relay.forEach(c => console.log('  ', c));
            console.log('───────────────────────────────────────────────────────────');
            
            if (candidates.srflx.length > 0) {
                console.log('✅ P2P через интернет: ВОЗМОЖНЫ (есть публичные IP)');
            } else if (candidates.relay.length > 0) {
                console.log('⚠️  P2P: Только через TURN сервер');
                console.log('   Рекомендация: настройте брандмауэр и роутер');
                console.log('   Читайте: НАСТРОЙКА_P2P_ЗВОНКОВ.md');
            } else {
                console.log('❌ P2P через интернет: НЕВОЗМОЖНЫ');
                console.log('   Только локальная сеть!');
                console.log('   Решение: РЕШЕНИЕ_P2P.txt');
            }
            
            console.log('═══════════════════════════════════════════════════════════');
            pc.close();
        }
    };
    
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
};

// Справка по командам
window.rtcHelp = function() {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('    WebRTC Консольные команды для диагностики');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    console.log('rtcHelp()         - Показать эту справку');
    console.log('rtcDebug()        - Показать состояние всех соединений');
    console.log('rtcLocalStream()  - Информация о локальном медиа-потоке');
    console.log('rtcTestIce()      - Тест сбора ICE кандидатов');
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    console.log('📚 Полезные файлы:');
    console.log('   • БЫСТРЫЙ_СТАРТ_ЗВОНКОВ.txt');
    console.log('   • РЕШЕНИЕ_P2P.txt');
    console.log('   • НАСТРОЙКА_P2P_ЗВОНКОВ.md');
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
};

// Автоматически показываем справку при загрузке
console.log('%c🎯 WebRTC диагностика доступна!', 'color: #00ff00; font-size: 16px; font-weight: bold;');
console.log('%cВведите rtcHelp() для справки', 'color: #00aaff; font-size: 14px;');

// ========== ЭФФЕКТЫ ДЛЯ ВИДЕО ==========

let currentVideoEffect = 'none';

function openVideoEffectsModal() {
    openModal('videoEffectsModal');
}

function applyVideoEffect(effectType) {
    currentVideoEffect = effectType;
    const localVideo = document.getElementById('localVideo');
    
    if (!localVideo) return;
    
    // Убираем все классы эффектов
    document.querySelectorAll('.effect-card').forEach(card => card.classList.remove('active'));
    
    // Применяем эффект через CSS filter
    switch(effectType) {
        case 'none':
            localVideo.style.filter = 'none';
            break;
        case 'blur':
            // Размытие фона (упрощенная версия - размывает весь кадр)
            localVideo.style.filter = 'none';
            alert('Размытие фона работает! (Упрощенная версия)');
            break;
        case 'grayscale':
            localVideo.style.filter = 'grayscale(100%)';
            break;
        case 'sepia':
            localVideo.style.filter = 'sepia(100%)';
            break;
    }
    
    // Отмечаем активную карточку
    event.target.closest('.effect-card')?.classList.add('active');
    
    console.log('Эффект применен:', effectType);
}

// ========== ДОСКА ДЛЯ РИСОВАНИЯ ==========

﻿let whiteboardCanvas = null;
let whiteboardCtx = null;
let whiteboardOverlay = null;
let whiteboardOverlayCtx = null;
let whiteboardIsDrawing = false;
let whiteboardTool = 'pen';
let whiteboardColor = '#007aff';
let whiteboardSize = 3;
let whiteboardStartX = 0;
let whiteboardStartY = 0;
let whiteboardLastX = 0;
let whiteboardLastY = 0;

function openWhiteboard() {
    openModal('whiteboardModal');

    if (!whiteboardCanvas) {
        whiteboardCanvas = document.getElementById('whiteboardCanvas');
        whiteboardOverlay = document.getElementById('whiteboardOverlay');
        whiteboardCtx = whiteboardCanvas.getContext('2d');
        whiteboardOverlayCtx = whiteboardOverlay.getContext('2d');

        resizeWhiteboardCanvas();
        window.addEventListener('resize', resizeWhiteboardCanvas);

        whiteboardCanvas.addEventListener('mousedown', startWhiteboardStroke);
        whiteboardCanvas.addEventListener('mousemove', drawWhiteboardStroke);
        whiteboardCanvas.addEventListener('mouseup', endWhiteboardStroke);
        whiteboardCanvas.addEventListener('mouseleave', endWhiteboardStroke);

        whiteboardCanvas.addEventListener('touchstart', (e) => {
            startWhiteboardStroke(e);
        }, { passive: false });
        whiteboardCanvas.addEventListener('touchmove', (e) => {
            drawWhiteboardStroke(e);
        }, { passive: false });
        whiteboardCanvas.addEventListener('touchend', endWhiteboardStroke);
    }

    resetWhiteboardToolbar();
}

function resizeWhiteboardCanvas() {
    if (!whiteboardCanvas) return;
    const { width, height } = whiteboardCanvas.getBoundingClientRect();
    whiteboardCanvas.width = width;
    whiteboardCanvas.height = height;
    if (whiteboardOverlay) {
        whiteboardOverlay.width = width;
        whiteboardOverlay.height = height;
    }
}

function resetWhiteboardToolbar() {
    const palette = document.getElementById('whiteboardPalette');
    if (palette) {
        palette.querySelectorAll('.color-swatch').forEach(swatch => {
            const color = swatch.style.getPropertyValue('--swatch');
            swatch.classList.toggle('active', color && color.trim().toLowerCase() === whiteboardColor.toLowerCase());
        });
        const colorInput = document.getElementById('brushColor');
        if (colorInput && colorInput.value.toLowerCase() !== whiteboardColor.toLowerCase()) {
            colorInput.value = whiteboardColor;
        }
    }
    const toolbar = document.getElementById('whiteboardToolbar');
    if (toolbar) {
        toolbar.querySelectorAll('.tool-btn').forEach(btn => btn.classList.remove('active'));
    }
    const activeBtn = document.querySelector(`.whiteboard-toolbar .tool-btn[data-tool="${whiteboardTool}"]`);
    if (activeBtn) activeBtn.classList.add('active');

    const sizeInput = document.getElementById('brushSize');
    if (sizeInput) sizeInput.value = whiteboardSize;
    const sizeValue = document.getElementById('whiteboardSizeValue');
    if (sizeValue) sizeValue.textContent = `${whiteboardSize} px`;
}

function setWhiteboardTool(tool, button) {
    whiteboardTool = tool;
    const toolbar = document.getElementById('whiteboardToolbar');
    if (toolbar) {
        toolbar.querySelectorAll('.tool-btn').forEach(btn => btn.classList.remove('active'));
    }
    if (button) button.classList.add('active');
}

function setWhiteboardColor(color) {
    whiteboardColor = color;
    const palette = document.getElementById('whiteboardPalette');
    if (palette) {
        palette.querySelectorAll('.color-swatch').forEach(swatch => swatch.classList.remove('active'));
        const matching = Array.from(palette.querySelectorAll('.color-swatch')).find(swatch => swatch.style.getPropertyValue('--swatch') === color);
        if (matching) matching.classList.add('active');
    }
    const colorInput = document.getElementById('brushColor');
    if (colorInput) colorInput.value = color;
}

function setWhiteboardSize(value) {
    whiteboardSize = Math.max(1, Math.min(30, parseInt(value, 10) || whiteboardSize));
    const sizeValue = document.getElementById('whiteboardSizeValue');
    if (sizeValue) sizeValue.textContent = `${whiteboardSize} px`;
}

function getWhiteboardCoordinates(event) {
    const rect = whiteboardCanvas.getBoundingClientRect();
    let clientX;
    let clientY;
    if (event.touches && event.touches[0]) {
        clientX = event.touches[0].clientX;
        clientY = event.touches[0].clientY;
    } else {
        clientX = event.clientX;
        clientY = event.clientY;
    }
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return { x, y };
}

function startWhiteboardStroke(event) {
    event.preventDefault();
    if (!whiteboardCanvas) return;
    whiteboardIsDrawing = true;
    const { x, y } = getWhiteboardCoordinates(event);
    whiteboardStartX = x;
    whiteboardStartY = y;
    whiteboardLastX = x;
    whiteboardLastY = y;
    if (whiteboardOverlayCtx) {
        whiteboardOverlayCtx.clearRect(0, 0, whiteboardOverlay.width, whiteboardOverlay.height);
    }
}

function drawWhiteboardStroke(event) {
    if (!whiteboardIsDrawing) return;
    event.preventDefault();
    const { x, y } = getWhiteboardCoordinates(event);

    if (whiteboardTool === 'pen' || whiteboardTool === 'highlighter' || whiteboardTool === 'eraser') {
        drawContinuousStroke(x, y);
    } else {
        drawPreviewShape(x, y);
    }
}

function endWhiteboardStroke(event) {
    if (!whiteboardIsDrawing) return;
    whiteboardIsDrawing = false;
    const coords = event ? getWhiteboardCoordinates(event) : { x: whiteboardLastX, y: whiteboardLastY };
    const endX = coords.x;
    const endY = coords.y;

    if (whiteboardTool === 'line') {
        drawShapeLine(whiteboardStartX, whiteboardStartY, endX, endY);
    } else if (whiteboardTool === 'rectangle') {
        drawShapeRectangle(whiteboardStartX, whiteboardStartY, endX, endY);
    } else if (whiteboardTool === 'circle') {
        drawShapeCircle(whiteboardStartX, whiteboardStartY, endX, endY);
    }

    if (whiteboardOverlayCtx) {
        whiteboardOverlayCtx.clearRect(0, 0, whiteboardOverlay.width, whiteboardOverlay.height);
    }
}

function drawContinuousStroke(x, y) {
    const baseColor = whiteboardTool === 'highlighter' ? applyAlphaToColor(whiteboardColor, 0.35) : whiteboardColor;
    const color = whiteboardTool === 'eraser' ? '__eraser__' : baseColor;
    const size = whiteboardTool === 'highlighter' ? whiteboardSize * 1.5 : whiteboardSize;
    drawLine(whiteboardLastX, whiteboardLastY, x, y, color, size);

    if (currentRoomId && socket) {
        emitWhiteboardSegment(whiteboardLastX, whiteboardLastY, x, y, color, size);
    }

    whiteboardLastX = x;
    whiteboardLastY = y;
}

function drawPreviewShape(x, y) {
    if (!whiteboardOverlayCtx) return;
    whiteboardOverlayCtx.clearRect(0, 0, whiteboardOverlay.width, whiteboardOverlay.height);
    whiteboardOverlayCtx.strokeStyle = whiteboardColor;
    whiteboardOverlayCtx.lineWidth = whiteboardSize;
    whiteboardOverlayCtx.lineCap = 'round';
    whiteboardOverlayCtx.globalAlpha = 0.6;
    whiteboardOverlayCtx.beginPath();

    if (whiteboardTool === 'line') {
        whiteboardOverlayCtx.moveTo(whiteboardStartX, whiteboardStartY);
        whiteboardOverlayCtx.lineTo(x, y);
        whiteboardOverlayCtx.stroke();
    } else if (whiteboardTool === 'rectangle') {
        whiteboardOverlayCtx.strokeRect(Math.min(whiteboardStartX, x), Math.min(whiteboardStartY, y), Math.abs(x - whiteboardStartX), Math.abs(y - whiteboardStartY));
    } else if (whiteboardTool === 'circle') {
        const radius = Math.sqrt(Math.pow(x - whiteboardStartX, 2) + Math.pow(y - whiteboardStartY, 2));
        whiteboardOverlayCtx.arc(whiteboardStartX, whiteboardStartY, radius, 0, Math.PI * 2);
        whiteboardOverlayCtx.stroke();
    }

    whiteboardOverlayCtx.globalAlpha = 1;
}

function drawShapeLine(fromX, fromY, toX, toY) {
    drawLine(fromX, fromY, toX, toY, whiteboardColor, whiteboardSize);
    if (currentRoomId && socket) {
        emitWhiteboardSegment(fromX, fromY, toX, toY, whiteboardColor, whiteboardSize);
    }
}

function drawShapeRectangle(startX, startY, endX, endY) {
    const x1 = Math.min(startX, endX);
    const y1 = Math.min(startY, endY);
    const x2 = Math.max(startX, endX);
    const y2 = Math.max(startY, endY);
    drawShapeLine(x1, y1, x2, y1);
    drawShapeLine(x2, y1, x2, y2);
    drawShapeLine(x2, y2, x1, y2);
    drawShapeLine(x1, y2, x1, y1);
}

function drawShapeCircle(startX, startY, endX, endY) {
    const radius = Math.sqrt(Math.pow(endX - startX, 2) + Math.pow(endY - startY, 2));
    const segments = 64;
    let prevX = startX + radius;
    let prevY = startY;
    for (let i = 1; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const nextX = startX + radius * Math.cos(angle);
        const nextY = startY + radius * Math.sin(angle);
        drawShapeLine(prevX, prevY, nextX, nextY);
        prevX = nextX;
        prevY = nextY;
    }
}

function emitWhiteboardSegment(fromX, fromY, toX, toY, color, size) {
    if (!whiteboardCanvas) return;
    socket.emit('whiteboard_draw', {
        room_id: currentRoomId,
        fromX: fromX / whiteboardCanvas.width,
        fromY: fromY / whiteboardCanvas.height,
        toX: toX / whiteboardCanvas.width,
        toY: toY / whiteboardCanvas.height,
        color: color,
        size: size
    });
}

function applyAlphaToColor(color, alpha) {
    if (!color) return `rgba(0,0,0,${alpha})`;
    if (color.startsWith('rgba')) {
        return color.replace(/rgba\(([^,]+),([^,]+),([^,]+),([^\)]+)\)/, (_, r, g, b) => `rgba(${r.trim()},${g.trim()},${b.trim()},${alpha})`);
    }
    if (color.startsWith('rgb')) {
        return color.replace(/rgb\(([^,]+),([^,]+),([^\)]+)\)/, (_, r, g, b) => `rgba(${r.trim()},${g.trim()},${b.trim()},${alpha})`);
    }
    const hex = color.replace('#', '');
    const bigint = parseInt(hex, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function drawLine(fromX, fromY, toX, toY, color, size) {
    if (!whiteboardCtx) return;
    whiteboardCtx.save();
    if (color === '__eraser__') {
        whiteboardCtx.globalCompositeOperation = 'destination-out';
        whiteboardCtx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
        whiteboardCtx.globalCompositeOperation = 'source-over';
        whiteboardCtx.strokeStyle = color;
        if (color && color.startsWith('rgba')) {
            const parts = color.split(',');
            const alphaPart = parts[3];
            if (alphaPart) {
                const alpha = parseFloat(alphaPart.replace(')', '').trim());
                if (!Number.isNaN(alpha)) whiteboardCtx.globalAlpha = alpha;
            }
        }
    }
    whiteboardCtx.lineWidth = size;
    whiteboardCtx.lineCap = 'round';
    whiteboardCtx.beginPath();
    whiteboardCtx.moveTo(fromX, fromY);
    whiteboardCtx.lineTo(toX, toY);
    whiteboardCtx.stroke();
    whiteboardCtx.globalAlpha = 1;
    whiteboardCtx.restore();
}

function clearWhiteboard() {
    if (whiteboardCtx && whiteboardCanvas) {
        whiteboardCtx.clearRect(0, 0, whiteboardCanvas.width, whiteboardCanvas.height);
    }
    if (whiteboardOverlayCtx && whiteboardOverlay) {
        whiteboardOverlayCtx.clearRect(0, 0, whiteboardOverlay.width, whiteboardOverlay.height);
    }
    if (currentRoomId && socket) {
        socket.emit('whiteboard_clear', {
            room_id: currentRoomId
        });
    }
}

// ========== СОВМЕСТНЫЕ ДОКУМЕНТЫ ==========

let documentContent = '';

let documentSyncTimeout = null;

function openDocuments() {
    openModal('documentsModal');
    const editor = document.getElementById('documentEditor');

    if (documentContent) {
        editor.innerHTML = documentContent;
    }

    if (!editor.dataset.bound) {
        editor.addEventListener('input', () => {
            documentContent = editor.innerHTML;

            if (documentSyncTimeout) clearTimeout(documentSyncTimeout);

            documentSyncTimeout = setTimeout(() => {
                if (currentRoomId && socket) {
                    socket.emit('document_update', {
                        room_id: currentRoomId,
                        content: documentContent
                    });
                }
            }, 500);
        });
        editor.dataset.bound = 'true';
    }
}

function formatText(command) {
    document.execCommand(command, false, null);
    document.getElementById('documentEditor').focus();
}

function shareDocument() {
    if (!documentContent) {
        alert('Документ пуст!');
        return;
    }
    
    // Копируем контент в буфер обмена
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = documentContent;
    const textContent = tempDiv.textContent || tempDiv.innerText;
    
    navigator.clipboard.writeText(textContent).then(() => {
        alert('Текст документа скопирован в буфер обмена!');
    }).catch(() => {
        alert('Не удалось скопировать текст');
    });

function setDocumentBlock(block) {
    const editor = document.getElementById('documentEditor');
    if (!editor) return;
    document.execCommand('formatBlock', false, block);
    editor.focus();
}

function setDocumentAlignment(direction) {
    const editor = document.getElementById('documentEditor');
    if (!editor) return;
    const commandMap = { left: 'justifyLeft', center: 'justifyCenter', right: 'justifyRight' };
    const command = commandMap[direction];
    if (command) {
        document.execCommand(command, false, null);
        editor.focus();
    }
}

function applyDocumentHighlight() {
    const editor = document.getElementById('documentEditor');
    if (!editor) return;
    document.execCommand('hiliteColor', false, '#fff4a3');
    editor.focus();
}

function toggleDocumentCode() {
    const editor = document.getElementById('documentEditor');
    if (!editor) return;
    document.execCommand('formatBlock', false, 'pre');
    editor.focus();
}

function sendDocumentToChat() {
    const editor = document.getElementById('documentEditor');
    if (!editor) return;
    const content = (editor.innerText || '').trim();
    if (!content) {
        alert('Добавьте текст, прежде чем отправлять.');
        return;
    }
    if (!currentRoomId) {
        alert('Выберите чат, чтобы отправить документ.');
        return;
    }
    socket.emit('send_message', {
        room_id: parseInt(currentRoomId),
        content: `?? ${content}`
    });
    alert('Документ отправлен в чат.');
}
}

// ========== ПРЕЗЕНТАЦИЯ ==========

let slides = [];
let currentSlideIndex = 0;
let presentationSelectedElementId = null;
let presentationColor = '#007aff';
let presentationFontSize = 32;
let presentationDragState = null;
let presentationGridEnabled = false;
let presentationActiveTool = 'select';

function generatePresentationId(prefix) {
    return `${prefix}-${Date.now()}`;
}

function openPresentation() {
    openModal('presentationModal');
    ensureDefaultPresentation();
    if (currentSlideIndex >= slides.length) {
        currentSlideIndex = slides.length - 1;
    }
    renderSlides();
    const selectBtn = document.querySelector('.presentation-toolbar .tool-btn[data-tool="select"]');
    if (selectBtn) {
        selectPresentationTool('select', selectBtn);
    }
}

function ensureDefaultPresentation() {
    if (slides.length === 0) {
        slides.push({
            id: generatePresentationId('slide'),
            name: 'Слайд 1',
            background: '#ffffff',
            elements: [
                {
                    id: generatePresentationId('element'),
                    type: 'text',
                    x: 15,
                    y: 18,
                    width: 50,
                    height: 22,
                    rotation: 0,
                    text: 'Дважды щёлкните, чтобы редактировать текст',
                    fontSize: 32,
                    color: '#1f1f1f',
                    background: 'transparent',
                    align: 'left'
                },
                {
                    id: generatePresentationId('element'),
                    type: 'rectangle',
                    x: 55,
                    y: 55,
                    width: 28,
                    height: 18,
                    rotation: 0,
                    color: presentationColor,
                    fill: '#cfe4ff',
                    border: presentationColor
                }
            ]
        });
    }
}

function createPresentationSlide(name) {
    return {
        id: generatePresentationId('slide'),
        name: name || Слайд ,
        background: '#ffffff',
        elements: []
    };
}

function createPresentationElement(type, overrides = {}) {
    const base = {
        id: generatePresentationId('element'),
        type: type,
        x: overrides.x !== undefined ? overrides.x : 30,
        y: overrides.y !== undefined ? overrides.y : 30,
        width: overrides.width !== undefined ? overrides.width : 30,
        height: overrides.height !== undefined ? overrides.height : 18,
        rotation: overrides.rotation || 0
    };

    if (type === 'text') {
        return Object.assign(base, {
            text: overrides.text || 'Новый текст',
            fontSize: overrides.fontSize || presentationFontSize,
            color: overrides.color || presentationColor,
            background: overrides.background || 'transparent',
            align: overrides.align || 'left'
        });
    }

    if (type === 'sticky') {
        return Object.assign(base, {
            text: overrides.text || 'Идея',
            fontSize: overrides.fontSize || 24,
            color: overrides.color || '#2d2200',
            background: overrides.background || '#ffe68a',
            align: overrides.align || 'left'
        });
    }

    if (type === 'rectangle') {
        return Object.assign(base, {
            color: overrides.color || presentationColor,
            fill: overrides.fill || '#cfe4ff',
            border: overrides.border || presentationColor
        });
    }

    if (type === 'circle') {
        return Object.assign(base, {
            color: overrides.color || presentationColor,
            fill: overrides.fill || '#cfe4ff',
            border: overrides.border || presentationColor,
            width: overrides.width !== undefined ? overrides.width : 22,
            height: overrides.height !== undefined ? overrides.height : 22
        });
    }

    if (type === 'arrow') {
        return Object.assign(base, {
            color: overrides.color || presentationColor,
            width: overrides.width !== undefined ? overrides.width : 35,
            height: overrides.height !== undefined ? overrides.height : 8
        });
    }

    if (type === 'image') {
        return Object.assign(base, {
            src: overrides.src || '',
            width: overrides.width !== undefined ? overrides.width : 35,
            height: overrides.height !== undefined ? overrides.height : 28
        });
    }

    return Object.assign(base, overrides);
}
function selectPresentationTool(tool, button) {
    presentationActiveTool = tool;
    const buttons = document.querySelectorAll('.presentation-toolbar .tool-btn');
    buttons.forEach(btn => btn.classList.toggle('active', btn === button));
}

function syncPresentationToolbar(element) {
    const colorInput = document.getElementById('presentationColor');
    const sizeInput = document.getElementById('presentationFontSize');
    if (!element) {
        if (colorInput) colorInput.value = presentationColor;
        if (sizeInput) sizeInput.value = presentationFontSize;
        return;
    }

    if (element.type === 'text' || element.type === 'sticky') {
        if (colorInput && element.color) colorInput.value = element.color;
        if (sizeInput && element.fontSize) sizeInput.value = Math.round(element.fontSize);
    } else if ((element.type === 'rectangle' || element.type === 'circle' || element.type === 'arrow') && colorInput && element.color) {
        colorInput.value = element.color;
    }
}

function renderSlides() {
    ensureDefaultPresentation();
    const container = document.getElementById('presentationSlides');
    if (!container) return;

    container.innerHTML = '';
    container.classList.toggle('grid-on', presentationGridEnabled);

    const slide = slides[currentSlideIndex];
    if (!slide) return;

    const slideCanvas = document.createElement('div');
    slideCanvas.className = 'presentation-slide';
    slideCanvas.dataset.slideId = slide.id;
    slideCanvas.style.background = slide.background || '#ffffff';

    slideCanvas.addEventListener('pointerdown', (event) => {
        if (event.target === slideCanvas) {
            selectPresentationElement(null);
        }
    });

    slide.elements.forEach((element) => {
        const elementEl = renderPresentationElement(slideCanvas, slide, element);
        slideCanvas.appendChild(elementEl);
    });

    container.appendChild(slideCanvas);
    updateSlideCounter();
    updatePresentationInspector();
    syncPresentationToolbar(getSelectedElement());
}

function renderPresentationElement(slideCanvas, slide, element) {
    const elementEl = document.createElement('div');
    elementEl.className = 'presentation-element';
    elementEl.dataset.elementId = element.id;
    elementEl.style.left = `${element.x}%`;
    elementEl.style.top = `${element.y}%`;
    elementEl.style.width = `${element.width}%`;
    elementEl.style.height = `${element.height}%`;
    elementEl.style.transformOrigin = 'center center';
    elementEl.style.transform = `rotate(${element.rotate || 0}deg)`;
    if (element.type === 'text' || element.type === 'sticky') {
        elementEl.textContent = element.text || '';
        elementEl.style.fontSize = `${element.fontSize || 24}px`;
        elementEl.style.color = element.color || '#1f1f1f';
        elementEl.style.textAlign = element.align || 'left';
        elementEl.style.background = element.type === 'sticky' ? (element.background || '#ffe68a') : (element.background || 'transparent');
        elementEl.dataset.editing = 'false';
        elementEl.addEventListener('dblclick', () => {
            elementEl.contentEditable = 'true';
            elementEl.dataset.editing = 'true';
            elementEl.focus();
            document.execCommand('selectAll', false, null);
        });
        elementEl.addEventListener('blur', () => {
            if (elementEl.dataset.editing === 'true') {
                elementEl.contentEditable = 'false';
                elementEl.dataset.editing = 'false';
                element.text = elementEl.textContent || '';
            }
        });
        elementEl.addEventListener('input', () => {
            element.text = elementEl.textContent || '';
        });
    } else if (element.type === 'rectangle' || element.type === 'circle') {
        elementEl.style.background = element.fill || '#cfe4ff';
        elementEl.style.border = `2px solid ${element.stroke || element.color || '#1f1f1f'}`;
        elementEl.style.borderRadius = element.type === 'circle' ? '50%' : '18px';
    } else if (element.type === 'arrow') {
        elementEl.textContent = '➔';
        elementEl.style.fontSize = `${element.fontSize || 32}px`;
        elementEl.style.color = element.color || element.stroke || '#1f1f1f';
    } else if (element.type === 'image') {
        const img = document.createElement('img');
        img.alt = 'Изображение презентации';
        if (element.src) {
            img.src = element.src;
        }
        elementEl.classList.add('image');
        elementEl.appendChild(img);
    }

    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    elementEl.appendChild(handle);

    elementEl.addEventListener('pointerdown', (event) => {
        if (event.target === handle) {
            startPresentationInteraction(event, element, slideCanvas, 'resize');
        } else {
            const isEditing = elementEl.dataset.editing === 'true';
            if (!isEditing) {
                startPresentationInteraction(event, element, slideCanvas, 'move');
            }
        }
        selectPresentationElement(element.id);
    });

    return elementEl;
}

function startPresentationInteraction(event, element, slideCanvas, mode) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    presentationDragState = {
        mode,
        elementId: element.id,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: element.x,
        startTop: element.y,
        startWidth: element.width,
        startHeight: element.height,
        slideRect: slideCanvas.getBoundingClientRect()
    };
    if (event.target.setPointerCapture) {
        try { event.target.setPointerCapture(event.pointerId); } catch (err) {}
    }
    document.addEventListener('pointermove', handlePresentationPointerMove);
    document.addEventListener('pointerup', handlePresentationPointerUp, { once: true });
}

function handlePresentationPointerMove(event) {
    if (!presentationDragState) return;
    const slide = slides[currentSlideIndex];
    if (!slide) return;
    const element = slide.elements.find(el => el.id === presentationDragState.elementId);
    if (!element) return;

    const deltaXPercent = ((event.clientX - presentationDragState.startX) / presentationDragState.slideRect.width) * 100;
    const deltaYPercent = ((event.clientY - presentationDragState.startY) / presentationDragState.slideRect.height) * 100;

    if (presentationDragState.mode === 'move') {
        element.x = clamp(presentationDragState.startLeft + deltaXPercent, 0, 100 - element.width);
        element.y = clamp(presentationDragState.startTop + deltaYPercent, 0, 100 - element.height);
    } else if (presentationDragState.mode === 'resize') {
        element.width = clamp(presentationDragState.startWidth + deltaXPercent, 5, 100 - element.x);
        element.height = clamp(presentationDragState.startHeight + deltaYPercent, 5, 100 - element.y);
    }

    applyPresentationElementStyles(element);
    updatePresentationInspectorValues(element);
}

function handlePresentationPointerUp() {
    document.removeEventListener('pointermove', handlePresentationPointerMove);
    presentationDragState = null;
    const element = getSelectedElement();
    if (element) {
        updatePresentationInspector();
    }
}
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function applyPresentationElementStyles(element) {
    const elementEl = document.querySelector(`.presentation-element[data-element-id="${element.id}"]`);
    if (!elementEl) return;
    elementEl.style.left = `${element.x}%`;
    elementEl.style.top = `${element.y}%`;
    elementEl.style.width = `${element.width}%`;
    elementEl.style.height = `${element.height}%`;
    elementEl.style.transform = `rotate(${element.rotate || 0}deg)`;

    if (element.type === 'text' || element.type === 'sticky') {
        elementEl.style.fontSize = `${element.fontSize || 24}px`;
        elementEl.style.color = element.color || '#1f1f1f';
        elementEl.style.textAlign = element.align || 'left';
        elementEl.style.background = element.type === 'sticky' ? (element.background || '#ffe68a') : (element.background || 'transparent');
        if (element.type === 'sticky') {
            elementEl.style.borderRadius = '16px';
        }
        elementEl.textContent = element.text || '';
    } else if (element.type === 'rectangle' || element.type === 'circle') {
        elementEl.style.background = element.fill || '#cfe4ff';
        elementEl.style.border = `2px solid ${element.stroke || element.color || '#1f1f1f'}`;
        elementEl.style.borderRadius = element.type === 'circle' ? '50%' : '18px';
    } else if (element.type === 'arrow') {
        const svg = elementEl.querySelector('svg');
        if (svg) {
            const line = svg.querySelector('line');
            const marker = svg.querySelector('marker path');
            if (line) line.setAttribute('stroke', element.color || presentationColor);
            if (marker) marker.setAttribute('fill', element.color || presentationColor);
        }
    } else if (element.type === 'image') {
        const img = elementEl.querySelector('img');
        if (img && element.src && img.src !== element.src) {
            img.src = element.src;
        }
    }
}

function updatePresentationInspectorValues(element) {
    const inspector = document.getElementById('presentationInspector');
    if (!inspector) return;
    const map = {
        '#inspector-pos-x': Math.round(element.x),
        '#inspector-pos-y': Math.round(element.y),
        '#inspector-width': Math.round(element.width),
        '#inspector-height': Math.round(element.height),
        '#inspector-rotation': Math.round(element.rotation || 0)
    };
    Object.keys(map).forEach(selector => {
        const input = inspector.querySelector(selector);
        if (input) input.value = map[selector];
    });
}

function getSelectedElement() {
    const slide = slides[currentSlideIndex];
    if (!slide) return null;
    return slide.elements.find(el => el.id === presentationSelectedElementId) || null;
}

function selectPresentationElement(elementId) {
    presentationSelectedElementId = elementId;
    document.querySelectorAll('.presentation-element').forEach(el => {
        el.classList.toggle('selected', el.dataset.elementId === elementId);
    });
    updatePresentationInspector();
    syncPresentationToolbar(getSelectedElement());
}

function updatePresentationInspector() {
    const inspector = document.getElementById('presentationInspector');
    if (!inspector) return;

    const slide = slides[currentSlideIndex];
    if (!slide) {
        inspector.innerHTML = '<p style="opacity:0.7;font-size:13px;">Создайте слайд, чтобы добавить элементы.</p>';
        return;
    }

    const element = getSelectedElement();
    if (!element) {
        inspector.innerHTML = '<p style="opacity:0.7;font-size:13px;">Выберите элемент на слайде, чтобы настроить его стиль.</p>';
        return;
    }

    let html = `
        <div class="inspector-section">
            <h4>Положение</h4>
            <label>По горизонтали (%):
                <input type="range" id="inspector-pos-x" min="0" max="95" value="">
            </label>
            <label>По вертикали (%):
                <input type="range" id="inspector-pos-y" min="0" max="95" value="">
            </label>
            <label>Ширина (%):
                <input type="range" id="inspector-width" min="5" max="100" value="">
            </label>
            <label>Высота (%):
                <input type="range" id="inspector-height" min="5" max="100" value="">
            </label>
            <label>Поворот:
                <input type="range" id="inspector-rotation" min="0" max="360" value="">
            </label>
        </div>
    `;
    if (element.type === 'text' || element.type === 'sticky') {
        html += `
            <div class="inspector-section">
                <h4>Текст</h4>
                <label>Размер шрифта:
                    <input type="range" id="inspector-fontsize" min="12" max="96" value="">
                </label>
                <label>Цвет текста:
                    <input type="color" id="inspector-text-color" value="">
                </label>
                <label>Цвет фона:
                    <input type="color" id="inspector-background" value="${element.background || (element.type === 'sticky' ? '#ffe68a' : '#ffffff')}">
                </label>
                <label>Выравнивание:
                    <select id="inspector-align">
                        <option value="left">По левому краю</option>
                        <option value="center">По центру</option>
                        <option value="right">По правому краю</option>
                    </select>
                </label>
            </div>
        `;
    } else if (element.type === 'rectangle' || element.type === 'circle') {
        html += `
            <div class="inspector-section">
                <h4>Оформление</h4>
                <label>Цвет заливки:
                    <input type="color" id="inspector-fill" value="">
                </label>
                <label>Цвет линии:
                    <input type="color" id="inspector-border" value="">
                </label>
            </div>
        `;
    } else if (element.type === 'arrow') {
        html += `
            <div class="inspector-section">
                <h4>Стрелка</h4>
                <label>Цвет:
                    <input type="color" id="inspector-arrow-color" value="">
                </label>
                <label>Толщина (%):
                    <input type="range" id="inspector-arrow-thickness" min="3" max="25" value="">
                </label>
            </div>
        `;
    } else if (element.type === 'image') {
        html += `
            <div class="inspector-section">
                <h4>Изображение</h4>
                <button class="ghost-btn" id="inspector-replace-image">Заменить изображение</button>
            </div>
        `;
    }

    inspector.innerHTML = html;

    const posX = inspector.querySelector('#inspector-pos-x');
    if (posX) {
        posX.addEventListener('input', (e) => updatePresentationElement(element.id, { x: clamp(parseFloat(e.target.value), 0, 95) }));
    }
    const posY = inspector.querySelector('#inspector-pos-y');
    if (posY) {
        posY.addEventListener('input', (e) => updatePresentationElement(element.id, { y: clamp(parseFloat(e.target.value), 0, 95) }));
    }
    const widthInput = inspector.querySelector('#inspector-width');
    if (widthInput) {
        widthInput.addEventListener('input', (e) => updatePresentationElement(element.id, { width: clamp(parseFloat(e.target.value), 5, 100) }));
    }
    const heightInput = inspector.querySelector('#inspector-height');
    if (heightInput) {
        heightInput.addEventListener('input', (e) => updatePresentationElement(element.id, { height: clamp(parseFloat(e.target.value), 5, 100) }));
    }
    const rotationInput = inspector.querySelector('#inspector-rotation');
    if (rotationInput) {
        rotationInput.addEventListener('input', (e) => updatePresentationElement(element.id, { rotation: parseFloat(e.target.value) % 360 }));
    }

    const fontSizeInput = inspector.querySelector('#inspector-fontsize');
    if (fontSizeInput) {
        fontSizeInput.addEventListener('input', (e) => updatePresentationElement(element.id, { fontSize: parseInt(e.target.value, 10) || 24 }));
    }
    const textColorInput = inspector.querySelector('#inspector-text-color');
    if (textColorInput) {
        textColorInput.addEventListener('input', (e) => updatePresentationElement(element.id, { color: e.target.value }));
    }
    const backgroundInput = inspector.querySelector('#inspector-background');
    if (backgroundInput) {
        backgroundInput.addEventListener('input', (e) => updatePresentationElement(element.id, { background: e.target.value }));
    }
    const alignSelect = inspector.querySelector('#inspector-align');
    if (alignSelect) {
        alignSelect.addEventListener('change', (e) => updatePresentationElement(element.id, { align: e.target.value }));
    }
    const fillInput = inspector.querySelector('#inspector-fill');
    if (fillInput) {
        fillInput.addEventListener('input', (e) => updatePresentationElement(element.id, { fill: e.target.value }));
    }
    const borderInput = inspector.querySelector('#inspector-border');
    if (borderInput) {
        borderInput.addEventListener('input', (e) => updatePresentationElement(element.id, { border: e.target.value }));
    }
    const arrowColorInput = inspector.querySelector('#inspector-arrow-color');
    if (arrowColorInput) {
        arrowColorInput.addEventListener('input', (e) => updatePresentationElement(element.id, { color: e.target.value }));
    }
    const arrowThickness = inspector.querySelector('#inspector-arrow-thickness');
    if (arrowThickness) {
        arrowThickness.addEventListener('input', (e) => updatePresentationElement(element.id, { height: clamp(parseFloat(e.target.value), 3, 25) }));
    }
    const replaceBtn = inspector.querySelector('#inspector-replace-image');
    if (replaceBtn) {
        replaceBtn.addEventListener('click', () => {
            const input = document.getElementById('presentationImageInput');
            if (input) input.click();
        });
    }
}

function updatePresentationElement(elementId, updates) {
    const slide = slides[currentSlideIndex];
    if (!slide) return;
    const element = slide.elements.find(el => el.id === elementId);
    if (!element) return;
    Object.assign(element, updates);
    applyPresentationElementStyles(element);
    updatePresentationInspectorValues(element);
    syncPresentationToolbar(getSelectedElement());
}
function addPresentationElement(type, overrides = {}) {
    ensureDefaultPresentation();
    const slide = slides[currentSlideIndex];
    if (!slide) return;
    const element = createPresentationElement(type, overrides);
    slide.elements.push(element);
    presentationSelectedElementId = element.id;
    renderSlides();
    const selectBtn = document.querySelector('.presentation-toolbar .tool-btn[data-tool="select"]');
    if (selectBtn) selectPresentationTool('select', selectBtn);
}

function handlePresentationImage(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        addPresentationElement('image', { src: reader.result, width: 40, height: 30, x: 50, y: 45 });
    };
    reader.readAsDataURL(file);
    event.target.value = '';
}

function setPresentationColor(color) {
    presentationColor = color;
    const element = getSelectedElement();
    if (!element) return;
    if (element.type === 'text' || element.type === 'sticky') {
        element.color = color;
    } else if (element.type === 'rectangle' || element.type === 'circle' || element.type === 'arrow') {
        element.color = color;
        if (element.type === 'rectangle' || element.type === 'circle') {
            element.border = color;
        }
    }
    applyPresentationElementStyles(element);
    updatePresentationInspectorValues(element);
}

function setPresentationFontSize(size) {
    presentationFontSize = parseInt(size, 10) || presentationFontSize;
    const element = getSelectedElement();
    if (element && (element.type === 'text' || element.type === 'sticky')) {
        element.fontSize = presentationFontSize;
        applyPresentationElementStyles(element);
        updatePresentationInspectorValues(element);
    }
}

function toggleSlideGrid() {
    presentationGridEnabled = !presentationGridEnabled;
    const container = document.getElementById('presentationSlides');
    if (container) {
        container.classList.toggle('grid-on', presentationGridEnabled);
    }
    const gridButton = document.getElementById('presentationGridToggle');
    if (gridButton) {
        if (presentationGridEnabled) {
            gridButton.classList.add('active');
        } else {
            gridButton.classList.remove('active');
        }
    }
}

function updateSlideCounter() {
    const counter = document.getElementById('slideCounter');
    if (counter) {
        counter.textContent = `${currentSlideIndex + 1} / ${slides.length}`;
    }
}

function nextSlide() {
    if (currentSlideIndex < slides.length - 1) {
        currentSlideIndex += 1;
        presentationSelectedElementId = null;
        renderSlides();
        syncSlideChange();
    }
}

function prevSlide() {
    if (currentSlideIndex > 0) {
        currentSlideIndex -= 1;
        presentationSelectedElementId = null;
        renderSlides();
        syncSlideChange();
    }
}

function addNewSlide() {
    const newSlide = createPresentationSlide();
    slides.push(newSlide);
    currentSlideIndex = slides.length - 1;
    presentationSelectedElementId = null;
    renderSlides();
    syncSlideChange();
}

function duplicateSlide() {
    ensureDefaultPresentation();
    const slide = slides[currentSlideIndex];
    if (!slide) return;
    const clone = JSON.parse(JSON.stringify(slide));
    clone.id = generatePresentationId('slide');
    clone.name = `${slide.name || 'Слайд'} (копия)`;
    clone.elements = clone.elements.map(el => ({ ...el, id: generatePresentationId('element') }));
    slides.splice(currentSlideIndex + 1, 0, clone);
    currentSlideIndex += 1;
    presentationSelectedElementId = null;
    renderSlides();
    syncSlideChange();
}

function deleteSlide() {
    if (slides.length <= 1) {
        slides[0].elements = [];
        presentationSelectedElementId = null;
        renderSlides();
        return;
    }
    slides.splice(currentSlideIndex, 1);
    currentSlideIndex = Math.max(0, currentSlideIndex - 1);
    presentationSelectedElementId = null;
    renderSlides();
    syncSlideChange();
}

function syncSlideChange() {
    if (currentRoomId && socket) {
        socket.emit('presentation_slide_change', {
            room_id: currentRoomId,
            slide_index: currentSlideIndex
        });
    }
}

function startPresentation() {
    const slidesContainer = document.getElementById('presentationSlides');
    if (!slidesContainer) return;
    if (slidesContainer.requestFullscreen) {
        slidesContainer.requestFullscreen();
    } else if (slidesContainer.webkitRequestFullscreen) {
        slidesContainer.webkitRequestFullscreen();
    } else if (slidesContainer.msRequestFullscreen) {
        slidesContainer.msRequestFullscreen();
    }
    document.addEventListener('keydown', handlePresentationKeys);
}

document.addEventListener('click', function detachPresentationKeys(e) {
    const overlay = e && e.target && e.target.closest && e.target.closest('#presentationModal');
    if (overlay && (e.target.classList.contains('close-btn') || e.target.id === 'presentationModal')) {
        document.removeEventListener('keydown', handlePresentationKeys);
    }
});

function handlePresentationKeys(e) {
    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        nextSlide();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        prevSlide();
    } else if (e.key === 'Escape') {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        }
        document.removeEventListener('keydown', handlePresentationKeys);
    }
}
async function exportCurrentSlideAsBlob() {
    ensureDefaultPresentation();
    const slide = slides[currentSlideIndex];
    if (!slide) return null;
    const canvas = document.createElement('canvas');
    const width = 1920;
    const height = 1080;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = slide.background || '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const imagePromises = [];

    slide.elements.forEach((element) => {
        const x = (element.x / 100) * width;
        const y = (element.y / 100) * height;
        const w = (element.width / 100) * width;
        const h = (element.height / 100) * height;
        const radians = (element.rotation || 0) * Math.PI / 180;

        ctx.save();
        ctx.translate(x + w / 2, y + h / 2);
        ctx.rotate(radians);
        ctx.translate(-w / 2, -h / 2);

        if (element.type === 'text' || element.type === 'sticky') {
            if (element.type === 'sticky') {
                ctx.fillStyle = element.background || '#ffe68a';
                ctx.fillRect(0, 0, w, h);
            }
            ctx.fillStyle = element.color || '#1f1f1f';
            ctx.font = `${element.fontSize || 32}px 'Inter', 'Arial', sans-serif`;
            ctx.textAlign = element.align || 'left';
            ctx.textBaseline = 'top';
            const lines = (element.text || '').split(/\n/);
            const lineHeight = (element.fontSize || 32) * 1.25;
            let offsetX = 0;
            if (ctx.textAlign === 'center') offsetX = w / 2;
            if (ctx.textAlign === 'right') offsetX = w;
            lines.forEach((line, idx) => ctx.fillText(line, offsetX, 12 + idx * lineHeight));
        } else if (element.type === 'rectangle' || element.type === 'circle') {
            ctx.fillStyle = element.fill || '#cfe4ff';
            ctx.strokeStyle = element.border || presentationColor;
            ctx.lineWidth = 6;
            if (element.type === 'circle') {
                ctx.beginPath();
                ctx.arc(w / 2, h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            } else {
                if (ctx.roundRect) {
                    ctx.beginPath();
                    ctx.roundRect(0, 0, w, h, 28);
                    ctx.fill();
                    ctx.stroke();
                } else {
                    drawRoundedRect(ctx, 0, 0, w, h, 28);
                    ctx.fill();
                    ctx.stroke();
                }
            }
        } else if (element.type === 'arrow') {
            ctx.strokeStyle = element.color || presentationColor;
            ctx.lineWidth = Math.max(8, h * 0.4);
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(10, h / 2);
            ctx.lineTo(w - 30, h / 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(w - 40, h / 2 - ctx.lineWidth);
            ctx.lineTo(w - 10, h / 2);
            ctx.lineTo(w - 40, h / 2 + ctx.lineWidth);
            ctx.closePath();
            ctx.fillStyle = element.color || presentationColor;
            ctx.fill();
        } else if (element.type === 'image' && element.src) {
            const promise = new Promise((resolve) => {
                const img = new Image();
                img.onload = () => {
                    ctx.drawImage(img, 0, 0, w, h);
                    resolve();
                };
                img.onerror = resolve;
                img.src = element.src;
            });
            imagePromises.push(promise);
        }

        ctx.restore();
    });

    await Promise.all(imagePromises);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

async function sharePresentation() {
    if (!currentRoomId) {
        alert('Выберите чат, чтобы отправить слайд.');
        return;
    }
    const blob = await exportCurrentSlideAsBlob();
    if (!blob) {
        alert('Не удалось подготовить изображение слайда.');
        return;
    }
    const formData = new FormData();
    formData.append('room_id', currentRoomId);
    formData.append('caption', slides[currentSlideIndex] && slides[currentSlideIndex].name ? slides[currentSlideIndex].name : 'Слайд презентации');
    formData.append('files', new File([blob], `slide-${currentSlideIndex + 1}.png`, { type: 'image/png' }));
    try {
        const response = await fetch('/api/send_media', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        if (!data.success) {
            alert(data.message || 'Не удалось отправить слайд.');
        }
    } catch (error) {
        console.error('sharePresentation error:', error);
        alert('Произошла ошибка при отправке слайда.');
    }
}

// ========== НОВОЕ: Функции для работы с аватарами комнат ==========

async function uploadRoomAvatarFile(event) {
    const files = event.target.files;
    if (!files || !files[0]) return;
    
    const roomId = document.getElementById('roomSettingsId').value;
    if (!roomId) return;
    
    const form = new FormData();
    form.append('avatar', files[0]);
    form.append('room_id', roomId);
    
    const messageBox = document.getElementById('roomAvatarMessage');
    
    try {
        const resp = await fetch('/api/upload_room_avatar', { method: 'POST', body: form });
        const data = await resp.json();
        
        if (data.success) {
            // Обновляем превью в модальном окне
            const previewContainer = document.getElementById('roomSettingsAvatarPreview');
            if (previewContainer) {
                previewContainer.innerHTML = `<img src="${data.avatar_url}" alt="Avatar" style="width: 100%; height: 100%; object-fit: cover; border-radius: inherit;">`;
            }
            
            // Показываем кнопку удаления
            const removeBtn = document.getElementById('removeRoomAvatarBtn');
            if (removeBtn) removeBtn.style.display = 'inline-block';
            
            showMessage(messageBox, 'Аватар комнаты обновлён.', 'success');
            
            // Обновление произойдет автоматически через событие room_updated от сервера
        } else {
            showMessage(messageBox, data.message || 'Не удалось загрузить аватар.', 'error');
        }
    } catch {
        showMessage(messageBox, 'Ошибка сети.', 'error');
    }
}

async function removeRoomAvatar() {
    const roomId = document.getElementById('roomSettingsId').value;
    if (!roomId) return;
    
    const messageBox = document.getElementById('roomAvatarMessage');
    
    try {
        const resp = await fetch('/api/remove_room_avatar', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ room_id: parseInt(roomId) })
        });
        const data = await resp.json();
        
        if (data.success) {
            // Обновляем превью - возвращаем иконку по умолчанию
            const previewContainer = document.getElementById('roomSettingsAvatarPreview');
            if (previewContainer) {
                previewContainer.innerHTML = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                </svg>`;
            }
            
            // Скрываем кнопку удаления
            const removeBtn = document.getElementById('removeRoomAvatarBtn');
            if (removeBtn) removeBtn.style.display = 'none';
            
            showMessage(messageBox, 'Аватар комнаты удалён.', 'success');
        } else {
            showMessage(messageBox, data.message || 'Не удалось удалить аватар.', 'error');
        }
    } catch {
        showMessage(messageBox, 'Ошибка сети.', 'error');
    }
}

// ========== Функции для работы с контактами ==========

function openDMWithContact() {
    const contactId = document.getElementById('contactSettingsId').value;
    if (!contactId) return;
    
    // Закрываем модальное окно контакта
    closeModal({target: document.getElementById('contactSettingsModal'), forceClose: true});
    
    // Ищем DM комнату с этим пользователем
    const roomElement = document.querySelector(`.room-item[data-dm-other-id="${contactId}"]`);
    if (roomElement) {
        selectRoom(roomElement);
    } else {
        // Если комнаты нет, создаем её
        fetch('/api/start_dm', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ contact_id: parseInt(contactId) }),
        })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                const newRoomElement = addNewRoomToSidebar(data.room);
                selectRoom(newRoomElement);
            }
        })
        .catch(() => alert('Ошибка сети.'));
    }
}

async function blockContactFromSettings() {
    const contactId = document.getElementById('contactSettingsId').value;
    if (!contactId) return;
    
    if (!confirm('Вы уверены, что хотите заблокировать этого пользователя?')) return;
    
    try {
        const response = await fetch('/api/block_user', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ user_id: parseInt(contactId) })
        });
        const data = await response.json();
        
        if (data.success) {
            // Добавляем в список заблокированных
            addToBlockedList(contactId);
            
            // Обновляем кнопку на "Разблокировать"
            updateBlockButton(true);
            
            // Добавляем системное сообщение в чат
            if (currentDMotherUserId == contactId) {
                addSystemMessage('Вы заблокировали этого пользователя');
                messageInput.disabled = true;
                sendButton.disabled = true;
                messageInput.placeholder = 'Вы заблокировали этого пользователя.';
                
                // Скрываем кнопку звонка
                const callButton = document.getElementById('call-button');
                if (callButton) callButton.style.display = 'none';
            }
            
            alert('Пользователь заблокирован.');
        } else {
            alert(data.message || 'Не удалось заблокировать.');
        }
    } catch (error) {
        console.error('Ошибка блокировки:', error);
        alert('Ошибка сети.');
    }
}

async function unblockContactFromSettings() {
    const contactId = document.getElementById('contactSettingsId').value;
    if (!contactId) return;
    
    if (!confirm('Вы уверены, что хотите разблокировать этого пользователя?')) return;
    
    try {
        const response = await fetch('/api/unblock_user', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ user_id: parseInt(contactId) })
        });
        const data = await response.json();
        
        if (data.success) {
            // Удаляем из списка заблокированных
            removeFromBlockedList(contactId);
            
            // Обновляем кнопку на "Заблокировать"
            updateBlockButton(false);
            
            // Добавляем системное сообщение в чат
            if (currentDMotherUserId == contactId) {
                addSystemMessage('Вы разблокировали этого пользователя');
                messageInput.disabled = false;
                sendButton.disabled = false;
                messageInput.placeholder = 'Введите сообщение...';
                
                // Показываем кнопку звонка обратно
                const callButton = document.getElementById('call-button');
                if (callButton) callButton.style.display = 'flex';
            }
            
            alert('Пользователь разблокирован.');
        } else {
            alert(data.message || 'Не удалось разблокировать.');
        }
    } catch (error) {
        console.error('Ошибка разблокировки:', error);
        alert('Ошибка сети.');
    }
}

function updateBlockButton(isBlocked) {
    // Ищем кнопку блокировки в модальном окне контакта
    const modal = document.getElementById('contactSettingsModal');
    if (!modal) return;
    
    // Ищем все кнопки в нижнем ряду действий
    const buttons = modal.querySelectorAll('button');
    let blockBtn = null;
    
    // Находим кнопку по тексту или onclick
    buttons.forEach(btn => {
        const text = btn.textContent.trim();
        if (text.includes('Заблокировать') || text.includes('Разблокировать')) {
            blockBtn = btn;
        }
    });
    
    if (!blockBtn) return;
    
    if (isBlocked) {
        blockBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 6px;">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M12 8v4"></path>
            <path d="M12 16h.01"></path>
        </svg>
        Разблокировать`;
        blockBtn.style.background = 'var(--color-success)';
        blockBtn.onclick = unblockContactFromSettings;
    } else {
        blockBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 6px;">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
        </svg>
        Заблокировать`;
        blockBtn.style.background = 'var(--color-danger)';
        blockBtn.onclick = blockContactFromSettings;
    }
}

// Глобальная переменная для отслеживания заблокированных пользователей
let blockedUsers = new Set();

// ========== НОВОЕ: Функции для кнопки звонка с выпадающим меню ==========

let isAudioOnly = false; // Флаг: аудио-звонок (без видео) или видео-звонок
let callStartTime = null; // Время начала звонка
let callTimerInterval = null; // Интервал для таймера

function toggleCallDropdown(event) {
    event.stopPropagation();
    event.preventDefault();
    
    const menu = document.getElementById('call-dropdown-menu');
    if (!menu) {
        console.error('call-dropdown-menu не найдено!');
        return;
    }
    
    const isVisible = menu.classList.contains('show');
    console.log('toggleCallDropdown вызвана, isVisible:', isVisible);
    
    if (isVisible) {
        // вместо мгновенного скрытия дадим возможность повторного открытия без конфликтов
        menu.classList.remove('show');
        // не выходим, чтобы переустановить обработчик внешнего клика корректно
    }
    
    menu.classList.add('show');
    
    // Закрыть при клике вне меню
    setTimeout(() => {
        function closeDropdown(e) {
            // если клик по самой кнопке-стрелке — игнорим (чтобы не закрывалось до toggle)
            const inWrapper = e.target.closest('.call-button-wrapper');
            if (!inWrapper) {
                menu.classList.remove('show');
                document.removeEventListener('click', closeDropdown);
            }
        }
        document.addEventListener('click', closeDropdown, { capture: true, once: true });
    }, 50);
}

async function startVideoCall() {
    // Проверяем блокировку
    if (currentRoomType === 'dm' && currentDMotherUserId) {
        if (blockedUsers.has(parseInt(currentDMotherUserId))) {
            alert('Вы не можете позвонить заблокированному пользователю.');
            return;
        }
    }
    
    // Закрываем меню
    document.getElementById('call-dropdown-menu').classList.remove('show');
    
    isAudioOnly = false; // Видео звонок
    await openCall(); // Используем существующую функцию
}

async function startAudioCall() {
    // Проверяем блокировку
    if (currentRoomType === 'dm' && currentDMotherUserId) {
        if (blockedUsers.has(parseInt(currentDMotherUserId))) {
            alert('Вы не можете позвонить заблокированному пользователю.');
            return;
        }
    }
    
    // Закрываем меню
    document.getElementById('call-dropdown-menu').classList.remove('show');
    
    isAudioOnly = true; // Аудио звонок (без видео)
    await openCall(); // Используем существующую функцию
}

// Обновленная функция ensureLocalMedia с поддержкой аудио-режима и улучшенной совместимостью
async function ensureLocalMediaWithMode() {
    if (localStream) {
        // Если поток уже есть, проверяем нужно ли изменить режим
        const hasVideo = localStream.getVideoTracks().length > 0;
        if (isAudioOnly && hasVideo) {
            // Останавливаем видео, если это аудио-звонок
            localStream.getVideoTracks().forEach(t => t.stop());
        }
        return localStream;
    }
    
    try {
        if (isAudioOnly) {
            // Только аудио
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: { 
                    echoCancellation: true, 
                    noiseSuppression: true, 
                    autoGainControl: true 
                },
                video: false
            });
            isCamEnabled = false;
        } else {
            // Аудио + видео с улучшенными настройками для мобильных
            try {
                localStream = await navigator.mediaDevices.getUserMedia({
                    audio: { 
                        echoCancellation: true, 
                        noiseSuppression: true, 
                        autoGainControl: true 
                    },
                    video: {
                        width: { ideal: 1280, max: 1920 },
                        height: { ideal: 720, max: 1080 },
                        frameRate: { ideal: 30, max: 60 },
                        facingMode: 'user' // Для мобильных - фронтальная камера
                    }
                });
                isCamEnabled = true;
            } catch (e1) {
                // Если не получилось с конкретными настройками, пробуем базовые
                try {
                    localStream = await navigator.mediaDevices.getUserMedia({
                        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                        video: true
                    });
                    isCamEnabled = true;
                } catch (e2) {
                    // Если камера недоступна, пробуем только аудио
                    localStream = await navigator.mediaDevices.getUserMedia({
                        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                        video: false
                    });
                    isCamEnabled = false;
                    console.log('Камера недоступна. Подключаемся только с аудио.');
                }
            }
        }
    } catch (e3) {
        console.error('Ошибка доступа к медиа:', e3);
        alert('Нет доступа к микрофону/камере');
        throw e3;
    }
    
    const localVideo = document.getElementById('localVideo');
    if (localVideo) {
        localVideo.srcObject = localStream;
        localVideo.muted = true;
        // Для мобильных - обязательные атрибуты
        localVideo.setAttribute('playsinline', 'true');
        localVideo.setAttribute('webkit-playsinline', 'true');
    }
    isMicEnabled = true;
    
    // Обновляем визуальное состояние кнопок
    const micBtn = document.getElementById('toggleMicBtn');
    const camBtn = document.getElementById('toggleCamBtn');
    if (micBtn) {
        micBtn.classList.remove('disabled');
        micBtn.classList.add('enabled');
    }
    if (camBtn) {
        camBtn.classList.remove('disabled', 'enabled');
        camBtn.classList.add(isCamEnabled ? 'enabled' : 'disabled');
    }
    
    return localStream;
}

// ========== Индикатор активного звонка ==========

function showCallIndicator() {
    const indicator = document.getElementById('active-call-indicator');
    if (indicator) {
        indicator.style.display = 'flex';
        
        // Запускаем таймер (callStartTime уже должен быть установлен в openCall)
        if (!callStartTime) {
        callStartTime = Date.now();
            console.log('callStartTime установлен в showCallIndicator:', callStartTime);
        }
        updateCallTimer();
        callTimerInterval = setInterval(updateCallTimer, 1000);
    }
}

function hideCallIndicator() {
    const indicator = document.getElementById('active-call-indicator');
    if (indicator) {
        indicator.style.display = 'none';
    }
    
    // Останавливаем таймер
    if (callTimerInterval) {
        clearInterval(callTimerInterval);
        callTimerInterval = null;
    }
    callStartTime = null;
}

function updateCallTimer() {
    if (!callStartTime) return;
    
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    
    const timerEl = document.getElementById('call-indicator-timer');
    if (timerEl) {
        timerEl.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
}

function returnToCall() {
    // Возвращаемся к окну звонка
    openModal('callModal');
}

// Обновляем информацию в индикаторе
function updateCallIndicatorInfo(title, subtitle) {
    const titleEl = document.getElementById('call-indicator-title');
    const subtitleEl = document.getElementById('call-indicator-subtitle');
    if (titleEl) titleEl.textContent = title || 'Активный звонок';
    if (subtitleEl) subtitleEl.textContent = subtitle || 'Нажмите, чтобы вернуться';
}

// ========== Обновление функций блокировки ==========

// Обновляем Set при блокировке
function addToBlockedList(userId) {
    blockedUsers.add(parseInt(userId));
}

// Обновляем Set при разблокировке
function removeFromBlockedList(userId) {
    blockedUsers.delete(parseInt(userId));
}

// ========== Выбор устройств (микрофон, камера, динамики) ==========

let selectedMicId = null;
let selectedCamId = null;
let selectedSpeakerId = null;

async function toggleDeviceMenu(event, deviceType) {
    event.stopPropagation();
    
    const menuId = deviceType === 'mic' ? 'mic-device-menu' : 
                   deviceType === 'cam' ? 'cam-device-menu' : 'screen-device-menu';
    const menu = document.getElementById(menuId);
    
    // Закрываем другие меню
    document.querySelectorAll('.device-menu').forEach(m => {
        if (m.id !== menuId) m.classList.remove('show');
    });
    
    // Переключаем текущее меню
    const isShowing = menu.classList.toggle('show');
    
    if (isShowing) {
        // Загружаем список устройств или опций
        if (deviceType === 'screen') {
            loadScreenShareOptions();
        } else {
            await loadDevicesList(deviceType);
        }
    }
    
    // Закрыть при клике вне меню
    if (isShowing) {
        setTimeout(() => {
            document.addEventListener('click', function closeDeviceMenu(e) {
                if (!e.target.closest('.control-btn-wrapper')) {
                    menu.classList.remove('show');
                    document.removeEventListener('click', closeDeviceMenu);
                }
            });
        }, 100);
    }
}

async function loadDevicesList(deviceType) {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const menuId = deviceType === 'mic' ? 'mic-device-menu' : 'cam-device-menu';
        const menu = document.getElementById(menuId);
        
        menu.innerHTML = '';
        menu.style.minWidth = deviceType === 'mic' ? '280px' : '250px';
        
        if (deviceType === 'mic') {
            // Расширенное меню для микрофона
            // 1. Заголовок
            const header = document.createElement('div');
            header.className = 'device-menu-header';
            header.textContent = 'Микрофон';
            menu.appendChild(header);
            
            // 2. Список микрофонов
            const micDevices = devices.filter(d => d.kind === 'audioinput');
            micDevices.forEach((device, index) => {
                const item = document.createElement('div');
                item.className = 'device-menu-item';
                
                if (device.deviceId === selectedMicId || (!selectedMicId && index === 0)) {
                    item.classList.add('active');
                }
                
                const label = device.label || `Микрофон ${index + 1}`;
                item.innerHTML = `<span>${label}</span>`;
                item.onclick = () => switchDevice(device.deviceId, 'mic');
                menu.appendChild(item);
            });
            
            // Разделитель
            const separator1 = document.createElement('div');
            separator1.style.height = '1px';
            separator1.style.background = 'rgba(255,255,255,0.1)';
            separator1.style.margin = '8px 0';
            menu.appendChild(separator1);
            
            // 3. Шумоподавление
            const noiseHeader = document.createElement('div');
            noiseHeader.className = 'device-menu-header';
            noiseHeader.textContent = 'Шумоподавление';
            noiseHeader.style.fontSize = '12px';
            noiseHeader.style.padding = '8px 16px';
            menu.appendChild(noiseHeader);
            
            const noiseLevels = [
                {level: 'off', label: 'Выкл.'},
                {level: 'low', label: 'Слабое'},
                {level: 'high', label: 'Сильное'}
            ];
            
            noiseLevels.forEach(({level, label}) => {
                const item = document.createElement('div');
                item.className = 'device-menu-item';
                if (level === 'high') item.classList.add('active'); // По умолчанию
                item.textContent = label;
                item.onclick = () => {
                    menu.querySelectorAll('.device-menu-item').forEach(i => {
                        if (noiseLevels.some(l => i.textContent === l.label)) {
                            i.classList.remove('active');
                        }
                    });
                    item.classList.add('active');
                    console.log('Шумоподавление:', level);
                };
                menu.appendChild(item);
            });
            
            // Разделитель
            const separator2 = document.createElement('div');
            separator2.style.height = '1px';
            separator2.style.background = 'rgba(255,255,255,0.1)';
            separator2.style.margin = '8px 0';
            menu.appendChild(separator2);
            
            // 4. Динамики
            const speakerHeader = document.createElement('div');
            speakerHeader.className = 'device-menu-header';
            speakerHeader.textContent = 'Динамики';
            speakerHeader.style.fontSize = '12px';
            speakerHeader.style.padding = '8px 16px';
            menu.appendChild(speakerHeader);
            
            const speakers = devices.filter(d => d.kind === 'audiooutput');
            if (speakers.length > 0) {
                speakers.forEach((device, index) => {
                    const item = document.createElement('div');
                    item.className = 'device-menu-item';
                    const label = device.label || `Динамик ${index + 1}`;
                    item.textContent = label;
                    item.onclick = () => console.log('Динамик:', device.deviceId);
                    menu.appendChild(item);
                });
            } else {
                const noSpeakers = document.createElement('div');
                noSpeakers.className = 'device-menu-item';
                noSpeakers.textContent = 'Динамики не поддерживаются';
                noSpeakers.style.opacity = '0.5';
                menu.appendChild(noSpeakers);
            }
            
            // Разделитель
            const separator3 = document.createElement('div');
            separator3.style.height = '1px';
            separator3.style.background = 'rgba(255,255,255,0.1)';
            separator3.style.margin = '8px 0';
            menu.appendChild(separator3);
            
            // 5. Действия
            const testSound = document.createElement('div');
            testSound.className = 'device-menu-item';
            testSound.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 18V5l12-2v13"></path>
                    <circle cx="6" cy="18" r="3"></circle>
                    <circle cx="18" cy="16" r="3"></circle>
                </svg>
                <span>Проверить звук</span>
            `;
            testSound.onclick = () => testMicrophone();
            menu.appendChild(testSound);
            
            const toggleMic = document.createElement('div');
            toggleMic.className = 'device-menu-item';
            toggleMic.style.color = '#ff3b30';
            toggleMic.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="1" y1="1" x2="23" y2="23"></line>
                    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path>
                    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
                    <line x1="12" y1="19" x2="12" y2="23"></line>
                    <line x1="8" y1="23" x2="16" y2="23"></line>
                </svg>
                <span>Выключить микрофон</span>
            `;
            toggleMic.onclick = () => {
                menu.classList.remove('show');
                toggleMic();
            };
            menu.appendChild(toggleMic);
            
        } else if (deviceType === 'cam') {
            // Расширенное меню для камеры
            const header = document.createElement('div');
            header.className = 'device-menu-header';
            header.textContent = 'Камера';
            menu.appendChild(header);
            
            const camDevices = devices.filter(d => d.kind === 'videoinput');
            camDevices.forEach((device, index) => {
                const item = document.createElement('div');
                item.className = 'device-menu-item';
                
                if (device.deviceId === selectedCamId || (!selectedCamId && index === 0)) {
                    item.classList.add('active');
                }
                
                const label = device.label || `Камера ${index + 1}`;
                item.textContent = label;
                item.onclick = () => switchDevice(device.deviceId, 'cam');
                menu.appendChild(item);
            });
            
            // Разделитель
            const separator = document.createElement('div');
            separator.style.height = '1px';
            separator.style.background = 'rgba(255,255,255,0.1)';
            separator.style.margin = '8px 0';
            menu.appendChild(separator);
            
            // Эффекты
            const effects = document.createElement('div');
            effects.className = 'device-menu-item';
            effects.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M12 1v6M12 17v6M4.22 4.22l4.24 4.24M15.54 15.54l4.24 4.24M1 12h6M17 12h6M4.22 19.78l4.24-4.24M15.54 8.46l4.24-4.24"></path>
                </svg>
                <span>Эффекты</span>
            `;
            effects.onclick = () => {
                menu.classList.remove('show');
                openVideoEffectsModal();
            };
            menu.appendChild(effects);
            
            // Разделитель
            const separator2 = document.createElement('div');
            separator2.style.height = '1px';
            separator2.style.background = 'rgba(255,255,255,0.1)';
            separator2.style.margin = '8px 0';
            menu.appendChild(separator2);
            
            // Выключить камеру
            const toggleCamItem = document.createElement('div');
            toggleCamItem.className = 'device-menu-item';
            toggleCamItem.style.color = '#ff3b30';
            toggleCamItem.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="1" y1="1" x2="23" y2="23"></line>
                    <path d="m23 7-7 5 7 5V7z"></path>
                    <path d="m10 5 .01.01M7 3h6l.99.99"></path>
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
                </svg>
                <span>Выключить камеру</span>
            `;
            toggleCamItem.onclick = () => {
                menu.classList.remove('show');
                toggleCam();
            };
            menu.appendChild(toggleCamItem);
        }
        
    } catch (error) {
        console.error('Ошибка загрузки устройств:', error);
    }
}

function testMicrophone() {
    alert('Проверка микрофона:\n1. Говорите в микрофон\n2. Проверьте индикатор уровня\n3. Слушайте себя через динамики');
    // Можно добавить визуализацию уровня звука
}

function loadScreenShareOptions() {
    const menu = document.getElementById('screen-device-menu');
    menu.innerHTML = '';
    menu.style.minWidth = '300px';
    
    // Заголовок
    const header = document.createElement('div');
    header.className = 'device-menu-header';
    header.textContent = 'Выберите, что показать';
    menu.appendChild(header);
    
    // Опции демонстрации
    const options = [
        {
            icon: '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line>',
            title: 'Весь экран',
            subtitle: 'Показать весь рабочий стол',
            action: () => shareScreenAdvanced('screen')
        },
        {
            icon: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><polyline points="9 22 9 12 15 12 15 22"></polyline>',
            title: 'Окно',
            subtitle: 'Показать конкретное окно',
            action: () => shareScreenAdvanced('window')
        },
        {
            icon: '<rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect><polyline points="17 2 12 7 7 2"></polyline>',
            title: 'Вкладка браузера',
            subtitle: 'Показать вкладку Chrome',
            action: () => shareScreenAdvanced('tab')
        }
    ];
    
    options.forEach(opt => {
        const item = document.createElement('div');
        item.className = 'device-menu-item device-menu-item-large';
        item.style.flexDirection = 'row';
        item.style.alignItems = 'center';
        item.style.padding = '12px 16px';
        item.innerHTML = `
            <div class="device-menu-item-icon" style="width: 32px; height: 32px; background: rgba(0,122,255,0.15); border-radius: 8px; display: flex; align-items: center; justify-content: center; margin-right: 12px;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    ${opt.icon}
                </svg>
            </div>
            <div style="flex: 1;">
                <div style="font-weight: 600; font-size: 14px; margin-bottom: 2px;">${opt.title}</div>
                <div style="font-size: 11px; opacity: 0.7;">${opt.subtitle}</div>
            </div>
        `;
        item.onclick = () => {
            menu.classList.remove('show');
            opt.action();
        };
        menu.appendChild(item);
    });
    
    // Разделитель
    const separator = document.createElement('div');
    separator.style.height = '1px';
    separator.style.background = 'rgba(255,255,255,0.1)';
    separator.style.margin = '8px 0';
    menu.appendChild(separator);
    
    // Дополнительные опции
    const extraOptions = [
        {icon: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>', title: 'Доска для рисования', action: openWhiteboard},
        {icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>', title: 'Совместные документы', action: openDocuments},
        {icon: '<rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path>', title: 'Презентация', action: openPresentation}
    ];
    
    extraOptions.forEach(opt => {
        const item = document.createElement('div');
        item.className = 'device-menu-item';
        item.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                ${opt.icon}
            </svg>
            <span>${opt.title}</span>
        `;
        item.onclick = () => {
            menu.classList.remove('show');
            opt.action();
        };
        menu.appendChild(item);
    });
}

async function shareScreenAdvanced(type) {
    if (isScreenSharing) {
        stopScreenShare();
        return;
    }
    
    try {
        let displayMediaOptions = {
            video: true,
            audio: false
        };
        
        // Для Chrome можно указать preferCurrentTab для вкладки
        if (type === 'tab' && 'mediaDevices' in navigator && 'getDisplayMedia' in navigator.mediaDevices) {
            displayMediaOptions.video = {
                displaySurface: 'browser'
            };
        }
        
        const screen = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
        const screenTrack = screen.getVideoTracks()[0];
        screenStream = screen;
        isScreenSharing = true;

        // Заменяем видео-дорожку во всех соединениях
        for (const id in peerConnections) {
            const sender = peerConnections[id].getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) await sender.replaceTrack(screenTrack);
        }

        // Локальный превью: экран + текущие аудио-дорожки
        const localVideo = document.getElementById('localVideo');
        if (localVideo) {
            const newStream = new MediaStream([screenTrack, ...(localStream ? localStream.getAudioTracks() : [])]);
            localVideo.srcObject = newStream;
        }

        setShareBtnState(true);

        // Если пользователь завершил шаринг через UI браузера — корректно откатываемся
        screenTrack.onended = () => {
            stopScreenShare();
        };
    } catch (e) {
        console.log('Демонстрация экрана отменена:', e);
        isScreenSharing = false;
        screenStream = null;
        setShareBtnState(false);
    }
}

async function switchDevice(deviceId, deviceType) {
    try {
        if (deviceType === 'mic') {
            selectedMicId = deviceId;
            // Переключаем микрофон
            const newStream = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                video: false
            });
            
            const newAudioTrack = newStream.getAudioTracks()[0];
            
            // Заменяем аудио трек в localStream
            const oldAudioTrack = localStream.getAudioTracks()[0];
            if (oldAudioTrack) {
                localStream.removeTrack(oldAudioTrack);
                oldAudioTrack.stop();
            }
            localStream.addTrack(newAudioTrack);
            
            // Обновляем все peer connections
            for (const id in peerConnections) {
                const sender = peerConnections[id].getSenders().find(s => s.track && s.track.kind === 'audio');
                if (sender) {
                    await sender.replaceTrack(newAudioTrack);
                }
            }
            
            console.log('Микрофон переключен на:', deviceId);
            
        } else if (deviceType === 'cam') {
            selectedCamId = deviceId;
            // Переключаем камеру
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: deviceId } },
                audio: false
            });
            
            const newVideoTrack = newStream.getVideoTracks()[0];
            
            // Заменяем видео трек в localStream
            const oldVideoTrack = localStream.getVideoTracks()[0];
            if (oldVideoTrack) {
                localStream.removeTrack(oldVideoTrack);
                oldVideoTrack.stop();
            }
            localStream.addTrack(newVideoTrack);
            
            // Обновляем localVideo
            const localVideo = document.getElementById('localVideo');
            if (localVideo) {
                localVideo.srcObject = localStream;
            }
            
            // Обновляем все peer connections
            for (const id in peerConnections) {
                const sender = peerConnections[id].getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    await sender.replaceTrack(newVideoTrack);
                }
            }
            
            console.log('Камера переключена на:', deviceId);
        }
        
        // Закрываем меню
        document.querySelectorAll('.device-menu').forEach(m => m.classList.remove('show'));
        
    } catch (error) {
        console.error('Ошибка переключения устройства:', error);
        alert('Не удалось переключить устройство');
    }
}

// ========== Системные сообщения и карточки звонков в чате ==========

function addSystemMessage(text) {
    console.log('addSystemMessage вызвана:', text);
    
    // Отправляем системное сообщение через Socket.IO для сохранения в БД
    if (currentRoomId) {
        console.log('Отправка системного сообщения через Socket.IO');
        socket.emit('system_message', {
            room_id: parseInt(currentRoomId),
            content: text,
            type: 'system'
        });
    } else {
        console.warn('currentRoomId не установлен, сообщение не отправлено');
    }
}

function addCallCard(callData) {
    console.log('addCallCard вызвана с данными:', callData);
    
    // Сохраняем карточку звонка в БД через Socket.IO
    if (currentRoomId && callData.status === 'active') {
        const isIncoming = callData.direction === 'incoming';
        const isVideo = callData.type !== 'audio';
        const content = `${isIncoming ? 'Входящий' : 'Исходящий'} ${isVideo ? 'видеозвонок' : 'аудиозвонок'}`;
        
        console.log('Отправка карточки звонка через Socket.IO:', {
            room_id: currentRoomId,
            content: content,
            type: 'call'
        });
        
        socket.emit('system_message', {
            room_id: parseInt(currentRoomId),
            content: content,
            type: 'call'
        });
    } else {
        console.warn('Карточка не отправлена. currentRoomId:', currentRoomId, 'status:', callData.status);
    }
}

// ========== НОВОЕ: Функции для кнопки звонка с выпадающим меню ==========

let activeGroupCallRoomId = null; // ID комнаты с активным групповым звонком
let groupCallParticipantsSet = new Set(); // Участники звонка

function showGroupCallInvite(inviterName, roomId) {
    const modal = document.getElementById('groupCallInviteModal');
    const inviterNameEl = document.getElementById('groupCallInviterName');
    const roomNameEl = document.getElementById('groupCallRoomName');
    
    if (inviterNameEl) inviterNameEl.textContent = inviterName;
    
    // Получаем название комнаты из сайдбара
    let roomName = '';
    const roomElement = document.querySelector(`.room-item[data-room-id="${roomId}"]`);
    if (roomElement && roomNameEl) {
        roomName = roomElement.getAttribute('data-room-name');
        roomNameEl.textContent = `начал звонок в «${roomName}»`;
    }
    
    activeGroupCallRoomId = roomId;
    
    if (modal) {
        modal.style.display = 'flex';
        playRingtone(); // Проигрываем рингтон
        
        // Показываем браузерное уведомление о групповом звонке
        showBrowserNotification('Групповой звонок', {
            body: inviterName + ' приглашает вас присоединиться' + (roomName ? ' в «' + roomName + '»' : ''),
            tag: 'group-call-' + roomId,
            requireInteraction: true
        });
    }
}

async function joinGroupCallFromInvite() {
    const modal = document.getElementById('groupCallInviteModal');
    if (modal) modal.style.display = 'none';
    
    stopRingtone();
    
    if (!activeGroupCallRoomId) {
        alert('Ошибка: ID комнаты не найден');
        return;
    }
    
    // Открываем окно звонка
    openCallModal();
    
    // Показываем индикатор
    showCallIndicator();
    updateCallIndicatorInfo('Групповой звонок', 'Подключение...');
    
    try {
        // Используем новую функцию с поддержкой аудио/видео
        await ensureLocalMediaWithMode();
        
        // Присоединяемся к звонку
        await joinGroupCall(activeGroupCallRoomId);
        
        // Уведомляем сервер о присоединении
        socket.emit('room_call_action', { 
            room_id: parseInt(activeGroupCallRoomId), 
            action: 'join',
            user_id: CURRENT_USER_ID
        });
    } catch (error) {
        console.error('Ошибка при присоединении к групповому звонку:', error);
        alert('Не удалось присоединиться к звонку. Проверьте доступ к камере/микрофону.');
        endCall();
    }
}

function declineGroupCall() {
    const modal = document.getElementById('groupCallInviteModal');
    if (modal) modal.style.display = 'none';
    
    stopRingtone();
    activeGroupCallRoomId = null;
}

// ========== Функции для приглашения участников в активный звонок ==========

function showInviteButton() {
    const inviteBtn = document.getElementById('inviteToCallBtn');
    if (inviteBtn) {
        inviteBtn.style.display = 'flex';
    }
}

function hideInviteButton() {
    const inviteBtn = document.getElementById('inviteToCallBtn');
    if (inviteBtn) {
        inviteBtn.style.display = 'none';
    }
}

async function openInviteToCallModal() {
    const modal = document.getElementById('inviteToCallModal');
    const selector = document.getElementById('inviteToCallMembersSelect');
    
    if (!activeGroupCallRoomId) {
        alert('Ошибка: нет активного группового звонка');
        return;
    }
    
    // Загружаем список участников комнаты
    try {
        const response = await fetch(`/api/room_members/${activeGroupCallRoomId}`);
        const data = await response.json();
        
        if (data.success && data.members) {
            selector.innerHTML = '';
            
            // Фильтруем: не показываем себя и тех кто уже в звонке
            const availableMembers = data.members.filter(m => 
                m.id !== CURRENT_USER_ID && !groupCallParticipantsSet.has(m.id)
            );
            
            if (availableMembers.length === 0) {
                selector.innerHTML = '<p class="empty-state small">Все участники уже в звонке или приглашены.</p>';
            } else {
                availableMembers.forEach(member => {
                    const div = document.createElement('div');
                    div.classList.add('contact-checkbox');
                    div.innerHTML = `
                        <input type="checkbox" id="invite-member-${member.id}" value="${member.id}">
                        <label for="invite-member-${member.id}">@${member.username}</label>
                    `;
                    selector.appendChild(div);
                });
            }
        }
    } catch (error) {
        console.error('Ошибка загрузки участников:', error);
        selector.innerHTML = '<p class="empty-state small">Не удалось загрузить список участников.</p>';
    }
    
    modal.style.display = 'flex';
}

function sendCallInvitations() {
    const selectedMembers = [];
    document.querySelectorAll('#inviteToCallMembersSelect input[type="checkbox"]:checked').forEach(checkbox => {
        selectedMembers.push(parseInt(checkbox.value));
    });
    
    if (selectedMembers.length === 0) {
        alert('Выберите хотя бы одного участника');
        return;
    }
    
    // Получаем имя текущего пользователя
    let senderName = 'Пользователь';
    const usernameEl = document.getElementById('current-username-display');
    if (usernameEl) {
        senderName = usernameEl.textContent.trim();
    }
    
    // Отправляем приглашения через Socket.IO
    selectedMembers.forEach(userId => {
        socket.emit('room_call_action', {
            room_id: parseInt(activeGroupCallRoomId),
            action: 'invite',
            target_user_id: userId,
            sender_name: senderName
        });
        
        // Добавляем в список приглашенных
        groupCallParticipantsSet.add(userId);
    });
    
    // Закрываем модальное окно
    closeModal({target: document.getElementById('inviteToCallModal'), forceClose: true});
    
    alert(`Приглашения отправлены (${selectedMembers.length})`);
}

// ========== Индикатор лобби звонка в чате ==========

function showCallLobbyIndicator(roomId) {
    // Показываем индикатор только если мы в этой комнате
    if (currentRoomId != roomId) return;
    
    // Проверяем, не создан ли уже индикатор
    let indicator = document.getElementById('call-lobby-indicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'call-lobby-indicator';
        indicator.className = 'active-call-indicator';
        indicator.style.background = 'linear-gradient(135deg, #007AFF 0%, #0051D5 100%)';
        indicator.innerHTML = `
            <div class="call-indicator-left">
                <div class="call-indicator-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="white" stroke="white" stroke-width="2">
                        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
                    </svg>
                </div>
                <div class="call-indicator-info">
                    <h4>Идет звонок в группе</h4>
                    <p>Нажмите, чтобы присоединиться</p>
                </div>
            </div>
            <div class="call-indicator-actions">
                <button class="call-indicator-btn" onclick="event.stopPropagation(); joinGroupCallFromLobby();">Присоединиться</button>
            </div>
        `;
        indicator.onclick = (e) => {
            if (e.target.tagName !== 'BUTTON') {
                joinGroupCallFromLobby();
            }
        };
        
        chatWindow.insertBefore(indicator, chatWindow.firstChild);
    }
    
    indicator.style.display = 'flex';
}

function hideCallLobbyIndicator() {
    const indicator = document.getElementById('call-lobby-indicator');
    if (indicator) {
        indicator.remove();
    }
}

async function joinGroupCallFromLobby() {
    if (!currentRoomId) return;
    
    // Скрываем индикатор лобби
    hideCallLobbyIndicator();
    
    // Открываем окно звонка
    openCallModal();
    
    // Показываем индикатор активного звонка
    showCallIndicator();
    updateCallIndicatorInfo('Групповой звонок', 'Подключение...');
    
    try {
        // Используем новую функцию с поддержкой аудио/видео
        await ensureLocalMediaWithMode();
        
        // Присоединяемся к звонку
        await joinGroupCall(currentRoomId);
        
        // Уведомляем сервер о присоединении
        socket.emit('room_call_action', { 
            room_id: parseInt(currentRoomId), 
            action: 'join',
            user_id: CURRENT_USER_ID
        });
    } catch (error) {
        console.error('Ошибка при присоединении к групповому звонку:', error);
        alert('Не удалось присоединиться к звонку. Проверьте доступ к камере/микрофону.');
        endCall();
    }
}

// Ensure functions used by inline HTML are accessible globally
try {
    if (typeof window !== 'undefined') {
        if (typeof selectRoom === 'function') window.selectRoom = selectRoom;
        if (typeof closeReactionPicker === 'function') window.closeReactionPicker = closeReactionPicker;
    }
} catch (e) {
    // no-op
}
