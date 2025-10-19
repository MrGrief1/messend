@echo off
chcp 65001 >nul
title Быстрая настройка Mail.ru

echo.
echo ═══════════════════════════════════════════════════════════════
echo    📧 НАСТРОЙКА MAIL.RU ДЛЯ GLASSCHAT
echo ═══════════════════════════════════════════════════════════════
echo.
echo Эта настройка для вашего аккаунта: urazovma@mail.ru
echo.
echo ВАЖНО: Убедитесь что SMTP включен в настройках Mail.ru:
echo https://e.mail.ru/settings/sender
echo.

set /p password="Введите пароль от почты urazovma@mail.ru: "

echo.
echo Установка переменных для Mail.ru...
echo.

setx MAIL_SERVER "smtp.mail.ru" >nul 2>&1
echo ✓ MAIL_SERVER = smtp.mail.ru

setx MAIL_PORT "465" >nul 2>&1
echo ✓ MAIL_PORT = 465

setx MAIL_USE_TLS "False" >nul 2>&1
echo ✓ MAIL_USE_TLS = False (используем SSL)

setx MAIL_USERNAME "urazovma@mail.ru" >nul 2>&1
echo ✓ MAIL_USERNAME = urazovma@mail.ru

setx MAIL_PASSWORD "%password%" >nul 2>&1
echo ✓ MAIL_PASSWORD = ************

echo.
echo ═══════════════════════════════════════════════════════════════
echo   ✅ НАСТРОЙКА ЗАВЕРШЕНА!
echo ═══════════════════════════════════════════════════════════════
echo.
echo ЧТО ДАЛЬШЕ:
echo.
echo   1. ЗАКРОЙТЕ ВСЕ окна CMD (это ВАЖНО!)
echo   2. Дважды кликните: start-glasschat.bat
echo   3. Подождите запуска (10 секунд)
echo   4. Протестируйте регистрацию
echo.
echo При регистрации письмо придёт на urazovma@mail.ru
echo (проверьте папку СПАМ если не видите письмо)
echo.

pause

