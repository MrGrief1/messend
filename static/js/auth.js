const STATE = {
    currentView: 'login',
    tabs: [],
    panels: []
};

function applyTheme(theme) {
    const body = document.body;
    if (!body) return;
    body.setAttribute('data-theme', theme);
    try {
        localStorage.setItem('appTheme', theme);
    } catch (err) {
        console.warn('Не удалось сохранить тему в localStorage', err);
    }
    document.querySelectorAll('[data-theme-select]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.themeSelect === theme);
    });
}

function initThemeControls() {
    const stored = (() => {
        try {
            return localStorage.getItem('appTheme');
        } catch (err) {
            return null;
        }
    })();

    if (stored) {
        applyTheme(stored);
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
        applyTheme('light');
    } else {
        applyTheme(document.body.getAttribute('data-theme') || 'dark');
    }

    document.querySelectorAll('[data-theme-select]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const theme = btn.dataset.themeSelect;
            if (theme) {
                applyTheme(theme);
            }
        });
    });
}

function setLoadingState(context, isLoading) {
    if (!context) return;
    let button = null;
    if (context.tagName === 'BUTTON') {
        button = context;
    } else {
        button = context.querySelector('button[type="submit"], button.primary-action');
    }
    if (!button) return;

    if (isLoading) {
        button.disabled = true;
        button.dataset.loading = 'true';
    } else {
        button.disabled = false;
        delete button.dataset.loading;
    }
}

function showMessage(target, message, type = 'info') {
    if (!target) return;
    target.textContent = message;
    target.classList.remove('message-error', 'message-success', 'visible');
    if (type === 'error') {
        target.classList.add('message-error');
    } else if (type === 'success') {
        target.classList.add('message-success');
    }
    target.classList.add('visible');
}

function clearMessage(target) {
    if (!target) return;
    target.textContent = '';
    target.classList.remove('message-error', 'message-success', 'visible');
}

function switchView(view) {
    if (!view) return;
    STATE.currentView = view;
    STATE.tabs.forEach((tab) => {
        const isActive = tab.dataset.view === view;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    STATE.panels.forEach((panel) => {
        const isActive = panel.dataset.viewPanel === view;
        panel.classList.toggle('active', isActive);
        if (isActive) {
            const focusTarget = panel.querySelector('input, button, [tabindex="0"]');
            if (focusTarget) {
                setTimeout(() => focusTarget.focus(), 120);
            }
        }
    });

    clearMessage(document.getElementById('message-box'));
    clearMessage(document.getElementById('register-message'));
}

async function handleLogin(event) {
    if (event) {
        event.preventDefault();
    }
    const form = event ? event.target : document.getElementById('login-form');
    const identifierInput = document.getElementById('login-identifier');
    const passwordInput = document.getElementById('login-password');
    const messageBox = document.getElementById('message-box');

    const identifier = identifierInput ? identifierInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';

    if (!identifier || !password) {
        showMessage(messageBox, 'Пожалуйста, заполните логин и пароль.', 'error');
        return;
    }

    setLoadingState(form, true);
    clearMessage(messageBox);

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ identifier, password })
        });

        const data = await response.json();
        if (data.success) {
            window.location.href = '/';
        } else {
            showMessage(messageBox, data.message || 'Не удалось выполнить вход.', 'error');
        }
    } catch (error) {
        console.error('Ошибка входа', error);
        showMessage(messageBox, 'Ошибка соединения с сервером. Попробуйте позже.', 'error');
    } finally {
        setLoadingState(form, false);
    }
}

function evaluatePasswordStrength(password) {
    let score = 0;
    if (password.length >= 8) score += 1;
    if (/[A-ZА-Я]/.test(password) && /[a-zа-я]/.test(password)) score += 1;
    if (/[0-9]/.test(password) || /[^A-Za-z0-9А-Яа-я]/.test(password)) score += 1;
    if (password.length >= 12) score += 1;
    return Math.min(score, 3);
}

function initPasswordStrengthMeter() {
    const input = document.getElementById('register-password');
    const container = document.getElementById('password-strength');
    if (!input || !container) return;

    const bars = Array.from(container.querySelectorAll('.strength-bar'));
    const label = container.querySelector('.strength-label');

    input.addEventListener('input', () => {
        const value = input.value.trim();
        if (!value) {
            container.classList.remove('visible');
            bars.forEach((bar) => bar.classList.remove('active'));
            if (label) label.textContent = 'Надёжность пароля';
            return;
        }

        container.classList.add('visible');
        const score = evaluatePasswordStrength(value);
        bars.forEach((bar, index) => {
            bar.classList.toggle('active', index < score);
        });

        if (label) {
            if (score <= 1) {
                label.textContent = 'Слабый пароль';
            } else if (score === 2) {
                label.textContent = 'Хороший пароль';
            } else {
                label.textContent = 'Отличный пароль';
            }
        }
    });
}

