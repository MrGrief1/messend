// Переключение между формами входа и регистрации
function toggleForms(target) {
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const messageBox = document.getElementById('message-box');
    const tabs = document.querySelectorAll('.auth-tab');
    const formsContainer = document.querySelector('.auth-forms');

    let showRegister;

    if (target === 'register') {
        showRegister = true;
    } else if (target === 'login') {
        showRegister = false;
    } else {
        showRegister = !registerForm.classList.contains('is-active');
    }

    const activeKey = showRegister ? 'register' : 'login';

    loginForm.classList.toggle('is-active', activeKey === 'login');
    registerForm.classList.toggle('is-active', activeKey === 'register');
    loginForm.setAttribute('aria-hidden', activeKey === 'register');
    registerForm.setAttribute('aria-hidden', activeKey === 'login');

    if (formsContainer) {
        formsContainer.setAttribute('data-active', activeKey);
    }

    tabs.forEach((tab) => {
        const isActive = tab.dataset.target === activeKey;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
    });

    if (messageBox) {
        messageBox.textContent = '';
        messageBox.className = 'message-box';
        messageBox.setAttribute('hidden', '');
    }
}

// Отображение сообщений пользователю
function showMessage(message, type) {
    const messageBox = document.getElementById('message-box');
    if (!messageBox) return;

    messageBox.textContent = message;
    messageBox.className = 'message-box';

    if (type === 'error') {
        messageBox.classList.add('message-error');
    } else if (type === 'success') {
        messageBox.classList.add('message-success');
    }

    messageBox.removeAttribute('hidden');
}

// Обработка Регистрации
async function handleRegister() {
    const username = document.getElementById('register-username').value;
    const email = document.getElementById('register-email').value;
    const password = document.getElementById('register-password').value;

    try {
        const response = await fetch('/api/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ username, email, password }),
        });

        const data = await response.json();

        if (data.success) {
            showMessage(data.message, 'success');
            toggleForms('login');
            // Автоматический вход после успешной регистрации
            document.getElementById('login-identifier').value = username;
            document.getElementById('login-password').value = password;
            setTimeout(handleLogin, 1500);
        } else {
            showMessage(data.message, 'error');
        }
    } catch (error) {
        showMessage('Ошибка сети или сервера. Попробуйте позже.', 'error');
    }
}

// Обработка Входа
async function handleLogin() {
    const identifier = document.getElementById('login-identifier').value;
    const password = document.getElementById('login-password').value;

    // Простая валидация на стороне клиента
    if (!identifier || !password) {
        showMessage('Пожалуйста, введите логин и пароль.', 'error');
        return;
    }

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ identifier, password }),
        });

        const data = await response.json();

        if (data.success) {
            // Перенаправление на главную страницу при успехе
            window.location.href = '/';
        } else {
            showMessage(data.message, 'error');
        }
    } catch (error) {
        showMessage('Ошибка сети или сервера. Попробуйте позже.', 'error');
    }
}

// Восстановление пароля
function showForgotPassword() {
    const modal = document.getElementById('forgot-password-modal');
    const messageDiv = document.getElementById('forgot-message');

    if (modal) {
        modal.style.display = 'flex';
    }

    const emailField = document.getElementById('forgot-email');
    if (emailField) {
        emailField.value = '';
    }

    if (messageDiv) {
        messageDiv.className = 'message-box';
        messageDiv.textContent = '';
        messageDiv.setAttribute('hidden', '');
    }
}

function closeForgotPassword() {
    const modal = document.getElementById('forgot-password-modal');
    const messageDiv = document.getElementById('forgot-message');

    if (modal) {
        modal.style.display = 'none';
    }

    if (messageDiv) {
        messageDiv.className = 'message-box';
        messageDiv.textContent = '';
        messageDiv.setAttribute('hidden', '');
    }
}

async function handleForgotPassword() {
    const email = document.getElementById('forgot-email').value;
    const messageDiv = document.getElementById('forgot-message');

    if (!email) {
        if (messageDiv) {
            messageDiv.className = 'message-box message-error';
            messageDiv.textContent = 'Введите email';
            messageDiv.removeAttribute('hidden');
        }
        return;
    }

    try {
        const response = await fetch('/api/forgot_password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        
        const data = await response.json();
        
        if (!messageDiv) {
            return;
        }

        messageDiv.className = 'message-box';

        if (data.success) {
            messageDiv.classList.add('message-success');
            messageDiv.innerHTML = `${data.message}<br><small style="opacity:0.75;">Проверьте почту через несколько минут</small>`;
            messageDiv.removeAttribute('hidden');
            setTimeout(() => {
                closeForgotPassword();
            }, 5000);
        } else {
            messageDiv.classList.add('message-error');
            messageDiv.textContent = data.message;
            messageDiv.removeAttribute('hidden');
        }
    } catch (error) {
        if (messageDiv) {
            messageDiv.className = 'message-box message-error';
            messageDiv.textContent = 'Ошибка соединения с сервером';
            messageDiv.removeAttribute('hidden');
        }
    }
}