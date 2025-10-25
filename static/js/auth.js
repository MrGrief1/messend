const messageBox = document.getElementById('message-box');
const forgotModal = document.getElementById('forgot-password-modal');
const forgotForm = document.getElementById('forgot-password-form');
const forgotMessage = document.getElementById('forgot-message');

const forms = document.querySelectorAll('[data-auth-form]');
const navButtons = document.querySelectorAll('.auth-toggle [data-auth-view]');
const themeButtons = document.querySelectorAll('[data-theme-option]');
const passwordToggles = document.querySelectorAll('[data-password-toggle]');

const loginForm = document.querySelector('[data-auth-form="login"]');
const registerForm = document.querySelector('[data-auth-form="register"]');
const registerUsernameInput = document.getElementById('register-username');
const registerPasswordInput = document.getElementById('register-password');
const registerPasswordConfirmInput = document.getElementById('register-password-confirm');
const usernameHint = document.getElementById('username-hint');
const passwordMatchHint = document.getElementById('password-match-hint');
const strengthIndicator = document.querySelector('[data-strength-indicator]');
const strengthLabel = document.querySelector('[data-strength-label]');

function setActiveView(view) {
    const normalized = view === 'register' ? 'register' : 'login';
    forms.forEach((form) => {
        const isActive = form.dataset.authForm === normalized;
        form.classList.toggle('is-active', isActive);
        if (isActive) {
            form.setAttribute('aria-hidden', 'false');
        } else {
            form.setAttribute('aria-hidden', 'true');
        }
    });

    navButtons.forEach((button) => {
        const isCurrent = button.dataset.authView === normalized;
        button.classList.toggle('is-active', isCurrent);
        button.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
    });

    try {
        localStorage.setItem('authView', normalized);
    } catch (error) {
        console.warn('Не удалось сохранить выбранную форму', error);
    }

    clearMessage();
}

function showMessage(message, type = 'info') {
    if (!messageBox) return;
    messageBox.textContent = message;
    messageBox.removeAttribute('hidden');
    messageBox.dataset.state = type;
}

function clearMessage() {
    if (!messageBox) return;
    messageBox.textContent = '';
    messageBox.setAttribute('hidden', '');
    delete messageBox.dataset.state;
}

function togglePasswordVisibility(inputId, toggleButton) {
    const input = document.getElementById(inputId);
    if (!input) return;

    const isPassword = input.getAttribute('type') === 'password';
    input.setAttribute('type', isPassword ? 'text' : 'password');

    if (!toggleButton) return;
    const icon = toggleButton.querySelector('.material-icons-round');
    if (icon) {
        icon.textContent = isPassword ? 'visibility_off' : 'visibility';
    }
}

function applyTheme(theme) {
    if (!theme) return;
    document.body.setAttribute('data-theme', theme);

    themeButtons.forEach((button) => {
        const isActive = button.dataset.themeOption === theme;
        button.classList.toggle('is-active', isActive);
    });

    try {
        localStorage.setItem('appTheme', theme);
    } catch (error) {
        console.warn('Не удалось сохранить тему', error);
    }
}

function evaluatePasswordStrength(password) {
    let score = 0;
    if (!password) return { score: 0, label: '—', gradient: 'linear-gradient(90deg, rgba(255,255,255,0.1), rgba(255,255,255,0.05))' };

    const lengthScore = Math.min(2, Math.floor(password.length / 4));
    score += lengthScore;

    const complexityChecks = [
        /[a-z]/.test(password),
        /[A-Z]/.test(password),
        /\d/.test(password),
        /[^A-Za-z0-9]/.test(password)
    ];

    score += complexityChecks.filter(Boolean).length;
    score = Math.min(score, 5);

    const labels = ['—', 'Очень слабый', 'Слабый', 'Неплохой', 'Хороший', 'Отличный'];
    const gradients = [
        'linear-gradient(90deg, rgba(255,255,255,0.1), rgba(255,255,255,0.05))',
        'linear-gradient(90deg, rgba(255,76,76,0.85), rgba(255,76,76,0.4))',
        'linear-gradient(90deg, rgba(255,149,0,0.85), rgba(255,149,0,0.4))',
        'linear-gradient(90deg, rgba(255,214,10,0.85), rgba(255,214,10,0.4))',
        'linear-gradient(90deg, rgba(52,199,89,0.85), rgba(52,199,89,0.4))',
        'linear-gradient(90deg, rgba(64,156,255,0.9), rgba(64,156,255,0.5))'
    ];

    return {
        score,
        label: labels[score],
        gradient: gradients[score]
    };
}

