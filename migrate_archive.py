import sqlite3
import os

DB_PATH = 'instance/database.db'

print("Миграция базы данных...")
conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()

try:
    cursor.execute("ALTER TABLE room_participant ADD COLUMN is_archived BOOLEAN DEFAULT 0 NOT NULL")
    conn.commit()
    print("Успешно! Поле is_archived добавлено.")
except sqlite3.OperationalError as e:
    if 'duplicate column' in str(e).lower():
        print("Поле уже существует.")
    else:
        print(f"Ошибка: {e}")
finally:
    conn.close()

