"""
Скрипт миграции базы данных для добавления поля is_archived
Запустите этот скрипт ОДИН РАЗ для обновления существующей базы данных
"""

import sqlite3
import os

DB_PATH = os.path.join('instance', 'database.db')

def update_database():
    print("🔄 Начинаем миграцию базы данных...")
    
    if not os.path.exists(DB_PATH):
        print("❌ База данных не найдена:", DB_PATH)
        return False
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    try:
        # Проверяем существует ли уже поле is_archived
        cursor.execute("PRAGMA table_info(room_participant)")
        columns = [col[1] for col in cursor.fetchall()]
        
        if 'is_archived' in columns:
            print("✅ Поле is_archived уже существует. Миграция не требуется.")
            return True
        
        # Добавляем новое поле
        print("📝 Добавляем поле is_archived...")
        cursor.execute("""
            ALTER TABLE room_participant 
            ADD COLUMN is_archived BOOLEAN DEFAULT 0 NOT NULL
        """)
        
        conn.commit()
        print("✅ Миграция успешно завершена!")
        print("   Добавлено поле: is_archived (BOOLEAN, default=False)")
        return True
        
    except sqlite3.OperationalError as e:
        print(f"❌ Ошибка миграции: {e}")
        return False
    finally:
        conn.close()

if __name__ == '__main__':
    print("=" * 60)
    print("  МИГРАЦИЯ БАЗЫ ДАННЫХ - АРХИВИРОВАНИЕ ЧАТОВ")
    print("=" * 60)
    print()
    
    if update_database():
        print()
        print("🎉 Готово! Теперь можно запускать сервер:")
        print("   python app.py")
        print()
        print("💡 Новые функции:")
        print("   - Вкладка 'Архив' в sidebar")
        print("   - Правый клик на чат → 'В архив'")
        print("   - Скрытые чаты не мешают в основном списке")
    else:
        print()
        print("❌ Миграция не удалась. Проверьте ошибки выше.")
    
    print("=" * 60)

