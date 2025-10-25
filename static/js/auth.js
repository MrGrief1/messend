// --- Управление состоянием форм входа/регистрации ---
function switchAuthView(nextView) {
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const messageBox = document.getElementById('message-box');
    const authCard = document.querySelector('.auth-card');
    const loginTab = document.querySelector('[data-form-target="login"]');
    const registerTab = document.querySelector('[data-form-target="register"]');

    const view = nextView === 'register' ? 'register' : 'login';

    if (authCard) {
        authCard.setAttribute('data-active', view);
    }

    if (loginForm) {
        loginForm.classList.toggle('is-hidden', view !== 'login');
        loginForm.toggleAttribute('hidden', view !== 'login');
    }

    if (registerForm) {
        registerForm.classList.toggle('is-hidden', view !== 'register');
        registerForm.toggleAttribute('hidden', view !== 'register');
    }

    if (loginTab) {
        loginTab.classList.toggle('is-active', view === 'login');
        loginTab.setAttribute('aria-selected', view === 'login');
    }

    if (registerTab) {
        registerTab.classList.toggle('is-active', view === 'register');
        registerTab.setAttribute('aria-selected', view === 'register');
    }

    if (messageBox) {
        messageBox.textContent = '';
        messageBox.className = 'auth-alert';
        messageBox.setAttribute('hidden', '');
    }
}

// Отображение сообщений пользователю
function showMessage(message, type) {
    const messageBox = document.getElementById('message-box');
    if (!messageBox) return;

    messageBox.textContent = message;
    messageBox.className = 'auth-alert';

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
            // Автоматический вход после успешной регистрации
            document.getElementById('login-identifier').value = username;
            document.getElementById('login-password').value = password;
            switchAuthView('login');
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
    if (!modal) return;

    modal.removeAttribute('hidden');

    const emailField = document.getElementById('forgot-email');
    if (emailField) {
        emailField.value = '';
        try {
            emailField.focus({ preventScroll: true });
        } catch (focusError) {
            emailField.focus();
        }
    }

    const feedback = document.getElementById('forgot-message');
    if (feedback) {
        feedback.textContent = '';
    }
}

function closeForgotPassword() {
    const modal = document.getElementById('forgot-password-modal');
    if (!modal) return;
    modal.setAttribute('hidden', '');
}

async function handleForgotPassword() {
    const email = document.getElementById('forgot-email').value;
    const messageDiv = document.getElementById('forgot-message');
    
    if (!email) {
        messageDiv.innerHTML = '<p style="color: #ff4444;">Введите email</p>';
        return;
    }
    
    try {
        const response = await fetch('/api/forgot_password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        
        const data = await response.json();
        
        if (data.success) {
            messageDiv.innerHTML = `<p style="color: #34C759;">${data.message}<br><small style="opacity: 0.8;">Проверьте почту через несколько минут</small></p>`;
            setTimeout(() => {
                closeForgotPassword();
            }, 5000);
        } else {
            messageDiv.innerHTML = `<p style="color: #ff4444;">${data.message}</p>`;
        }
    } catch (error) {
        messageDiv.innerHTML = '<p style="color: #ff4444;">Ошибка соединения с сервером</p>';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const tabButtons = document.querySelectorAll('[data-form-target]');
    tabButtons.forEach((button) => {
        button.addEventListener('click', (event) => {
            event.preventDefault();
            const target = button.getAttribute('data-form-target');
            switchAuthView(target);
        });
    });

    const inlineToggle = document.querySelectorAll('[data-inline-toggle]');
    inlineToggle.forEach((trigger) => {
        trigger.addEventListener('click', (event) => {
            event.preventDefault();
            const target = trigger.getAttribute('data-inline-toggle');
            switchAuthView(target);
        });
    });

    // Обеспечиваем корректный начальный вид
    const initialView = document.body && document.body.dataset ? document.body.dataset.authView : null;
    switchAuthView(initialView || 'login');
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        const modal = document.getElementById('forgot-password-modal');
        if (modal && !modal.hasAttribute('hidden')) {
            closeForgotPassword();
        }
    }
});