function updatePasswordStrength(password) {
    if (!strengthIndicator || !strengthLabel) return;
    const { score, label, gradient } = evaluatePasswordStrength(password);
    const normalizedScore = Math.max(0.05, score / 5);
    strengthIndicator.style.setProperty('--strength', normalizedScore.toString());
    const bar = strengthIndicator.querySelector('.password-meter-bar');
    if (bar) {
        bar.style.background = gradient;
    }
    strengthLabel.textContent = `Надёжность: ${label}`;
}

function validatePasswordMatch() {
    if (!registerPasswordInput || !registerPasswordConfirmInput || !passwordMatchHint) return;
    const baseText = registerPasswordInput.value && registerPasswordConfirmInput.value && registerPasswordInput.value !== registerPasswordConfirmInput.value
        ? 'Пароли не совпадают'
        : '';
    passwordMatchHint.textContent = baseText;
    passwordMatchHint.style.color = baseText ? '#ff6b6b' : 'inherit';
    return baseText === '';
}

function sanitizeUsername(value) {
    if (!value) return '';
    return value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 32);
}

function handleUsernameInput(event) {
    if (!usernameHint) return;
    const sanitized = sanitizeUsername(event.target.value);
    if (sanitized !== event.target.value) {
        const cursor = event.target.selectionStart || sanitized.length;
        event.target.value = sanitized;
        if (typeof event.target.setSelectionRange === 'function') {
            event.target.setSelectionRange(cursor, cursor);
        }
    }

    if (sanitized.length < 3) {
        usernameHint.textContent = 'Минимум 3 символа, используйте латиницу и цифры';
    } else if (sanitized.length > 24) {
        usernameHint.textContent = 'Очень длинно. Подумайте о более коротком @теге';
    } else {
        usernameHint.textContent = `Ваш адрес будет выглядеть как @${sanitized}`;
    }
}

async function handleRegister(event) {
    event?.preventDefault?.();
    if (!registerForm) return;

    const username = registerUsernameInput?.value.trim();
    const email = document.getElementById('register-email')?.value.trim();
    const password = registerPasswordInput?.value || '';
    const passwordConfirm = registerPasswordConfirmInput?.value || '';

    if (!username || !email || !password) {
        showMessage('Пожалуйста, заполните все обязательные поля.', 'error');
        return;
    }

    if (!validatePasswordMatch()) {
        showMessage('Пароли не совпадают. Проверьте ввод.', 'error');
        return;
    }

    const submitButton = registerForm.querySelector('button[type="submit"]');
    submitButton?.setAttribute('disabled', 'true');

    try {
        showMessage('Создаём аккаунт…', 'info');
        const response = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, password })
        });

        const data = await response.json();
        if (data.success) {
            showMessage(data.message || 'Аккаунт создан. Выполняем вход…', 'success');
            const loginIdentifier = document.getElementById('login-identifier');
            const loginPassword = document.getElementById('login-password');
            if (loginIdentifier && loginPassword) {
                loginIdentifier.value = username;
                loginPassword.value = password;
                setTimeout(() => handleLogin(), 1200);
            }
        } else {
            showMessage(data.message || 'Не удалось создать аккаунт. Попробуйте снова.', 'error');
        }
    } catch (error) {
        console.error('Ошибка регистрации', error);
        showMessage('Ошибка сети или сервера. Попробуйте позже.', 'error');
    } finally {
        submitButton?.removeAttribute('disabled');
    }
}

async function handleLogin(event) {
    event?.preventDefault?.();
    const identifier = document.getElementById('login-identifier')?.value.trim();
    const password = document.getElementById('login-password')?.value || '';

    if (!identifier || !password) {
        showMessage('Введите логин и пароль, чтобы продолжить.', 'error');
        return;
    }

    const loginButton = loginForm?.querySelector('button[type="submit"]');
    loginButton?.setAttribute('disabled', 'true');

    try {
        showMessage('Авторизуемся…', 'info');
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier, password })
        });

        const data = await response.json();
        if (data.success) {
            showMessage('Успех! Перенаправляем…', 'success');
            window.location.href = '/';
        } else {
            showMessage(data.message || 'Неверный логин или пароль.', 'error');
        }
    } catch (error) {
        console.error('Ошибка входа', error);
        showMessage('Ошибка сети или сервера. Попробуйте позже.', 'error');
    } finally {
        loginButton?.removeAttribute('disabled');
    }
}

