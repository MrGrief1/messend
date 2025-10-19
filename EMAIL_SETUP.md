# 📧 Настройка Email для GlassChat

## Зачем нужно?
- Подтверждение регистрации
- Восстановление пароля
- Уведомления

---

## 🚀 Быстрая настройка (Gmail)

### Шаг 1: Получите пароль приложения Gmail

1. Включите **двухфакторную аутентификацию** в Google аккаунте
2. Перейдите: https://myaccount.google.com/apppasswords
3. Создайте **"Пароль приложения"** для **"Почта"**
4. Скопируйте сгенерированный пароль (16 символов)

### Шаг 2: Установите переменные окружения

**В PowerShell перед запуском app.py:**

```powershell
$env:MAIL_SERVER = "smtp.gmail.com"
$env:MAIL_PORT = "587"
$env:MAIL_USE_TLS = "True"
$env:MAIL_USERNAME = "ваша_почта@gmail.com"
$env:MAIL_PASSWORD = "xxxx xxxx xxxx xxxx"
python app.py
```

**Или создайте файл `.env`** (один раз):

```env
MAIL_SERVER=smtp.gmail.com
MAIL_PORT=587
MAIL_USE_TLS=True
MAIL_USERNAME=ваша_почта@gmail.com
MAIL_PASSWORD=xxxx xxxx xxxx xxxx
SECRET_KEY=ваш_секретный_ключ
```

Затем установите `python-dotenv`:
```bash
pip install python-dotenv
```

И добавьте в начало `app.py`:
```python
from dotenv import load_dotenv
load_dotenv()
```

---

## 📮 Другие почтовые сервисы

### Yandex Mail

```powershell
$env:MAIL_SERVER = "smtp.yandex.ru"
$env:MAIL_PORT = "587"
$env:MAIL_USE_TLS = "True"
$env:MAIL_USERNAME = "ваша_почта@yandex.ru"
$env:MAIL_PASSWORD = "ваш_пароль"
```

### Mail.ru

```powershell
$env:MAIL_SERVER = "smtp.mail.ru"
$env:MAIL_PORT = "587"
$env:MAIL_USE_TLS = "True"
$env:MAIL_USERNAME = "ваша_почта@mail.ru"
$env:MAIL_PASSWORD = "ваш_пароль"
```

### Outlook / Hotmail

```powershell
$env:MAIL_SERVER = "smtp-mail.outlook.com"
$env:MAIL_PORT = "587"
$env:MAIL_USE_TLS = "True"
$env:MAIL_USERNAME = "ваша_почта@outlook.com"
$env:MAIL_PASSWORD = "ваш_пароль"
```

---

## ✅ Проверка настроек

После запуска `python app.py` вы должны увидеть:

✅ **Без предупреждения** - Email настроен правильно
❌ **"ВНИМАНИЕ: Переменные окружения для Email не настроены"** - нужно настроить

---

## 🐛 Проблемы?

### "Authentication failed" (Gmail)
- Используйте **пароль приложения**, а не обычный пароль
- Проверьте что двухфакторная аутентификация включена

### "Connection refused"
- Проверьте что порт 587 открыт
- Попробуйте порт 465 с `MAIL_USE_SSL=True` вместо `MAIL_USE_TLS`

### Письма не приходят
- Проверьте папку "Спам"
- Проверьте что MAIL_USERNAME заполнен правильно

---

## 🔒 Безопасность

⚠️ **НЕ коммитьте** файл `.env` в Git!
⚠️ **НЕ публикуйте** пароли приложений

Добавьте в `.gitignore`:
```
.env
*.env
```

---

**Готово! Теперь Email будет работать!** 📬

