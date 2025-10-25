// Переключение между формами входа и регистрации
function toggleForms(target) {
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const messageBox = document.getElementById('message-box');
    const tabs = document.querySelectorAll('[data-auth-tab]');

    const showLogin = target ? target === 'login' : loginForm.style.display === 'none';
    loginForm.style.display = showLogin ? 'block' : 'none';
    registerForm.style.display = showLogin ? 'none' : 'block';

    tabs.forEach((tab) => {
        const tabTarget = tab.getAttribute('data-auth-tab');
        tab.classList.toggle('active', tabTarget === (showLogin ? 'login' : 'register'));
    });

    messageBox.style.display = 'none'; // Скрываем сообщения при переключении
    messageBox.className = 'message-box';
}

// Отображение сообщений пользователю
function showMessage(message, type) {
    const messageBox = document.getElementById('message-box');
    messageBox.textContent = message;
    messageBox.className = 'message-box';
    if (type === 'error') {
        messageBox.classList.add('error');
    } else if (type === 'success') {
        messageBox.classList.add('success');
    }
    messageBox.style.display = 'block';
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
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    document.getElementById('forgot-email').value = '';
    const forgotMessage = document.getElementById('forgot-message');
    if (forgotMessage) {
        forgotMessage.style.display = 'none';
        forgotMessage.className = 'message-box';
        forgotMessage.innerHTML = '';
    }
}

function closeForgotPassword() {
    const modal = document.getElementById('forgot-password-modal');
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
}

async function handleForgotPassword() {
    const email = document.getElementById('forgot-email').value;
    const messageDiv = document.getElementById('forgot-message');

    if (!email) {
        messageDiv.className = 'message-box error';
        messageDiv.textContent = 'Введите email';
        messageDiv.style.display = 'block';
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
            messageDiv.className = 'message-box success';
            messageDiv.innerHTML = `${data.message}<br><small style="opacity: 0.8;">Проверьте почту через несколько минут</small>`;
            messageDiv.style.display = 'block';
            setTimeout(() => {
                closeForgotPassword();
            }, 5000);
        } else {
            messageDiv.className = 'message-box error';
            messageDiv.textContent = data.message;
            messageDiv.style.display = 'block';
        }
    } catch (error) {
        messageDiv.className = 'message-box error';
        messageDiv.textContent = 'Ошибка соединения с сервером';
        messageDiv.style.display = 'block';
    }
}
