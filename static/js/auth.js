const AUTH_STATE = {
    activeTab: 'login',
};

const PASSWORD_STRENGTH_LABELS = ['Введите пароль', 'Слабый пароль', 'Можно лучше', 'Хорошая защита', 'Отличный выбор'];

function switchAuthTab(target) {
    const normalized = target === 'register' ? 'register' : 'login';
    AUTH_STATE.activeTab = normalized;

    const tabs = document.querySelectorAll('[data-auth-tab]');
    tabs.forEach((tab) => {
        const isActive = tab.dataset.authTab === normalized;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
    });

    const panels = document.querySelectorAll('[data-auth-panel]');
    panels.forEach((panel) => {
        const shouldShow = panel.dataset.authPanel === normalized;
        panel.classList.toggle('active', shouldShow);
        panel.toggleAttribute('hidden', !shouldShow);
    });

    const messageBox = document.getElementById('message-box');
    if (messageBox) {
        messageBox.style.display = 'none';
        messageBox.className = '';
    }
}

function toggleForms() {
    const nextTab = AUTH_STATE.activeTab === 'login' ? 'register' : 'login';
    switchAuthTab(nextTab);
}

function showMessage(message, type = 'info') {
    const messageBox = document.getElementById('message-box');
    if (!messageBox) return;

    messageBox.textContent = message;
    messageBox.className = '';
    if (type === 'error') {
        messageBox.classList.add('message-error');
    } else if (type === 'success') {
        messageBox.classList.add('message-success');
    } else {
        messageBox.classList.add('message-info');
    }
    messageBox.style.display = 'block';
}

async function handleRegister() {
    const username = document.getElementById('register-username').value.trim();
    const email = document.getElementById('register-email').value.trim();
    const password = document.getElementById('register-password').value;
    const privacyAccepted = document.getElementById('privacy-confirm').checked;

    if (!validateRegistrationInputs({ username, email, password, privacyAccepted })) {
        showMessage('Проверьте правильность данных и примите условия.', 'error');
        return;
    }

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
            showMessage(data.message || 'Регистрация успешно завершена.', 'success');
            document.getElementById('login-identifier').value = username;
            document.getElementById('login-password').value = password;
            setTimeout(handleLogin, 1500);
        } else {
            showMessage(data.message || 'Не удалось создать аккаунт.', 'error');
        }
    } catch (error) {
        console.error('Ошибка регистрации', error);
        showMessage('Ошибка сети или сервера. Попробуйте позже.', 'error');
    }
}

async function handleLogin() {
    const identifier = document.getElementById('login-identifier').value.trim();
    const password = document.getElementById('login-password').value;

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
            showMessage(data.message || 'Неверный логин или пароль.', 'error');
        }
    } catch (error) {
        console.error('Ошибка входа', error);
        showMessage('Ошибка сети или сервера. Попробуйте позже.', 'error');
    }
}

function showForgotPassword() {
    const modal = document.getElementById('forgot-password-modal');
    if (!modal) return;
    modal.removeAttribute('hidden');
    modal.style.display = 'flex';
    document.getElementById('forgot-email').value = '';
    document.getElementById('forgot-message').innerHTML = '';
}

function closeForgotPassword() {
    const modal = document.getElementById('forgot-password-modal');
    if (!modal) return;
    modal.style.display = 'none';
    modal.setAttribute('hidden', '');
}

async function handleForgotPassword() {
    const emailInput = document.getElementById('forgot-email');
    const messageDiv = document.getElementById('forgot-message');

    if (!emailInput || !messageDiv) return;

    const email = emailInput.value.trim();
    if (!email) {
        messageDiv.innerHTML = '<p style="color: #ff4444;">Введите email</p>';
        return;
    }

    try {
        const response = await fetch('/api/forgot_password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
        });

        const data = await response.json();

        if (data.success) {
            messageDiv.innerHTML = `<p style="color: #34C759;">${data.message || 'Ссылка отправлена.'}<br><small style="opacity: 0.8;">Проверьте почту через несколько минут</small></p>`;
            setTimeout(() => {
                closeForgotPassword();
            }, 5000);
        } else {
            messageDiv.innerHTML = `<p style="color: #ff4444;">${data.message || 'Не удалось отправить письмо.'}</p>`;
        }
    } catch (error) {
        console.error('Ошибка восстановления пароля', error);
        messageDiv.innerHTML = '<p style="color: #ff4444;">Ошибка соединения с сервером</p>';
    }
}

function setupAuthTabs() {
    document.querySelectorAll('[data-auth-tab]').forEach((tab) => {
        tab.addEventListener('click', () => switchAuthTab(tab.dataset.authTab));
    });

    document.querySelectorAll('[data-switch]').forEach((btn) => {
        btn.addEventListener('click', () => switchAuthTab(btn.dataset.switch));
    });
}

function setupPasswordToggles() {
    document.querySelectorAll('[data-toggle-password]').forEach((toggle) => {
        toggle.addEventListener('click', () => {
            const targetId = toggle.getAttribute('data-toggle-password');
            const input = document.getElementById(targetId);
            if (!input) return;
            const isHidden = input.type === 'password';
            input.type = isHidden ? 'text' : 'password';
            const icon = toggle.querySelector('.material-icons-round');
            if (icon) {
                icon.textContent = isHidden ? 'visibility_off' : 'visibility';
            }
            toggle.setAttribute('aria-label', isHidden ? 'Скрыть пароль' : 'Показать пароль');
        });
    });
}

