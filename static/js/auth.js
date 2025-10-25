const ACTIVE_CLASS = 'is-active';

function hexToRgba(hex, alpha = 1) {
    if (!hex) return `rgba(0, 0, 0, ${alpha})`;
    let sanitized = hex.replace('#', '');
    if (sanitized.length === 3) {
        sanitized = sanitized.split('').map((ch) => ch + ch).join('');
    }

    const value = parseInt(sanitized, 16);
    if (Number.isNaN(value)) {
        return `rgba(0, 0, 0, ${alpha})`;
    }

    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;

    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function switchForm(targetId) {
    const forms = document.querySelectorAll('.auth-form');
    const tabs = document.querySelectorAll('.auth-tab');

    forms.forEach((form) => {
        form.classList.toggle(ACTIVE_CLASS, form.id === targetId);
    });

    tabs.forEach((tab) => {
        const isActive = tab.dataset.target === targetId;
        tab.classList.toggle(ACTIVE_CLASS, isActive);
        tab.setAttribute('aria-selected', String(isActive));
    });

    const messageBox = document.getElementById('message-box');
    if (messageBox) {
        messageBox.className = 'auth-alert';
        messageBox.textContent = '';
    }
}

function toggleForms() {
    const loginForm = document.getElementById('login-form');
    const target = loginForm?.classList.contains(ACTIVE_CLASS) ? 'register-form' : 'login-form';
    switchForm(target);
}

function showMessage(message, type = 'info') {
    const messageBox = document.getElementById('message-box');
    if (!messageBox) return;

    messageBox.textContent = message;
    messageBox.className = 'auth-alert is-visible';

    if (type === 'error') {
        messageBox.classList.add('error');
    } else if (type === 'success') {
        messageBox.classList.add('success');
    } else {
        messageBox.classList.add('subtle');
    }
}

function setFormLoading(form, isLoading) {
    if (!form) return;
    const submitButton = form.querySelector('button[type="submit"]');
    if (!submitButton) return;

    if (isLoading) {
        if (!submitButton.dataset.originalText) {
            submitButton.dataset.originalText = submitButton.textContent;
        }
        submitButton.textContent = 'Подождите';
        submitButton.classList.add('is-loading');
        submitButton.setAttribute('disabled', 'disabled');
    } else {
        submitButton.classList.remove('is-loading');
        submitButton.removeAttribute('disabled');
        if (submitButton.dataset.originalText) {
            submitButton.textContent = submitButton.dataset.originalText;
            delete submitButton.dataset.originalText;
        }
    }
}

function evaluatePasswordStrength(password) {
    let score = 0;
    if (password.length >= 8) score += 1;
    if (password.length >= 12) score += 1;
    if (/[A-Z]/.test(password)) score += 1;
    if (/[0-9]/.test(password)) score += 1;
    if (/[^A-Za-z0-9]/.test(password)) score += 1;

    const normalized = Math.min(100, (score / 5) * 100);
    let label = 'Надёжность пароля';

    if (normalized >= 80) {
        label = 'Отличный пароль';
    } else if (normalized >= 60) {
        label = 'Хороший пароль';
    } else if (normalized >= 40) {
        label = 'Средний пароль';
    } else if (normalized > 0) {
        label = 'Слабый пароль';
    }

    return { percentage: normalized, label };
}

function updatePasswordStrength(password) {
    const strengthBlock = document.getElementById('password-strength');
    if (!strengthBlock) return;

    const bar = strengthBlock.querySelector('.password-strength__bar');
    const labelEl = strengthBlock.querySelector('.password-strength__label');

    if (!password) {
        strengthBlock.classList.remove('is-visible');
        strengthBlock.setAttribute('aria-hidden', 'true');
        if (bar) bar.style.setProperty('--strength', '0%');
        if (labelEl) labelEl.textContent = 'Надёжность пароля';
        return;
    }

    const { percentage, label } = evaluatePasswordStrength(password);

    strengthBlock.classList.add('is-visible');
    strengthBlock.setAttribute('aria-hidden', 'false');
    if (bar) bar.style.setProperty('--strength', `${percentage}%`);
    if (labelEl) labelEl.textContent = label;
}

async function handleRegister(event) {
    event?.preventDefault();

    const form = event?.target instanceof HTMLElement ? event.target : document.getElementById('register-form');
    const username = document.getElementById('register-username')?.value.trim();
    const email = document.getElementById('register-email')?.value.trim();
    const password = document.getElementById('register-password')?.value;
    const confirm = document.getElementById('register-confirm')?.value;
    const terms = document.getElementById('terms-agree');

    if (!username || !email || !password || !confirm) {
        showMessage('Пожалуйста, заполните все поля.', 'error');
        return;
    }

    if (username.startsWith('@')) {
        showMessage('Укажите имя пользователя без символа @ — он добавится автоматически.', 'error');
        return;
    }

    if (password.length < 8) {
        showMessage('Пароль должен содержать минимум 8 символов.', 'error');
        return;
    }

    if (password !== confirm) {
        showMessage('Пароли не совпадают. Проверьте правильность ввода.', 'error');
        return;
    }

    if (terms && !terms.checked) {
        showMessage('Для регистрации необходимо принять условия сервиса.', 'error');
        return;
    }

    try {
        setFormLoading(form, true);
        const response = await fetch('/api/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ username, email, password }),
        });

        const data = await response.json();

        if (data.success) {
            showMessage(data.message || 'Регистрация прошла успешно! Перенаправляем на вход.', 'success');
            document.getElementById('login-identifier').value = username;
            document.getElementById('login-password').value = password;
            setTimeout(() => switchForm('login-form'), 400);
            setTimeout(handleLogin, 1200);
        } else {
            showMessage(data.message || 'Не удалось зарегистрироваться. Попробуйте снова.', 'error');
        }
    } catch (error) {
        console.error('Register error', error);
        showMessage('Ошибка сети или сервера. Попробуйте позже.', 'error');
    } finally {
        setFormLoading(form, false);
    }
}