function openForgotPasswordModal() {
    if (!forgotModal) return;
    forgotModal.removeAttribute('hidden');
    forgotMessage?.setAttribute('hidden', '');
    if (forgotForm) {
        forgotForm.reset();
        const emailInput = forgotForm.querySelector('input[type="email"]');
        emailInput?.focus();
    }
}

function closeForgotPasswordModal() {
    if (!forgotModal) return;
    forgotModal.setAttribute('hidden', '');
}

async function handleForgotPassword(event) {
    event?.preventDefault?.();
    if (!forgotForm) return;

    const email = document.getElementById('forgot-email')?.value.trim();
    if (!email) {
        if (forgotMessage) {
            forgotMessage.textContent = 'Введите email';
            forgotMessage.dataset.state = 'error';
            forgotMessage.removeAttribute('hidden');
        }
        return;
    }

    const submitButton = forgotForm.querySelector('[data-modal-submit]');
    submitButton?.setAttribute('disabled', 'true');

    try {
        if (forgotMessage) {
            forgotMessage.textContent = 'Отправляем письмо…';
            forgotMessage.dataset.state = 'info';
            forgotMessage.removeAttribute('hidden');
        }

        const response = await fetch('/api/forgot_password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await response.json();

        if (forgotMessage) {
            if (data.success) {
                forgotMessage.textContent = data.message || 'Ссылка отправлена. Проверьте почту.';
                forgotMessage.dataset.state = 'success';
                setTimeout(closeForgotPasswordModal, 4500);
            } else {
                forgotMessage.textContent = data.message || 'Не удалось отправить письмо. Попробуйте позже.';
                forgotMessage.dataset.state = 'error';
            }
        }
    } catch (error) {
        console.error('Ошибка восстановления пароля', error);
        if (forgotMessage) {
            forgotMessage.textContent = 'Ошибка соединения с сервером.';
            forgotMessage.dataset.state = 'error';
            forgotMessage.removeAttribute('hidden');
        }
    } finally {
        submitButton?.removeAttribute('disabled');
    }
}

// --- Инициализация событий ---

document.body.addEventListener('click', (event) => {
    const viewTrigger = event.target.closest('[data-auth-view]');
    if (viewTrigger) {
        event.preventDefault();
        setActiveView(viewTrigger.dataset.authView);
        return;
    }

    const themeTrigger = event.target.closest('[data-theme-option]');
    if (themeTrigger) {
        event.preventDefault();
        applyTheme(themeTrigger.dataset.themeOption);
        return;
    }

    const forgotTrigger = event.target.closest('[data-forgot-trigger]');
    if (forgotTrigger) {
        event.preventDefault();
        openForgotPasswordModal();
    }

    const closeTrigger = event.target.closest('[data-modal-close]');
    if (closeTrigger) {
        event.preventDefault();
        closeForgotPasswordModal();
    }
});

passwordToggles.forEach((toggle) => {
    toggle.addEventListener('click', (event) => {
        event.preventDefault();
        const inputId = toggle.dataset.passwordToggle;
        togglePasswordVisibility(inputId, toggle);
    });
});

window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && forgotModal && !forgotModal.hasAttribute('hidden')) {
        closeForgotPasswordModal();
    }
});

forgotModal?.addEventListener('click', (event) => {
    if (event.target === forgotModal) {
        closeForgotPasswordModal();
    }
});

loginForm?.addEventListener('submit', handleLogin);
registerForm?.addEventListener('submit', handleRegister);
forgotForm?.addEventListener('submit', handleForgotPassword);

registerUsernameInput?.addEventListener('input', handleUsernameInput);
registerPasswordInput?.addEventListener('input', (event) => {
    updatePasswordStrength(event.target.value);
    validatePasswordMatch();
});
registerPasswordConfirmInput?.addEventListener('input', validatePasswordMatch);

// Автовосстановление выбора формы и темы
(function restorePreferences() {
    try {
        const savedView = localStorage.getItem('authView');
        if (savedView) {
            setActiveView(savedView);
        } else {
            setActiveView('login');
        }
    } catch (error) {
        console.warn('Не удалось восстановить форму входа', error);
        setActiveView('login');
    }

    const currentTheme = document.body.getAttribute('data-theme');
    applyTheme(currentTheme || 'dark');
})();

// Инициируем состояние подсказок
if (registerPasswordInput) {
    updatePasswordStrength(registerPasswordInput.value);
}
validatePasswordMatch();
