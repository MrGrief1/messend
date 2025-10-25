// Переключение между формами входа и регистрации
function updateRegisterProgress() {
    const steps = document.querySelectorAll('.register-progress .progress-dot');
    if (!steps.length) return;

    const username = document.getElementById('register-username');
    const email = document.getElementById('register-email');
    const password = document.getElementById('register-password');

    let filled = 0;
    if (username && username.value.trim().length >= 3) filled += 1;
    if (email && /@/.test(email.value)) filled += 1;
    if (password && password.value.trim().length >= 8) filled += 1;

    steps.forEach((dot, index) => {
        dot.classList.toggle('is-active', index < Math.max(1, filled));
    });
}

function switchAuthTab(tab) {
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const messageBox = document.getElementById('message-box');
    const tabs = document.querySelectorAll('[data-auth-tab]');

    const isLogin = tab !== 'register';

    if (loginForm && registerForm) {
        loginForm.classList.toggle('is-active', isLogin);
        registerForm.classList.toggle('is-active', !isLogin);
        loginForm.setAttribute('aria-hidden', (!isLogin).toString());
        registerForm.setAttribute('aria-hidden', isLogin.toString());
    }

    tabs.forEach((button) => {
        const target = button.getAttribute('data-auth-tab');
        const isActive = target === (isLogin ? 'login' : 'register');
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-selected', isActive.toString());
    });

    if (messageBox) {
        messageBox.textContent = '';
        messageBox.classList.remove('is-visible', 'is-error', 'is-success');
    }

    if (!isLogin) {
        updateRegisterProgress();
    }
}

function toggleForms() {
    const loginForm = document.getElementById('login-form');
    const targetTab = loginForm && loginForm.classList.contains('is-active') ? 'register' : 'login';
    switchAuthTab(targetTab);
}

// Отображение сообщений пользователю
function showMessage(message, type) {
    const messageBox = document.getElementById('message-box');
    if (!messageBox) return;

    messageBox.textContent = message;
    messageBox.classList.remove('is-error', 'is-success');

    if (type === 'error') {
        messageBox.classList.add('is-error');
    } else if (type === 'success') {
        messageBox.classList.add('is-success');
    }

    messageBox.classList.add('is-visible');
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
    modal.style.display = 'flex';
    document.getElementById('forgot-email').value = '';
    document.getElementById('forgot-message').innerHTML = '';
}

function closeForgotPassword() {
    const modal = document.getElementById('forgot-password-modal');
    modal.style.display = 'none';
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
    const activeTabButton = document.querySelector('.auth-tab.is-active');
    const initialTab = activeTabButton ? activeTabButton.getAttribute('data-auth-tab') : 'login';
    switchAuthTab(initialTab || 'login');

    ['register-username', 'register-email', 'register-password'].forEach((id) => {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('input', updateRegisterProgress);
        }
    });

    updateRegisterProgress();
});