async function handleLogin(event) {
    event?.preventDefault();

    const form = event?.target instanceof HTMLElement ? event.target : document.getElementById('login-form');
    const identifier = document.getElementById('login-identifier')?.value.trim();
    const password = document.getElementById('login-password')?.value;

    if (!identifier || !password) {
        showMessage('Введите логин и пароль, чтобы продолжить.', 'error');
        return;
    }

    try {
        setFormLoading(form, true);
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ identifier, password }),
        });

        const data = await response.json();

        if (data.success) {
            showMessage('Добро пожаловать обратно! Сейчас перенаправим вас в приложение.', 'success');
            setTimeout(() => {
                window.location.href = '/';
            }, 600);
        } else {
            showMessage(data.message || 'Неверный логин или пароль.', 'error');
        }
    } catch (error) {
        console.error('Login error', error);
        showMessage('Ошибка сети или сервера. Попробуйте позже.', 'error');
    } finally {
        setFormLoading(form, false);
    }
}

function showForgotPassword() {
    const modal = document.getElementById('forgot-password-modal');
    if (!modal) return;
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    const emailField = document.getElementById('forgot-email');
    const message = document.getElementById('forgot-message');
    if (emailField) emailField.value = '';
    if (message) {
        message.className = 'auth-alert subtle';
        message.textContent = '';
    }
}

function closeForgotPassword() {
    const modal = document.getElementById('forgot-password-modal');
    if (!modal) return;
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
}

async function handleForgotPassword() {
    const email = document.getElementById('forgot-email')?.value.trim();
    const messageDiv = document.getElementById('forgot-message');

    if (!email) {
        if (messageDiv) {
            messageDiv.className = 'auth-alert error is-visible';
            messageDiv.textContent = 'Введите email, чтобы получить ссылку.';
        }
        return;
    }

    try {
        if (messageDiv) {
            messageDiv.className = 'auth-alert subtle is-visible';
            messageDiv.textContent = 'Отправляем письмо…';
        }

        const response = await fetch('/api/forgot_password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
        });

        const data = await response.json();

        if (data.success) {
            if (messageDiv) {
                messageDiv.className = 'auth-alert success is-visible';
                messageDiv.textContent = data.message || 'Письмо отправлено. Проверьте почту.';
            }
        } else {
            if (messageDiv) {
                messageDiv.className = 'auth-alert error is-visible';
                messageDiv.textContent = data.message || 'Не удалось отправить письмо. Попробуйте позже.';
            }
        }
    } catch (error) {
        console.error('Forgot password error', error);
        if (messageDiv) {
            messageDiv.className = 'auth-alert error is-visible';
            messageDiv.textContent = 'Ошибка соединения с сервером.';
        }
    }
}

