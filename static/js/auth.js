const SUBTITLES = {
    'login-form': 'Добро пожаловать обратно! Введите свой логин или email.',
    'register-form': 'Создайте аккаунт, настройте уведомления и подключайтесь к командам.'
};

function hideMessage() {
    const messageBox = document.getElementById('message-box');
    if (!messageBox) return;
    messageBox.classList.remove('is-visible', 'error', 'success');
    const text = messageBox.querySelector('.message-box__text');
    if (text) text.textContent = '';
    const icon = messageBox.querySelector('.message-box__icon');
    if (icon) icon.textContent = '';
}

function toggleForms(targetId) {
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    if (!loginForm || !registerForm) return;

    const fallback = loginForm.classList.contains('auth-form--active') ? registerForm.id : loginForm.id;
    const targetForm = document.getElementById(targetId || fallback);
    if (!targetForm) return;

    [loginForm, registerForm].forEach(form => {
        form.classList.toggle('auth-form--active', form === targetForm);
    });

    document.querySelectorAll('.auth-tab').forEach(tab => {
        const isActive = tab.dataset.target === targetForm.id;
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    document.querySelectorAll('[data-switch]').forEach(btn => {
        const disabled = btn.dataset.switch === targetForm.id;
        btn.toggleAttribute('aria-disabled', disabled);
    });

    const subtitle = document.getElementById('auth-subtitle');
    if (subtitle && SUBTITLES[targetForm.id]) {
        subtitle.textContent = SUBTITLES[targetForm.id];
    }

    hideMessage();

    const firstInput = targetForm.querySelector('input');
    if (firstInput) {
        firstInput.focus({ preventScroll: false });
    }
}

function showMessage(message, type) {
    const messageBox = document.getElementById('message-box');
    if (!messageBox) return;

    const icon = messageBox.querySelector('.message-box__icon');
    const text = messageBox.querySelector('.message-box__text');

    messageBox.classList.remove('error', 'success');
    if (type === 'error') {
        messageBox.classList.add('error');
        if (icon) icon.textContent = '⚠️';
    } else if (type === 'success') {
        messageBox.classList.add('success');
        if (icon) icon.textContent = '✅';
    } else if (icon) {
        icon.textContent = 'ℹ️';
    }

    if (text) text.textContent = message;
    messageBox.classList.add('is-visible');
}

function togglePasswordVisibility(button) {
    if (!button) return;
    const targetId = button.dataset.target;
    const input = targetId ? document.getElementById(targetId) : null;
    if (!input) return;

    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    button.textContent = isHidden ? 'Скрыть' : 'Показать';
    button.setAttribute('aria-pressed', isHidden ? 'true' : 'false');
}

function updatePasswordStrength(value) {
    const meter = document.getElementById('register-password-meter');
    if (!meter) return;
    const label = meter.querySelector('.password-meter__label');

    let score = 0;
    if (value.length >= 8) score++;
    if (/[A-Z]/.test(value) && /[a-z]/.test(value)) score++;
    if (/\d/.test(value)) score++;
    if (/[^A-Za-z0-9]/.test(value)) score++;
    if (value.length >= 12) score++;

    let strength = 'weak';
    let labelText = 'Слабый пароль';

    if (!value) {
        score = 0;
    } else if (score >= 4) {
        strength = 'strong';
        labelText = 'Надёжный пароль';
    } else if (score >= 2) {
        strength = 'medium';
        labelText = 'Хороший пароль';
    }

    meter.dataset.strength = strength;
    if (label) label.textContent = labelText;
}

// Обработка Регистрации
async function handleRegister() {
    const usernameInput = document.getElementById('register-username');
    const emailInput = document.getElementById('register-email');
    const passwordInput = document.getElementById('register-password');
    const displayNameInput = document.getElementById('register-display-name');
    const notificationsToggle = document.getElementById('privacy-optin');

    let username = usernameInput.value.trim().toLowerCase();
    if (username.startsWith('@')) {
        username = username.slice(1);
    }
    usernameInput.value = username;

    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const displayName = displayNameInput ? displayNameInput.value.trim() : '';
    const securityOptIn = notificationsToggle ? notificationsToggle.checked : false;

    if (!username || !email || !password) {
        showMessage('Пожалуйста, заполните все обязательные поля.', 'error');
        return;
    }

    const payload = { username, email, password };
    if (displayName) payload.display_name = displayName;
    payload.security_opt_in = securityOptIn;

    try {
        const response = await fetch('/api/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (data.success) {
            showMessage(data.message, 'success');
            document.getElementById('login-identifier').value = username;
            document.getElementById('login-password').value = password;
            if (displayName) {
                try {
                    localStorage.setItem('profileDisplayNameDraft', displayName);
                } catch (error) {
                    console.warn('Не удалось сохранить локальные данные профиля', error);
                }
            }
            setTimeout(() => {
                toggleForms('login-form');
                handleLogin();
            }, 1300);
        } else {
            showMessage(data.message, 'error');
        }
    } catch (error) {
        showMessage('Ошибка сети или сервера. Попробуйте позже.', 'error');
    }
}

// Обработка Входа
async function handleLogin() {
    const identifierInput = document.getElementById('login-identifier');
    const passwordInput = document.getElementById('login-password');

    const identifier = identifierInput.value.trim();
    const password = passwordInput.value;

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
    modal.classList.add('is-visible');
    const emailInput = document.getElementById('forgot-email');
    if (emailInput) {
        emailInput.value = '';
        emailInput.focus();
    }
    const message = document.getElementById('forgot-message');
    if (message) message.innerHTML = '';
}

function closeForgotPassword() {
    const modal = document.getElementById('forgot-password-modal');
    if (modal) {
        modal.classList.remove('is-visible');
    }
}

async function handleForgotPassword() {
    const email = document.getElementById('forgot-email').value.trim();
    const messageDiv = document.getElementById('forgot-message');

    if (!email) {
        if (messageDiv) {
            messageDiv.innerHTML = '<p style="color: #ff4444;">Введите email</p>';
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

        if (messageDiv) {
            if (data.success) {
                messageDiv.innerHTML = `<p style="color: #34C759;">${data.message}<br><small style="opacity: 0.8;">Проверьте почту через несколько минут</small></p>`;
                setTimeout(() => {
                    closeForgotPassword();
                }, 5000);
            } else {
                messageDiv.innerHTML = `<p style="color: #ff4444;">${data.message}</p>`;
            }
        }
    } catch (error) {
        if (messageDiv) {
            messageDiv.innerHTML = '<p style="color: #ff4444;">Ошибка соединения с сервером</p>';
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.auth-tab').forEach(tab => {
        tab.addEventListener('click', () => toggleForms(tab.dataset.target));
    });

    document.querySelectorAll('[data-switch]').forEach(btn => {
        btn.addEventListener('click', () => toggleForms(btn.dataset.switch));
    });

    document.querySelectorAll('[data-action="forgot"]').forEach(btn => {
        btn.addEventListener('click', showForgotPassword);
    });

    document.querySelectorAll('[data-action="close-forgot"]').forEach(btn => {
        btn.addEventListener('click', closeForgotPassword);
    });

    document.querySelectorAll('[data-toggle="password"]').forEach(btn => {
        btn.addEventListener('click', () => togglePasswordVisibility(btn));
    });

    const registerPassword = document.getElementById('register-password');
    if (registerPassword) {
        updatePasswordStrength(registerPassword.value);
        registerPassword.addEventListener('input', (event) => {
            updatePasswordStrength(event.target.value);
        });
    }

    const meter = document.getElementById('register-password-meter');
    if (meter && !meter.dataset.strength) {
        meter.dataset.strength = 'weak';
    }
});
