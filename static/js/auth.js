(function () {
    const AUTH_SKIN_CLASSNAMES = ['element-skin', 'classic-skin'];
    const formState = {
        mode: 'login'
    };

    function getPanel() {
        return document.querySelector('.auth-panel');
    }

    function getMessageBox() {
        return document.getElementById('message-box');
    }

    function toggleForms(nextMode) {
        const panel = getPanel();
        if (!panel) {
            return;
        }

        const desiredMode = nextMode === 'register' ? 'register' : 'login';
        if (formState.mode === desiredMode) {
            hideMessage();
            return;
        }

        formState.mode = desiredMode;
        panel.dataset.mode = desiredMode;

        const loginForm = document.getElementById('login-form');
        const registerForm = document.getElementById('register-form');

        if (loginForm && registerForm) {
            if (desiredMode === 'login') {
                loginForm.dataset.state = 'active';
                registerForm.dataset.state = 'hidden';
            } else {
                loginForm.dataset.state = 'hidden';
                registerForm.dataset.state = 'active';
            }
        }

        updateTabs(desiredMode);
        updateProgress(desiredMode);
        hideMessage();
    }

    function updateTabs(mode) {
        document.querySelectorAll('.auth-tab').forEach((tab) => {
            const tabMode = tab.getAttribute('data-mode');
            if (tabMode === mode) {
                tab.classList.add('active');
            } else {
                tab.classList.remove('active');
            }
        });
    }

    function updateProgress(mode) {
        document.querySelectorAll('.auth-progress-step').forEach((step) => {
            const stepKey = step.getAttribute('data-step');
            if (mode === 'register' && stepKey === 'register') {
                step.classList.add('active');
            } else if (mode === 'login' && stepKey === 'login') {
                step.classList.add('active');
            } else {
                step.classList.remove('active');
            }
        });
    }

    function hideMessage() {
        const messageBox = getMessageBox();
        if (messageBox) {
            messageBox.textContent = '';
            messageBox.className = 'message-box';
            messageBox.style.display = 'none';
        }
    }

    function showMessage(message, type) {
        const messageBox = getMessageBox();
        if (!messageBox) {
            return;
        }

        messageBox.textContent = message;
        messageBox.className = 'message-box';
        if (type === 'error') {
            messageBox.classList.add('message-error');
        } else if (type === 'success') {
            messageBox.classList.add('message-success');
        }
        messageBox.style.display = 'block';
    }

    function validateUsername(value) {
        return /^[a-zA-Z0-9_]{3,30}$/.test(value);
    }

    function refreshUsernamePreview() {
        const input = document.getElementById('register-username');
        const preview = document.getElementById('username-preview');
        if (!input || !preview) {
            return;
        }

        let normalized = input.value.trim().replace(/@/g, '');
        input.value = normalized;
        if (!normalized) {
            preview.textContent = '@example';
            preview.classList.remove('error');
            return;
        }

        preview.textContent = '@' + normalized;
        if (!validateUsername(normalized)) {
            preview.classList.add('error');
        } else {
            preview.classList.remove('error');
        }
    }

    function evaluatePasswordStrength(password) {
        let score = 0;
        if (password.length >= 8) score++;
        if (/[0-9]/.test(password)) score++;
        if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
        if (/[^A-Za-z0-9]/.test(password)) score++;
        return Math.min(score, 3);
    }

    function refreshPasswordMeter() {
        const meter = document.getElementById('password-meter');
        const input = document.getElementById('register-password');
        if (!meter || !input) {
            return;
        }

        const strength = evaluatePasswordStrength(input.value);
        meter.dataset.strength = String(strength);
    }

    function showCapsLockWarning(event) {
        const indicator = document.getElementById('login-caps');
        if (!indicator) {
            return;
        }

        if (event.getModifierState && event.getModifierState('CapsLock')) {
            indicator.hidden = false;
        } else {
            indicator.hidden = true;
        }
    }

    async function handleRegister() {
        const usernameInput = document.getElementById('register-username');
        const emailInput = document.getElementById('register-email');
        const passwordInput = document.getElementById('register-password');

        if (!usernameInput || !emailInput || !passwordInput) {
            return;
        }

        const username = usernameInput.value.trim();
        const email = emailInput.value.trim();
        const password = passwordInput.value;

        if (!validateUsername(username)) {
            showMessage('Имя пользователя может содержать только латинские буквы, цифры и подчёркивания (3-30 символов).', 'error');
            return;
        }

        if (!email) {
            showMessage('Введите корректный email для подтверждения.', 'error');
            return;
        }

        if (password.length < 8) {
            showMessage('Пароль должен содержать минимум 8 символов.', 'error');
            return;
        }

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
                showMessage(data.message || 'Аккаунт создан успешно!', 'success');
                const loginIdentifier = document.getElementById('login-identifier');
                const loginPassword = document.getElementById('login-password');
                if (loginIdentifier && loginPassword) {
                    loginIdentifier.value = username;
                    loginPassword.value = password;
                }

                setTimeout(() => {
                    toggleForms('login');
                    setTimeout(handleLogin, 400);
                }, 1200);
            } else {
                showMessage(data.message || 'Не удалось создать аккаунт.', 'error');
            }
        } catch (error) {
            console.error('Register error:', error);
            showMessage('Ошибка сети или сервера. Попробуйте позже.', 'error');
        }
    }

    async function handleLogin() {
        const identifierInput = document.getElementById('login-identifier');
        const passwordInput = document.getElementById('login-password');
        if (!identifierInput || !passwordInput) {
            return;
        }

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
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ identifier, password })
            });

            const data = await response.json();
            if (data.success) {
                window.location.href = '/';
            } else {
                showMessage(data.message || 'Не удалось выполнить вход.', 'error');
            }
        } catch (error) {
            console.error('Login error:', error);
            showMessage('Ошибка сети или сервера. Попробуйте позже.', 'error');
        }
    }

    function showForgotPassword() {
        const modal = document.getElementById('forgot-password-modal');
        const emailInput = document.getElementById('forgot-email');
        const message = document.getElementById('forgot-message');
        if (!modal) {
            return;
        }

        modal.classList.add('show');
        if (emailInput) {
            emailInput.value = '';
            emailInput.focus();
        }
        if (message) {
            message.innerHTML = '';
        }
    }

    function closeForgotPassword() {
        const modal = document.getElementById('forgot-password-modal');
        if (modal) {
            modal.classList.remove('show');
        }
    }

    async function handleForgotPassword() {
        const emailInput = document.getElementById('forgot-email');
        const message = document.getElementById('forgot-message');
        if (!emailInput || !message) {
            return;
        }

        const email = emailInput.value.trim();
        if (!email) {
            message.innerHTML = '<p style="color:#ff7373">Введите email.</p>';
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
                message.innerHTML = `<p style="color:#34C759">${data.message || 'Мы отправили письмо для восстановления.'}</p>`;
                setTimeout(closeForgotPassword, 4800);
            } else {
                message.innerHTML = `<p style="color:#ff7373">${data.message || 'Не удалось отправить письмо.'}</p>`;
            }
        } catch (error) {
            console.error('Forgot password error:', error);
            message.innerHTML = '<p style="color:#ff7373">Ошибка соединения с сервером.</p>';
        }
    }

    function attachListeners() {
        const usernameInput = document.getElementById('register-username');
        const passwordInput = document.getElementById('register-password');
        const loginPassword = document.getElementById('login-password');

        if (usernameInput) {
            usernameInput.addEventListener('input', refreshUsernamePreview);
        }
        if (passwordInput) {
            passwordInput.addEventListener('input', refreshPasswordMeter);
        }
        if (loginPassword) {
            ['keyup', 'keydown'].forEach((eventName) => {
                loginPassword.addEventListener(eventName, showCapsLockWarning);
            });
        }

        const panel = getPanel();
        if (panel) {
            panel.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    if (formState.mode === 'login') {
                        handleLogin();
                    } else {
                        handleRegister();
                    }
                }
            });
        }
    }

    function applyStoredSkin() {
        try {
            const skin = localStorage.getItem('appSkin');
            if (skin) {
                document.body.dataset.skin = skin;
                document.body.classList.remove(...AUTH_SKIN_CLASSNAMES);
                document.body.classList.add(`${skin}-skin`);
            }
        } catch (error) {
            console.warn('Skin restore failed', error);
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        applyStoredSkin();
        refreshUsernamePreview();
        refreshPasswordMeter();
        attachListeners();
    });

    window.toggleForms = toggleForms;
    window.showForgotPassword = showForgotPassword;
    window.closeForgotPassword = closeForgotPassword;
    window.handleForgotPassword = handleForgotPassword;
    window.handleRegister = handleRegister;
    window.handleLogin = handleLogin;
})();