function applyTheme(theme) {
    document.body.setAttribute('data-theme', theme);
    try {
        localStorage.setItem('appTheme', theme);
    } catch (error) {
        console.warn('Не удалось сохранить тему', error);
    }

    document.querySelectorAll('.theme-chip').forEach((chip) => {
        chip.classList.toggle('is-active', chip.dataset.themeTarget === theme);
    });
}

function applyAccent(color) {
    if (!color) return;
    document.documentElement.style.setProperty('--color-primary', color);
    document.documentElement.style.setProperty('--color-primary-hover', color);
    document.documentElement.style.setProperty('--msg-sent-bg', `linear-gradient(135deg, ${color}, ${hexToRgba(color, 0.35)})`);
    document.documentElement.style.setProperty('--thread-accent', hexToRgba(color, 0.22));
    try {
        localStorage.setItem('appAccent', color);
    } catch (error) {
        console.warn('Не удалось сохранить акцент', error);
    }

    document.querySelectorAll('.accent-chip').forEach((chip) => {
        chip.classList.toggle('is-active', chip.dataset.accent === color);
    });
}

function togglePasswordVisibility(button) {
    const targetId = button.dataset.passwordToggle;
    if (!targetId) return;
    const input = document.getElementById(targetId);
    if (!input) return;

    const isPassword = input.getAttribute('type') === 'password';
    input.setAttribute('type', isPassword ? 'text' : 'password');
    button.classList.toggle('is-active', !isPassword);
    button.setAttribute('aria-label', isPassword ? 'Скрыть пароль' : 'Показать пароль');
}

function initAuthPage() {
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');

    loginForm?.addEventListener('submit', handleLogin);
    registerForm?.addEventListener('submit', handleRegister);

    document.querySelectorAll('.auth-tab').forEach((tab) => {
        tab.addEventListener('click', () => switchForm(tab.dataset.target));
    });

    document.querySelectorAll('[data-switch-target]').forEach((trigger) => {
        trigger.addEventListener('click', () => switchForm(trigger.dataset.switchTarget));
    });

    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            const current = document.body.getAttribute('data-theme') || 'dark';
            const next = current === 'light' ? 'dark' : 'light';
            applyTheme(next);
        });
    }

    document.querySelectorAll('.theme-chip').forEach((chip) => {
        chip.addEventListener('click', () => applyTheme(chip.dataset.themeTarget));
    });

    document.querySelectorAll('.accent-chip').forEach((chip) => {
        chip.addEventListener('click', () => applyAccent(chip.dataset.accent));
    });

    document.querySelectorAll('.password-toggle').forEach((toggle) => {
        toggle.addEventListener('click', () => togglePasswordVisibility(toggle));
    });

    const registerPassword = document.getElementById('register-password');
    if (registerPassword) {
        registerPassword.addEventListener('input', (event) => {
            updatePasswordStrength(event.target.value);
        });
    }

    const forgotLink = document.getElementById('forgot-password-link');
    forgotLink?.addEventListener('click', showForgotPassword);

    document.querySelectorAll('[data-modal-close]').forEach((btn) => {
        btn.addEventListener('click', closeForgotPassword);
    });

    const forgotSubmit = document.getElementById('forgot-submit');
    forgotSubmit?.addEventListener('click', handleForgotPassword);

    const modal = document.getElementById('forgot-password-modal');
    modal?.addEventListener('click', (event) => {
        if (event.target === modal) {
            closeForgotPassword();
        }
    });

    const storedTheme = document.body.getAttribute('data-theme') || 'dark';
    applyTheme(storedTheme);

    const storedAccent = (() => {
        try {
            return localStorage.getItem('appAccent');
        } catch (error) {
            console.warn('Не удалось прочитать акцент', error);
            return null;
        }
    })();

    if (storedAccent) {
        applyAccent(storedAccent);
    }
}

document.addEventListener('DOMContentLoaded', initAuthPage);

// Экспорт для тестов или последующего переиспользования
window.MessendAuth = {
    switchForm,
    toggleForms,
    showMessage,
    applyTheme,
    applyAccent,
};

window.toggleForms = toggleForms;