function setupRegisterValidation() {
    const usernameInput = document.getElementById('register-username');
    const emailInput = document.getElementById('register-email');
    const passwordInput = document.getElementById('register-password');
    const privacyCheckbox = document.getElementById('privacy-confirm');

    if (!usernameInput || !emailInput || !passwordInput || !privacyCheckbox) {
        return;
    }

    const passwordStrengthContainer = document.querySelector('.password-strength');
    const strengthLabel = document.getElementById('password-strength-label');

    const updateState = () => {
        const username = usernameInput.value.trim();
        const email = emailInput.value.trim();
        const password = passwordInput.value;
        const privacyAccepted = privacyCheckbox.checked;
        const result = evaluatePasswordStrength(password);

        if (passwordStrengthContainer) {
            passwordStrengthContainer.dataset.strength = String(result.score);
        }
        if (strengthLabel) {
            strengthLabel.textContent = PASSWORD_STRENGTH_LABELS[result.score] || PASSWORD_STRENGTH_LABELS[0];
        }

        updateHintState('username-hint', validateUsername(username), username.length > 0);
        updateHintState('email-hint', validateEmail(email), email.length > 0);

        const submitBtn = document.getElementById('register-submit');
        if (submitBtn) {
            const isValid =
                validateUsername(username) &&
                validateEmail(email) &&
                result.score >= 2 &&
                privacyAccepted;
            submitBtn.disabled = !isValid;
        }
    };

    usernameInput.addEventListener('input', updateState);
    emailInput.addEventListener('input', updateState);
    passwordInput.addEventListener('input', updateState);
    privacyCheckbox.addEventListener('change', updateState);

    updateState();
}

function setupThemeToggle() {
    const themeToggle = document.getElementById('auth-theme-toggle');
    if (!themeToggle) return;

    const icon = themeToggle.querySelector('.material-icons-round');

    const applyIcon = () => {
        const theme = document.body.getAttribute('data-theme') || 'dark';
        if (icon) {
            icon.textContent = theme === 'light' ? 'light_mode' : theme === 'amoled' ? 'brightness_3' : 'dark_mode';
        }
    };

    const availableThemes = ['dark', 'light', 'amoled'];

    themeToggle.addEventListener('click', () => {
        const current = document.body.getAttribute('data-theme') || 'dark';
        const currentIndex = availableThemes.indexOf(current);
        const nextTheme = availableThemes[(currentIndex + 1) % availableThemes.length];
        document.body.setAttribute('data-theme', nextTheme);
        try {
            localStorage.setItem('appTheme', nextTheme);
        } catch (error) {
            console.warn('Не удалось сохранить тему', error);
        }
        applyIcon();
    });

    applyIcon();
}

function setupDemoButton() {
    const demoButton = document.getElementById('demo-mode');
    if (!demoButton) return;

    demoButton.addEventListener('click', () => {
        showMessage('Демо-режим пока в разработке. Подключитесь к Matrix-серверу для теста.', 'info');
    });
}

function setupForgotPasswordOverlay() {
    const modal = document.getElementById('forgot-password-modal');
    if (!modal) return;

    modal.addEventListener('click', (event) => {
        if (event.target === modal) {
            closeForgotPassword();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && modal.style.display === 'flex') {
            closeForgotPassword();
        }
    });
}

function setupRememberMe() {
    const checkbox = document.getElementById('remember-me');
    if (!checkbox) return;

    try {
        const stored = localStorage.getItem('authRememberMe');
        if (stored === 'true') {
            checkbox.checked = true;
        }
    } catch (error) {
        console.warn('Не удалось получить remember me', error);
    }

    checkbox.addEventListener('change', () => {
        try {
            localStorage.setItem('authRememberMe', checkbox.checked ? 'true' : 'false');
        } catch (error) {
            console.warn('Не удалось сохранить remember me', error);
        }
    });
}

function setupAuthPage() {
    setupAuthTabs();
    setupPasswordToggles();
    setupRegisterValidation();
    setupThemeToggle();
    setupDemoButton();
    setupForgotPasswordOverlay();
    setupRememberMe();
    switchAuthTab(AUTH_STATE.activeTab);
}

document.addEventListener('DOMContentLoaded', setupAuthPage);

function validateUsername(value) {
    if (!value) return false;
    return /^[a-zA-Z0-9_]{3,32}$/.test(value);
}

function validateEmail(value) {
    if (!value) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateRegistrationInputs({ username, email, password, privacyAccepted }) {
    const passwordResult = evaluatePasswordStrength(password);
    return (
        validateUsername(username) &&
        validateEmail(email) &&
        passwordResult.score >= 2 &&
        privacyAccepted
    );
}

function evaluatePasswordStrength(password) {
    if (!password) {
        return { score: 0 };
    }

    let score = 0;
    if (password.length >= 8) score += 1;
    if (/[A-ZА-Я]/.test(password) && /[a-zа-я]/.test(password)) score += 1;
    if (/\d/.test(password)) score += 1;
    if (/[^\w\s]/.test(password)) score += 1;
    score = Math.min(score, 4);

    return { score };
}

function updateHintState(id, isValid, shouldShow = true) {
    const hint = document.getElementById(id);
    if (!hint) return;
    hint.classList.remove('valid', 'error');
    if (!hint.textContent || !shouldShow) return;
    hint.classList.add(isValid ? 'valid' : 'error');
}

// Экспорт функций в глобальную область, чтобы на них могли ссылаться обработчики в шаблоне
window.handleRegister = handleRegister;
window.handleLogin = handleLogin;
window.toggleForms = toggleForms;
window.showForgotPassword = showForgotPassword;
window.closeForgotPassword = closeForgotPassword;
window.handleForgotPassword = handleForgotPassword;
