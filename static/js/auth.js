// Переключение между формами входа и регистрации
function toggleForms(mode) {
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const messageBox = document.getElementById('message-box');
    const switcherButtons = document.querySelectorAll('.auth-switcher button');

    let showLogin;
    if (mode === 'login') {
        showLogin = true;
    } else if (mode === 'register') {
        showLogin = false;
    } else {
        showLogin = loginForm.style.display === 'none';
    }

    loginForm.style.display = showLogin ? 'block' : 'none';
    registerForm.style.display = showLogin ? 'none' : 'block';

    switcherButtons.forEach((btn) => {
        const target = btn.getAttribute('data-mode');
        if (!target) return;
        if ((showLogin && target === 'login') || (!showLogin && target === 'register')) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    messageBox.style.display = 'none';
}

// Отображение сообщений пользователю
function showMessage(message, type) {
    const messageBox = document.getElementById('message-box');
    messageBox.textContent = message;
    messageBox.className = ''; // Очищаем предыдущие классы
    if (type === 'error') {
        messageBox.classList.add('message-error');
    } else if (type === 'success') {
        messageBox.classList.add('message-success');
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