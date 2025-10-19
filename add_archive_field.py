#!/usr/bin/env python
# -*- coding: utf-8 -*-

from app import app, db
from sqlalchemy import text

print("=" * 60)
print("МИГРАЦИЯ: Добавление поля is_archived")
print("=" * 60)

with app.app_context():
    try:
        # Пытаемся добавить колонку
        sql = "ALTER TABLE room_participant ADD COLUMN is_archived BOOLEAN DEFAULT 0 NOT NULL"
        db.session.execute(text(sql))
        db.session.commit()
        print("✅ Поле is_archived успешно добавлено!")
    except Exception as e:
        if 'duplicate column' in str(e).lower() or 'already exists' in str(e).lower():
            print("✅ Поле is_archived уже существует - миграция не требуется")
        else:
            print(f"❌ Ошибка: {e}")
            print("\nПопробуйте вручную:")
            print("1. Откройте Python в папке проекта")
            print("2. Выполните команды из файла МИГРАЦИЯ_РУКАМИ.txt")

print("=" * 60)
print("Готово! Теперь запустите: python app.py")
print("=" * 60)

