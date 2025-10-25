const forms = {
    login: document.getElementById('login-form'),
    register: document.getElementById('register-form'),
};
const tabs = Array.from(document.querySelectorAll('.auth-tab'));
const messageBox = document.getElementById('message-box');
const modal = document.getElementById('forgot-password-modal');
const modalClose = document.getElementById('forgot-close');
const modalSubmit = document.getElementById('forgot-submit');
const modalMessage = document.getElementById('forgot-message');
const forgotEmailInput = document.getElementById('forgot-email');
const loginSubmit = document.getElementById('login-submit');
const registerSubmit = document.getElementById('register-submit');
const loginForgot = document.getElementById('login-forgot');
const usernameInput = document.getElementById('register-username');
const usernamePreview = document.getElementById('username-preview');
const passwordInput = document.getElementById('register-password');
const passwordMeter = document.getElementById('password-strength');
const passwordHint = document.getElementById('password-hint');
const themeToggle = document.getElementById('auth-theme-toggle');

function setActiveForm(target) {
    Object.entries(forms).forEach(([name, form]) => {
        const isActive = name === target;
        form.classList.toggle('auth-form--active', isActive);
        if (isActive) {
            form.removeAttribute('aria-hidden');
        } else {
            form.setAttribute('aria-hidden', 'true');
        }
    });

    tabs.forEach((tab) => {
        const isActive = tab.dataset.target === target;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    resetFeedback();
}

function resetFeedback() {
    if (!messageBox) return;
    messageBox.textContent = '';
    messageBox.className = 'auth-feedback';
    messageBox.setAttribute('hidden', '');
}

function showMessage(message, type) {
    if (!messageBox) return;
    messageBox.textContent = message;
    messageBox.className = `auth-feedback auth-feedback--${type}`;
    messageBox.removeAttribute('hidden');
}

async function handleRegister() {
    const username = usernameInput.value.trim();
    const email = document.getElementById('register-email').value.trim();
    const password = passwordInput.value;

    if (!username || !email || !password) {
        showMessage('Пожалуйста, заполните все поля для регистрации.', 'error');
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
            showMessage(data.message, 'success');
            document.getElementById('login-identifier').value = username;
            document.getElementById('login-password').value = password;
            setTimeout(handleLogin, 1400);
        } else {
            showMessage(data.message, 'error');
        }
    } catch (error) {
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
            showMessage(data.message, 'error');
        }
    } catch (error) {
        showMessage('Ошибка сети или сервера. Попробуйте позже.', 'error');
    }
}

function openForgotPassword() {
    if (!modal) return;
    modal.hidden = false;
    modal.classList.add('auth-modal--visible');
    forgotEmailInput.value = '';
    modalMessage.textContent = '';
    modalMessage.className = 'auth-feedback';
    modalMessage.setAttribute('hidden', '');
}

function closeForgotPassword() {
    if (!modal) return;
    modal.classList.remove('auth-modal--visible');
    setTimeout(() => {
        modal.hidden = true;
    }, 200);
}

async function handleForgotPassword() {
    const email = forgotEmailInput.value.trim();
    if (!email) {
        modalMessage.textContent = 'Введите email';
        modalMessage.className = 'auth-feedback auth-feedback--error';
        modalMessage.removeAttribute('hidden');
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
            modalMessage.innerHTML = `${data.message}<br><small style="opacity:0.8;">Проверьте почту через несколько минут</small>`;
            modalMessage.className = 'auth-feedback auth-feedback--success';
            modalMessage.removeAttribute('hidden');
            setTimeout(closeForgotPassword, 4800);
        } else {
            modalMessage.textContent = data.message;
            modalMessage.className = 'auth-feedback auth-feedback--error';
            modalMessage.removeAttribute('hidden');
        }
    } catch (error) {
        modalMessage.textContent = 'Ошибка соединения с сервером';
        modalMessage.className = 'auth-feedback auth-feedback--error';
        modalMessage.removeAttribute('hidden');
    }
}

function updateUsernamePreview() {
    if (!usernamePreview) return;
    const rawValue = usernameInput.value.trim();
    const sanitized = rawValue.replace(/[^a-zA-Z0-9_\.\-]/g, '').toLowerCase();
    if (rawValue !== sanitized) {
        usernameInput.value = sanitized;
    }

    if (!sanitized) {
        usernamePreview.textContent = 'Ваш адрес будет @username';
        return;
    }

    usernamePreview.textContent = `Ваш адрес будет @${sanitized}`;
}

function evaluatePasswordStrength(value) {
    let score = 0;
    if (value.length >= 8) score += 1;
    if (/[A-ZА-Я]/.test(value)) score += 1;
    if (/[0-9]/.test(value)) score += 1;
    if (/[^\w\s]/.test(value)) score += 1;
    return score;
}

function updatePasswordStrength() {
    const value = passwordInput.value;
    const strength = evaluatePasswordStrength(value);
    passwordMeter.value = strength;

    const hints = [
        'Добавьте минимум 8 символов',
        'Добавьте заглавные буквы',
        'Добавьте цифры',
        'Добавьте спецсимволы для максимальной защиты',
    ];

    if (!value) {
        passwordHint.textContent = 'Добавьте цифры и символы для надежности';
        return;
    }

    const remainingHints = hints.slice(0, 4 - strength).join(' • ');
    passwordHint.textContent = remainingHints || 'Отлично! Пароль выглядит надежно.';
}

function cycleTheme() {
    if (!themeToggle) return;
    const themes = ['dark', 'amoled', 'ocean', 'light'];
    const current = document.body.getAttribute('data-theme') || 'dark';
    const nextIndex = (themes.indexOf(current) + 1) % themes.length;
    const nextTheme = themes[nextIndex];
    document.body.setAttribute('data-theme', nextTheme);
    try {
        localStorage.setItem('appTheme', nextTheme);
    } catch {}
    themeToggle.querySelector('.material-icons-round').textContent = nextTheme === 'light' ? 'light_mode' : 'bedtime';
}

function setupEventListeners() {
    tabs.forEach((tab) => {
        tab.addEventListener('click', () => setActiveForm(tab.dataset.target));
    });

    document.querySelectorAll('[data-switch]').forEach((button) => {
        button.addEventListener('click', (event) => {
            const target = event.currentTarget.getAttribute('data-switch');
            setActiveForm(target);
        });
    });

    loginSubmit?.addEventListener('click', handleLogin);
    registerSubmit?.addEventListener('click', handleRegister);

    forms.login?.addEventListener('submit', (event) => {
        event.preventDefault();
        handleLogin();
    });

    forms.register?.addEventListener('submit', (event) => {
        event.preventDefault();
        handleRegister();
    });

    loginForgot?.addEventListener('click', openForgotPassword);
    modalClose?.addEventListener('click', closeForgotPassword);
    modalSubmit?.addEventListener('click', handleForgotPassword);

    modal?.addEventListener('click', (event) => {
        if (event.target === modal) {
            closeForgotPassword();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !modal.hidden) {
            closeForgotPassword();
        }
    });

    usernameInput?.addEventListener('input', updateUsernamePreview);
    passwordInput?.addEventListener('input', updatePasswordStrength);

    themeToggle?.addEventListener('click', cycleTheme);
}

setupEventListeners();
updateUsernamePreview();
updatePasswordStrength();