async function handleRegister(event) {
    if (event) {
        event.preventDefault();
    }
    const form = event ? event.target : document.getElementById('register-form');
    const usernameInput = document.getElementById('register-username');
    const emailInput = document.getElementById('register-email');
    const passwordInput = document.getElementById('register-password');
    const consentInput = document.getElementById('register-consent');
    const messageBox = document.getElementById('register-message');

    const username = usernameInput ? usernameInput.value.trim() : '';
    const email = emailInput ? emailInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';
    const consentGiven = consentInput ? consentInput.checked : true;

    if (!username || !email || !password) {
        showMessage(messageBox, 'Пожалуйста, заполните все поля для регистрации.', 'error');
        return;
    }

    if (!consentGiven) {
        showMessage(messageBox, 'Для регистрации необходимо согласие с условиями.', 'error');
        return;
    }

    setLoadingState(form, true);
    clearMessage(messageBox);

    try {
        const response = await fetch('/api/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, email, password })
        });

        const data = await response.json();
        if (data.success) {
            showMessage(messageBox, data.message || 'Регистрация прошла успешно!', 'success');
            const loginIdentifier = document.getElementById('login-identifier');
            const loginPassword = document.getElementById('login-password');
            if (loginIdentifier) loginIdentifier.value = username;
            if (loginPassword) loginPassword.value = password;

            setTimeout(() => {
                switchView('login');
                handleLogin();
            }, 1400);
        } else {
            showMessage(messageBox, data.message || 'Не удалось завершить регистрацию.', 'error');
        }
    } catch (error) {
        console.error('Ошибка регистрации', error);
        showMessage(messageBox, 'Ошибка соединения с сервером. Попробуйте позже.', 'error');
    } finally {
        setLoadingState(form, false);
    }
}

function initPasswordToggles() {
    document.querySelectorAll('[data-password-toggle]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const fieldId = btn.getAttribute('data-password-toggle');
            if (!fieldId) return;
            const input = document.getElementById(fieldId);
            if (!input) return;
            const isVisible = input.type === 'text';
            input.type = isVisible ? 'password' : 'text';
            const icon = btn.querySelector('.material-icons-round');
            if (icon) {
                icon.textContent = isVisible ? 'visibility' : 'visibility_off';
            }
        });
    });
}

function initForgotPasswordModal() {
    const trigger = document.getElementById('forgot-password-trigger');
    const modal = document.getElementById('forgot-password-modal');
    const closeBtn = document.getElementById('forgot-password-close');
    const submitBtn = document.getElementById('forgot-password-submit');
    const emailInput = document.getElementById('forgot-email');
    const messageBox = document.getElementById('forgot-message');

    if (!modal) return;

    const openModal = () => {
        modal.classList.add('is-visible');
        modal.setAttribute('aria-hidden', 'false');
        if (emailInput) emailInput.value = '';
        clearMessage(messageBox);
    };

    const closeModal = () => {
        modal.classList.remove('is-visible');
        modal.setAttribute('aria-hidden', 'true');
    };

    trigger?.addEventListener('click', () => {
        openModal();
    });

    closeBtn?.addEventListener('click', () => {
        closeModal();
    });

    modal.addEventListener('click', (event) => {
        if (event.target === modal) {
            closeModal();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && modal.classList.contains('is-visible')) {
            closeModal();
        }
    });

    submitBtn?.addEventListener('click', async () => {
        const email = emailInput ? emailInput.value.trim() : '';
        if (!email) {
            showMessage(messageBox, 'Введите email, указанный при регистрации.', 'error');
            return;
        }

        setLoadingState(submitBtn, true);
        clearMessage(messageBox);

        try {
            const response = await fetch('/api/forgot_password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });
            const data = await response.json();
            if (data.success) {
                showMessage(messageBox, `${data.message}\nПроверьте почту через несколько минут.`, 'success');
                setTimeout(() => {
                    closeModal();
                }, 4500);
            } else {
                showMessage(messageBox, data.message || 'Не удалось отправить письмо.', 'error');
            }
        } catch (error) {
            console.error('Ошибка восстановления', error);
            showMessage(messageBox, 'Не удалось связаться с сервером. Попробуйте позже.', 'error');
        } finally {
            setLoadingState(submitBtn, false);
        }
    });
}

function initViewSwitching() {
    STATE.tabs = Array.from(document.querySelectorAll('.auth-tab'));
    STATE.panels = Array.from(document.querySelectorAll('[data-view-panel]'));

    const triggers = Array.from(document.querySelectorAll('[data-view]'));
    triggers.forEach((trigger) => {
        trigger.addEventListener('click', (event) => {
            event.preventDefault();
            const targetView = trigger.dataset.view;
            if (targetView) {
                switchView(targetView);
            }
        });
    });

    switchView(STATE.currentView);
}

function initForms() {
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    loginForm?.addEventListener('submit', handleLogin);
    registerForm?.addEventListener('submit', handleRegister);
}

document.addEventListener('DOMContentLoaded', () => {
    initThemeControls();
    initViewSwitching();
    initForms();
    initPasswordStrengthMeter();
    initPasswordToggles();
    initForgotPasswordModal();
});
