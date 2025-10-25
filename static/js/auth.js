// --- Улучшенный клиент аутентификации Messend X ---
(function () {
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const messageBox = document.getElementById('message-box');
    const passwordStrengthBar = document.getElementById('password-strength');
    const themeToggle = document.getElementById('theme-toggle');

    if (!loginForm || !registerForm) {
        console.warn('Страница аутентификации не инициализирована: формы не найдены.');
        return;
    }

    function updateMessageBox(message, type) {
        if (!messageBox) return;
        messageBox.textContent = message;
        messageBox.className = 'auth-message';
        if (type === 'error') {
            messageBox.classList.add('message-error');
        } else if (type === 'success') {
            messageBox.classList.add('message-success');
        }
        messageBox.style.display = 'block';
    }

    function calculatePasswordStrength(password) {
        let score = 0;
        const checks = [
            /.{8,}/, // длина
            /[A-ZА-Я]/,
            /[a-zа-я]/,
            /\d/,
            /[^\w\s]/
        ];
        checks.forEach((regex) => {
            if (regex.test(password)) score += 20;
        });
        return Math.min(score, 100);
    }

    function updatePasswordStrengthIndicator(password) {
        if (!passwordStrengthBar) return;
        const strength = calculatePasswordStrength(password);
        if (!password) {
            passwordStrengthBar.style.display = 'none';
            passwordStrengthBar.style.setProperty('--strength', '0%');
            return;
        }
        passwordStrengthBar.style.display = 'block';
        passwordStrengthBar.style.setProperty('--strength', `${strength}%`);
    }

    function switchAuthTab(mode) {
        const isLogin = mode === 'login';
        document.getElementById('tab-login').classList.toggle('is-active', isLogin);
        document.getElementById('tab-register').classList.toggle('is-active', !isLogin);
        loginForm.classList.toggle('auth-form--active', isLogin);
        registerForm.classList.toggle('auth-form--active', !isLogin);
        if (messageBox) {
            messageBox.style.display = 'none';
        }
        if (!isLogin) {
            document.getElementById('register-username').focus();
        } else {
            document.getElementById('login-identifier').focus();
        }
    }

    function togglePasswordVisibility(inputId, button) {
        const input = document.getElementById(inputId);
        if (!input) return;
        const isPassword = input.getAttribute('type') === 'password';
        input.setAttribute('type', isPassword ? 'text' : 'password');
        button.classList.toggle('is-active', !isPassword);
    }

    async function handleRegister() {
        const username = document.getElementById('register-username').value.trim();
        const email = document.getElementById('register-email').value.trim();
        const password = document.getElementById('register-password').value;

        if (!username || !email || !password) {
            updateMessageBox('Заполните все поля для регистрации.', 'error');
            return;
        }

        updatePasswordStrengthIndicator(password);

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
                updateMessageBox(data.message || 'Регистрация успешно завершена.', 'success');
                document.getElementById('login-identifier').value = username;
                document.getElementById('login-password').value = password;
                setTimeout(() => switchAuthTab('login'), 600);
                setTimeout(handleLogin, 1200);
            } else {
                updateMessageBox(data.message || 'Не удалось зарегистрироваться.', 'error');
            }
        } catch (error) {
            updateMessageBox('Ошибка сети или сервера. Попробуйте позже.', 'error');
        }
    }

    async function handleLogin() {
        const identifier = document.getElementById('login-identifier').value.trim();
        const password = document.getElementById('login-password').value;

        if (!identifier || !password) {
            updateMessageBox('Пожалуйста, введите логин и пароль.', 'error');
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
                updateMessageBox(data.message || 'Не удалось войти.', 'error');
            }
        } catch (error) {
            updateMessageBox('Ошибка сети или сервера. Попробуйте позже.', 'error');
        }
    }

    function showForgotPassword() {
        const modal = document.getElementById('forgot-password-modal');
        if (modal) {
            modal.style.display = 'flex';
            document.getElementById('forgot-email').value = '';
            document.getElementById('forgot-message').innerHTML = '';
        }
    }

    function closeForgotPassword() {
        const modal = document.getElementById('forgot-password-modal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    async function handleForgotPassword() {
        const emailInput = document.getElementById('forgot-email');
        const messageDiv = document.getElementById('forgot-message');
        const email = emailInput.value.trim();

        if (!email) {
            messageDiv.innerHTML = '<p class="auth-message message-error auth-message--inline">Введите email</p>';
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
                messageDiv.innerHTML = `<p class="auth-message message-success auth-message--inline">${data.message}<br><small style="opacity: 0.75;">Проверьте почту через несколько минут</small></p>`;
                setTimeout(() => {
                    closeForgotPassword();
                }, 5000);
            } else {
                messageDiv.innerHTML = `<p class="auth-message message-error auth-message--inline">${data.message}</p>`;
            }
        } catch (error) {
            messageDiv.innerHTML = '<p class="auth-message message-error auth-message--inline">Ошибка соединения с сервером</p>';
        }
    }

    function initializeThemeToggle() {
        if (!themeToggle) return;
        themeToggle.addEventListener('click', () => {
            const current = document.body.getAttribute('data-theme') || 'dark';
            const nextTheme = current === 'dark' ? 'light' : 'dark';
            document.body.setAttribute('data-theme', nextTheme);
            try {
                localStorage.setItem('appTheme', nextTheme);
            } catch (e) {
                console.warn('Не удалось сохранить тему', e);
            }
        });
    }

    window.switchAuthTab = switchAuthTab;
    window.togglePasswordVisibility = togglePasswordVisibility;
    window.handleLogin = handleLogin;
    window.handleRegister = handleRegister;
    window.showForgotPassword = showForgotPassword;
    window.closeForgotPassword = closeForgotPassword;
    window.handleForgotPassword = handleForgotPassword;

    document.addEventListener('DOMContentLoaded', () => {
        initializeThemeToggle();
        switchAuthTab('login');
        const registerPasswordInput = document.getElementById('register-password');
        if (registerPasswordInput) {
            registerPasswordInput.addEventListener('input', (event) => {
                updatePasswordStrengthIndicator(event.target.value);
            });
        }
    });
})();
