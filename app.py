from flask import Flask, render_template, request, jsonify, redirect, url_for, session
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from flask_socketio import SocketIO, emit, join_room, leave_room
from datetime import datetime
from itsdangerous import URLSafeTimedSerializer
import os
from flask_mail import Mail, Message as MailMessage
from werkzeug.utils import secure_filename
from sqlalchemy import text
import json
import time, hmac, hashlib, base64
from flask import request as flask_request
try:
    import eventlet
    # Включать monkey_patch только если явно задано USE_EVENTLET=1
    if os.environ.get('USE_EVENTLET') == '1':
        eventlet.monkey_patch()
    else:
        eventlet = None
except Exception:
    eventlet = None

# Инициализация и Конфигурация
app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'a_very_secret_key_change_this_now')

# Выбор БД: 1) DATABASE_URL; 2) instance/database.db (абсолютный путь); 3) database.db
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INSTANCE_DIR = os.path.join(BASE_DIR, 'instance')
try:
    os.makedirs(INSTANCE_DIR, exist_ok=True)
except Exception:
    pass

db_uri_env = os.environ.get('DATABASE_URL')
if db_uri_env:
    app.config['SQLALCHEMY_DATABASE_URI'] = db_uri_env
else:
    instance_db_path = os.path.join(INSTANCE_DIR, 'database.db')
    if os.path.exists(instance_db_path):
        app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///' + instance_db_path
    else:
        app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///database.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024  # 100MB для видео

# Загрузка аватаров
UPLOAD_AVATAR_DIR = os.path.join('static', 'uploads', 'avatars')
os.makedirs(UPLOAD_AVATAR_DIR, exist_ok=True)
ALLOWED_IMAGE_EXTENSIONS = { 'png', 'jpg', 'jpeg', 'gif', 'webp' }

# Загрузка медиа (фото/видео)
UPLOAD_MEDIA_DIR = os.path.join('static', 'uploads', 'media')
os.makedirs(UPLOAD_MEDIA_DIR, exist_ok=True)
ALLOWED_VIDEO_EXTENSIONS = { 'mp4', 'webm', 'ogg', 'mov' }
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB

# Конфигурация Email (Чтение из переменных окружения)
# ... (Настройки MAIL_SERVER, MAIL_PORT, MAIL_USERNAME, MAIL_PASSWORD) ...
app.config['MAIL_SERVER'] = os.environ.get('MAIL_SERVER')
try: 
    app.config['MAIL_PORT'] = int(os.environ.get('MAIL_PORT', 587))
except (ValueError, TypeError): 
    app.config['MAIL_PORT'] = 587

# Определяем TLS или SSL в зависимости от порта
mail_port = app.config['MAIL_PORT']
if mail_port == 465:
    # Порт 465 = SSL (Mail.ru, Gmail SSL)
    app.config['MAIL_USE_SSL'] = True
    app.config['MAIL_USE_TLS'] = False
else:
    # Порт 587 = TLS (Gmail, Яндекс)
    app.config['MAIL_USE_TLS'] = os.environ.get('MAIL_USE_TLS', 'True').lower() in ['true', '1', 't']
    app.config['MAIL_USE_SSL'] = False

app.config['MAIL_USERNAME'] = os.environ.get('MAIL_USERNAME')
app.config['MAIL_PASSWORD'] = os.environ.get('MAIL_PASSWORD')

if app.config['MAIL_USERNAME']:
    app.config['MAIL_DEFAULT_SENDER'] = ('GlassChat Team', app.config['MAIL_USERNAME'])

db = SQLAlchemy(app)
socketio = SocketIO(
    app,
    async_mode='threading',
    cors_allowed_origins='*',
    ping_timeout=25,
    ping_interval=15,
    allow_upgrades=False
)
s = URLSafeTimedSerializer(app.config['SECRET_KEY'])
mail = Mail(app)
IS_MAIL_CONFIGURED = bool(app.config.get('MAIL_SERVER') and app.config.get('MAIL_USERNAME'))

# --- Модели Базы Данных ---
class Contact(db.Model):
    __tablename__ = 'contact'
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), primary_key=True)
    contact_id = db.Column(db.Integer, db.ForeignKey('user.id'), primary_key=True)
    custom_name = db.Column(db.String(100), nullable=True)
    
    owner = db.relationship('User', foreign_keys=[user_id], backref='contact_list_entries')
    contact_user = db.relationship('User', foreign_keys=[contact_id])

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(256), nullable=False)
    is_verified = db.Column(db.Boolean, default=False, nullable=False)
    bio = db.Column(db.String(200), default="", nullable=True)
    theme = db.Column(db.String(20), default="dark", nullable=False)
    avatar_url = db.Column(db.String(256), nullable=True)

    rooms = db.relationship('RoomParticipant', backref='user', lazy='dynamic')

    def set_password(self, p): self.password_hash = generate_password_hash(p)
    def check_password(self, p): return check_password_hash(self.password_hash, p)

    def get_contact(self, contact_user):
        return Contact.query.filter_by(user_id=self.id, contact_id=contact_user.id).first()

    def add_contact(self, contact_user):
        if self.id != contact_user.id and not self.get_contact(contact_user):
            db.session.add(Contact(user_id=self.id, contact_id=contact_user.id))
            return True
        return False

    def to_dict_profile(self):
        return {'id': self.id, 'username': self.username, 'bio': self.bio}

    def get_contacts_data(self):
        contacts_data = []
        entries = Contact.query.filter_by(user_id=self.id).options(db.joinedload(Contact.contact_user)).all()
        for entry in entries:
            display_name = entry.custom_name or f"@{entry.contact_user.username}"
            contacts_data.append({
                'id': entry.contact_id,
                'username': entry.contact_user.username,
                'display_name': display_name
            })
        return sorted(contacts_data, key=lambda x: x['display_name'].lower())

class Room(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=True) 
    type = db.Column(db.String(10), nullable=False) # 'dm', 'group', 'channel'
    avatar_url = db.Column(db.String(256), nullable=True)
    
    participants = db.relationship('RoomParticipant', backref='room', lazy='dynamic')
    messages = db.relationship('Message', backref='room', lazy='dynamic')

    def get_room_data_for_user(self, current_user):
        display_name = self.name
        avatar = self.avatar_url
        role = 'member'
        dm_other_user_id = None

        current_participant = self.participants.filter(RoomParticipant.user_id == current_user.id).first()
        if current_participant:
            role = current_participant.role

        if self.type == 'dm':
            other_participant_entry = self.participants.filter(RoomParticipant.user_id != current_user.id).first()
            if other_participant_entry:
                dm_other_user_id = other_participant_entry.user_id
                contact_entry = current_user.get_contact(other_participant_entry.user)
                if contact_entry and contact_entry.custom_name:
                    display_name = contact_entry.custom_name
                else:
                    display_name = f"@{other_participant_entry.user.username}"
                # Для DM подменяем аватар на аватар собеседника, если он есть
                if other_participant_entry.user.avatar_url:
                    avatar = other_participant_entry.user.avatar_url
        
        # Получаем количество непрочитанных
        unread_entry = UnreadMessage.query.filter_by(user_id=current_user.id, room_id=self.id).first()
        unread_count = unread_entry.count if unread_entry else 0

        return display_name, role, avatar, dm_other_user_id, unread_count
        
    def to_dict(self, current_user):
        display_name, role, avatar, dm_other_user_id, unread_count = self.get_room_data_for_user(current_user)

        # Дополнительные данные для элемент-подобного интерфейса
        participants = RoomParticipant.query.filter_by(room_id=self.id).options(
            db.joinedload(RoomParticipant.user)
        ).all()
        member_count = len(participants)

        participant_preview = []
        verified_members = 0
        for participant in participants:
            user = participant.user
            if not user:
                continue

            if user.is_verified:
                verified_members += 1

            if user.id == current_user.id:
                display_handle = 'Вы'
            else:
                contact_entry = current_user.get_contact(user)
                if contact_entry and contact_entry.custom_name:
                    display_handle = contact_entry.custom_name
                else:
                    display_handle = f"@{user.username}"

            participant_preview.append({
                'id': user.id,
                'username': user.username,
                'display': display_handle,
                'avatar_url': user.avatar_url,
                'role': participant.role
            })

        latest_message = self.messages.order_by(Message.timestamp.desc()).first()
        last_activity_at = latest_message.timestamp.isoformat() if latest_message else None
        last_message_author = latest_message.sender.username if latest_message and latest_message.sender else None

        if latest_message:
            if latest_message.message_type == 'system':
                last_message_preview = 'Системное обновление'
            elif latest_message.message_type == 'call':
                duration = latest_message.call_duration or ''
                last_message_preview = f"Звонок завершен {duration}".strip()
            else:
                payload = (latest_message.content or '').strip()
                last_message_preview = payload[:140] if payload else 'Медиа вложение'
        else:
            last_message_preview = 'Будьте первым, кто напишет сообщение'

        if self.type == 'dm':
            topic = 'Личная переписка и быстрые реакции'
        elif self.type == 'group':
            topic = f'Групповой чат на {member_count} участников'
        else:
            topic = 'Новости и трансляции для подписчиков'

        is_encrypted = self.type != 'channel'
        encryption_label = 'Сквозное шифрование включено' if is_encrypted else 'Трансляция без end-to-end шифрования'

        accent_palette = [
            '#0DBD8B', '#43A1FF', '#FF9F1A', '#F45D7E', '#00B5D6', '#7B61FF', '#3BB273', '#FFB000'
        ]
        accent_color = accent_palette[self.id % len(accent_palette)]

        call_features = {
            'video': True,
            'audio': True,
            'screenshare': self.type != 'channel',
            'recording': role in ('admin', 'owner')
        }

        notification_mode = 'all'
        if self.type == 'channel' and role != 'admin':
            notification_mode = 'mentions'

        tags = []
        if is_encrypted:
            tags.append('E2EE')
        if member_count > 8:
            tags.append('Team')
        if role in ('admin', 'owner'):
            tags.append('Moderator')

        presence_summary = {
            'online_count': verified_members or member_count,
            'total': member_count
        }

        return {
            'id': self.id,
            'name': display_name,
            'type': self.type,
            'role': role,
            'avatar_url': avatar,
            'dm_other_user_id': dm_other_user_id,
            'unread_count': unread_count,
            'member_count': member_count,
            'participant_preview': participant_preview,
            'topic': topic,
            'is_encrypted': is_encrypted,
            'encryption_label': encryption_label,
            'accent_color': accent_color,
            'call_features': call_features,
            'notification_mode': notification_mode,
            'tags': tags,
            'presence_summary': presence_summary,
            'last_activity_at': last_activity_at,
            'last_message_preview': last_message_preview,
            'last_message_author': last_message_author
        }

class RoomParticipant(db.Model):
    __tablename__ = 'room_participant'
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), primary_key=True)
    room_id = db.Column(db.Integer, db.ForeignKey('room.id'), primary_key=True)
    role = db.Column(db.String(10), default='member', nullable=False)
    is_archived = db.Column(db.Boolean, default=False, nullable=False)  # Архивирован ли чат для этого пользователя

class Message(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    room_id = db.Column(db.Integer, db.ForeignKey('room.id'), nullable=False)
    sender_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True)  # Может быть null для системных
    content = db.Column(db.Text, nullable=True)  # Теперь может быть пустым если есть медиа
    timestamp = db.Column(db.DateTime, index=True, default=datetime.now)
    media_url = db.Column(db.String(512), nullable=True)
    media_type = db.Column(db.String(20), nullable=True)  # 'image', 'video', 'system', 'call'
    message_type = db.Column(db.String(20), default='text', nullable=False)  # 'text', 'system', 'call'
    call_duration = db.Column(db.String(10), nullable=True)  # Для карточек звонков
    thread_root_id = db.Column(db.Integer, db.ForeignKey('message.id'), nullable=True)
    thread_type = db.Column(db.String(20), nullable=True)

    sender = db.relationship('User', foreign_keys=[sender_id])
    reactions = db.relationship('MessageReaction', backref='message', lazy='dynamic', cascade="all, delete-orphan")
    media_items = db.relationship('MessageMedia', backref='message', lazy='dynamic', cascade="all, delete-orphan")

    def get_reactions_summary(self):
        summary = {}
        for reaction in self.reactions.all():
            if reaction.emoji not in summary:
                summary[reaction.emoji] = []
            summary[reaction.emoji].append(reaction.user_id)
        return summary

    def to_dict(self):
        result = {
            'id': self.id, 
            'room_id': self.room_id, 
            'sender_id': self.sender_id,
            'sender_username': self.sender.username if self.sender else 'System',
            'content': self.content or '',
            'timestamp': self.timestamp.isoformat(),
            'message_type': self.message_type,
            'reactions': self.get_reactions_summary(),
            'media_items': [item.to_dict() for item in self.media_items]
        }
        if self.media_url:
            result['media_url'] = self.media_url
            result['media_type'] = self.media_type
        if self.call_duration:
            result['call_duration'] = self.call_duration
        if self.thread_root_id:
            result['thread_root_id'] = self.thread_root_id
        if self.thread_type:
            result['thread_type'] = self.thread_type
        # Встраиваем текущие результаты для опросов
        if self.message_type == 'poll':
            try:
                payload = json.loads(self.content or '{}')
                question = payload.get('question', '')
                options = payload.get('options', [])
                multiple_choice = bool(payload.get('multiple_choice'))
                anonymous = bool(payload.get('anonymous'))
                # Подсчет результатов
                results = []
                try:
                    total_options = len(options)
                    for idx in range(total_options):
                        results.append(db.session.execute(db.select(db.func.count()).select_from(PollVote).where(PollVote.message_id == self.id, PollVote.option_index == idx)).scalar() or 0)
                except Exception:
                    results = [0 for _ in options]
                result['poll'] = {
                    'question': question,
                    'options': options,
                    'multiple_choice': multiple_choice,
                    'anonymous': anonymous,
                    'results': results
                }
            except Exception:
                pass
        if not self.thread_root_id and self.message_type != 'poll_comment':
            try:
                count_stmt = db.select(db.func.count()).select_from(Message).where(Message.thread_root_id == self.id)
                result['thread_comment_count'] = db.session.execute(count_stmt).scalar() or 0
            except Exception:
                result['thread_comment_count'] = 0
        return result

class MessageReaction(db.Model):
    __tablename__ = 'message_reaction'
    message_id = db.Column(db.Integer, db.ForeignKey('message.id'), primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), primary_key=True)
    emoji = db.Column(db.String(10), primary_key=True)

class MessageMedia(db.Model):
    __tablename__ = 'message_media'
    id = db.Column(db.Integer, primary_key=True)
    message_id = db.Column(db.Integer, db.ForeignKey('message.id'), nullable=False)
    url = db.Column(db.String(512), nullable=False)
    type = db.Column(db.String(20), nullable=False)  # 'image', 'video' или 'file'

    def to_dict(self):
        result = {'url': self.url, 'type': self.type}

        try:
            filename = os.path.basename(self.url or '')
        except Exception:
            filename = ''

        if filename:
            # Имя файла сохраняется в формате m{user}_{timestamp}_{original}
            if filename.count('_') >= 2:
                result['name'] = filename.split('_', 2)[-1]
            else:
                result['name'] = filename

        media_path = (self.url or '').lstrip('/')
        if media_path:
            full_path = os.path.join(BASE_DIR, media_path)
            try:
                result['size'] = os.path.getsize(full_path)
            except OSError:
                pass

        return result

class BlockedUser(db.Model):
    __tablename__ = 'blocked_user'
    blocker_id = db.Column(db.Integer, db.ForeignKey('user.id'), primary_key=True)
    blocked_id = db.Column(db.Integer, db.ForeignKey('user.id'), primary_key=True)

class UnreadMessage(db.Model):
    __tablename__ = 'unread_message'
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), primary_key=True)
    room_id = db.Column(db.Integer, db.ForeignKey('room.id'), primary_key=True)
    count = db.Column(db.Integer, default=0, nullable=False)

# Голоса для опросов
class PollVote(db.Model):
    __tablename__ = 'poll_vote'
    id = db.Column(db.Integer, primary_key=True)
    message_id = db.Column(db.Integer, db.ForeignKey('message.id'), index=True, nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), index=True, nullable=False)
    option_index = db.Column(db.Integer, nullable=False)
    __table_args__ = (db.UniqueConstraint('message_id', 'user_id', 'option_index', name='uq_poll_vote_msg_user_opt'),)

# --- Вспомогательные функции ---
ONLINE_USERS = set()
SID_TO_USER = {}
def notify_user_about_new_room(user, room):
    room_data = room.to_dict(user)
    socketio.emit('new_room', room_data, room=f"user_{user.id}")

def notify_room_update(room):
     participants = room.participants.all()
     for participant in participants:
         user = db.session.get(User, participant.user_id)
         room_data = room.to_dict(user)
         socketio.emit('room_updated', room_data, room=f"user_{participant.user_id}")

def find_or_create_dm_room(user1, user2):
    room = Room.query.filter_by(type='dm').filter(
        Room.participants.any(user_id=user1.id)
    ).filter(
        Room.participants.any(user_id=user2.id)
    ).first()

    is_new_room = False
    if not room:
        is_new_room = True
        room = Room(type='dm')
        db.session.add(room)
        db.session.add(RoomParticipant(user_id=user1.id, room=room))
        db.session.add(RoomParticipant(user_id=user2.id, room=room))
    
    user1.add_contact(user2)
    user2.add_contact(user1)

    db.session.commit()

    if is_new_room:
        notify_user_about_new_room(user1, room)
        notify_user_about_new_room(user2, room)
        
    return room

def send_verification_email(user):
    token = s.dumps(user.email, salt='email-confirm')
    confirm_url = url_for('confirm_email', token=token, _external=True)
    
    subject = "Подтвердите ваш Email - GlassChat"
    body = f"Привет, {user.username}!\n\nПерейдите по ссылке для активации:\n{confirm_url}"

    msg = MailMessage(subject=subject, recipients=[user.email], body=body, charset='utf-8')
    
    if not IS_MAIL_CONFIGURED:
        print(f"\n--- EMAIL (Отладка: SMTP не настроен) ---")
        print(f"Получатель: {user.email}")
        print(f"Пользователь: {user.username}")
        print(f"Ссылка подтверждения: {confirm_url}")
        print(f"---\n")
        return False

    try:
        print(f"\n[EMAIL] Отправка письма на {user.email}...")
        mail.send(msg)
        print(f"[EMAIL] ✅ Успешно отправлено на {user.email}")
        return True
    except Exception as e:
        print(f"\n--- ОШИБКА ОТПРАВКИ EMAIL ---")
        print(f"Получатель: {user.email}")
        print(f"Ошибка: {e}")
        print(f"Тип ошибки: {type(e).__name__}")
        print(f"Ссылка для ручного использования: {confirm_url}")
        print(f"---\n")
        return False

def send_password_reset_email(user):
    token = s.dumps(user.email, salt='password-reset')
    reset_url = url_for('reset_password_page', token=token, _external=True)
    
    subject = "Восстановление пароля - GlassChat"
    body = f"""Привет, {user.username}!

Вы запросили восстановление пароля.

Перейдите по ссылке для установки нового пароля:
{reset_url}

Если вы не запрашивали восстановление пароля, просто игнорируйте это письмо.

Ссылка действительна в течение 1 часа.

С уважением,
Команда GlassChat"""

    msg = MailMessage(subject=subject, recipients=[user.email], body=body, charset='utf-8')
    
    if not IS_MAIL_CONFIGURED:
        print(f"\n--- EMAIL (Отладка: SMTP не настроен) ---")
        print(f"Получатель: {user.email}")
        print(f"Пользователь: {user.username}")
        print(f"Ссылка сброса: {reset_url}")
        print(f"---\n")
        return False

    try:
        print(f"\n[EMAIL] Отправка письма на {user.email}...")
        mail.send(msg)
        print(f"[EMAIL] ✅ Успешно отправлено на {user.email}")
        return True
    except Exception as e:
        print(f"\n--- ОШИБКА ОТПРАВКИ EMAIL ---")
        print(f"Получатель: {user.email}")
        print(f"Ошибка: {e}")
        print(f"Тип ошибки: {type(e).__name__}")
        print(f"Ссылка для ручного использования: {reset_url}")
        print(f"---\n")
        return False

# --- Маршруты (Routes) и API ---
@app.route('/')
def index():
    if 'user_id' in session:
        user = db.session.get(User, session['user_id'])
        if user and user.is_verified:
            user_contacts_data = user.get_contacts_data()
            participant_entries = user.rooms.options(db.joinedload(RoomParticipant.room)).all()
            
            # Разделяем на обычные и архивированные чаты
            active_rooms = []
            archived_rooms = []
            for entry in participant_entries:
                room_dict = entry.room.to_dict(user)
                if entry.is_archived:
                    archived_rooms.append(room_dict)
                else:
                    active_rooms.append(room_dict)
            
            sfu_url = os.environ.get('SFU_URL')
            return render_template('index.html', user=user, contacts=user_contacts_data, 
                                 rooms=active_rooms, archived_rooms=archived_rooms, sfu_url=sfu_url)
    return redirect(url_for('auth'))
# ... (Auth, Logout, Confirm, Register, Login API)
@app.route('/auth')
def auth():
    if 'user_id' in session:
        user = db.session.get(User, session['user_id'])
        if user and user.is_verified:
             return redirect(url_for('index'))
    return render_template('auth.html')

@app.route('/logout')
def logout():
    session.pop('user_id', None)
    return redirect(url_for('auth'))

@app.route('/confirm_email/<token>')
def confirm_email(token):
    try:
        email = s.loads(token, salt='email-confirm', max_age=3600)
    except Exception:
        return '<h1>Ошибка</h1><p>Ссылка недействительна или истекла.</p>', 400
    user = User.query.filter_by(email=email).first_or_404()
    if not user.is_verified:
        user.is_verified = True
        db.session.commit()
    return redirect(url_for('auth'))

@app.route('/api/register', methods=['POST'])
def register():
    data = request.get_json()
    username = data.get('username', '').lower().strip()
    email = data.get('email')
    password = data.get('password')

    if not username or not email or not password:
        return jsonify({'success': False, 'message': 'Заполните все поля'}), 400
    if '@' in username:
         return jsonify({'success': False, 'message': 'Имя не должно содержать @'}), 400
    if User.query.filter((User.username == username) | (User.email == email)).first():
        return jsonify({'success': False, 'message': 'Имя или Email заняты'}), 409

    new_user = User(username=username, email=email)
    new_user.set_password(password)
    db.session.add(new_user)
    db.session.commit()
    
    email_sent = send_verification_email(new_user)
    
    message = 'Регистрация успешна! '
    if email_sent:
        message += 'Проверьте вашу почту для подтверждения.'
    else:
        message += 'Не удалось отправить Email (проверьте настройки SMTP или консоль сервера).'

    return jsonify({'success': True, 'message': message}), 201

@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json()
    identifier = data.get('identifier', '').lower().strip()
    password = data.get('password')
    if identifier.startswith('@'):
        identifier = identifier[1:]

    user = User.query.filter(
        (User.username == identifier) | (User.email == identifier)
    ).first()

    if user and user.check_password(password):
        if not user.is_verified:
            return jsonify({'success': False, 'message': 'Пожалуйста, подтвердите ваш email.'}), 403
            
        session['user_id'] = user.id
        return jsonify({'success': True, 'message': 'Вход выполнен'})
    else:
        return jsonify({'success': False, 'message': 'Неверный логин или пароль'}), 401

@app.route('/api/forgot_password', methods=['POST'])
def forgot_password():
    data = request.get_json()
    email = data.get('email', '').strip()
    
    if not email:
        return jsonify({'success': False, 'message': 'Введите email'}), 400
    
    user = User.query.filter_by(email=email).first()
    
    # Всегда возвращаем успех для безопасности (не раскрываем существование email)
    if user:
        email_sent = send_password_reset_email(user)
        if email_sent:
            message = 'Письмо с инструкциями отправлено на вашу почту.'
        else:
            message = 'Email отправлен (проверьте консоль сервера для ссылки).'
    else:
        message = 'Если этот email зарегистрирован, письмо будет отправлено.'
    
    return jsonify({'success': True, 'message': message})

@app.route('/reset_password/<token>')
def reset_password_page(token):
    try:
        email = s.loads(token, salt='password-reset', max_age=3600)  # 1 час
    except:
        return render_template('auth.html', error='Ссылка недействительна или истекла.')
    
    return render_template('reset_password.html', token=token)

@app.route('/api/reset_password', methods=['POST'])
def reset_password():
    data = request.get_json()
    token = data.get('token')
    new_password = data.get('password')
    
    if not token or not new_password:
        return jsonify({'success': False, 'message': 'Неверные данные'}), 400
    
    try:
        email = s.loads(token, salt='password-reset', max_age=3600)
    except:
        return jsonify({'success': False, 'message': 'Ссылка недействительна или истекла'}), 400
    
    user = User.query.filter_by(email=email).first()
    if not user:
        return jsonify({'success': False, 'message': 'Пользователь не найден'}), 404
    
    user.set_password(new_password)
    db.session.commit()
    
    return jsonify({'success': True, 'message': 'Пароль успешно изменен!'})

# --- ICE/TURN конфигурация ---
@app.route('/api/ice', methods=['GET'])
def get_ice_servers():
    # STUN-only: TURN отключен
    ice_servers = [
        { 'urls': ['stun:stun.l.google.com:19302'] },
        { 'urls': ['stun:stun1.l.google.com:19302'] },
        { 'urls': ['stun:stun2.l.google.com:19302'] },
        { 'urls': ['stun:stun3.l.google.com:19302'] },
        { 'urls': ['stun:stun4.l.google.com:19302'] },
        { 'urls': ['stun:stun.services.mozilla.com:3478'] },
        { 'urls': ['stun:stun.stunprotocol.org:3478'] },
    ]

    return jsonify({ 'iceServers': ice_servers })

# --- ОПРОСЫ ---
@socketio.on('send_poll')
def handle_send_poll(data):
    if 'user_id' not in session: return
    sender_id = session['user_id']
    room_id = data.get('room_id')
    question = (data.get('question') or '').strip()
    options = data.get('options') or []
    multiple_choice = bool(data.get('multiple_choice'))
    anonymous = bool(data.get('anonymous'))
    if not room_id or not question or not isinstance(options, list) or len(options) < 2:
        return
    if not RoomParticipant.query.filter_by(user_id=sender_id, room_id=room_id).first():
        return
    # Формируем JSON контент опроса
    payload = {
        'question': question,
        'options': [str(o)[:100] for o in options if str(o).strip()],
        'multiple_choice': multiple_choice,
        'anonymous': anonymous
    }
    new_message = Message(
        room_id=room_id,
        sender_id=sender_id,
        content=json.dumps(payload, ensure_ascii=False),
        message_type='poll'
    )
    db.session.add(new_message)
    db.session.commit()
    socketio.emit('receive_message', new_message.to_dict(), room=str(room_id))

@socketio.on('vote_poll')
def handle_vote_poll(data):
    if 'user_id' not in session: return
    user_id = session['user_id']
    message_id = data.get('message_id')
    selected = data.get('selected')  # int или список int
    if not message_id: return
    message = db.session.get(Message, message_id)
    if not message or message.message_type != 'poll': return
    if not RoomParticipant.query.filter_by(user_id=user_id, room_id=message.room_id).first():
        return
    try:
        payload = json.loads(message.content or '{}')
        options = payload.get('options', [])
        multiple_choice = bool(payload.get('multiple_choice'))
    except Exception:
        return
    # Нормализуем выбранные индексы
    if multiple_choice:
        if not isinstance(selected, list):
            return
        indices = sorted(set(int(i) for i in selected if isinstance(i, int)))
    else:
        try:
            indices = [int(selected)]
        except Exception:
            return
    # Ограничиваем диапазон
    indices = [i for i in indices if 0 <= i < len(options)]
    if not indices:
        return
    existing_votes = PollVote.query.filter_by(message_id=message_id, user_id=user_id).all()
    existing_indices = [vote.option_index for vote in existing_votes]

    if not multiple_choice and existing_indices:
        emit('poll_vote_ack', {
            'message_id': message_id,
            'selected': existing_indices,
            'locked': True
        }, room=f"user_{user_id}")
        return

    added = False
    if not multiple_choice:
        # Для одиночного выбора учитываем только первый индекс
        idx = indices[0]
        db.session.add(PollVote(message_id=message_id, user_id=user_id, option_index=idx))
        added = True
    else:
        for idx in indices:
            if not PollVote.query.filter_by(message_id=message_id, user_id=user_id, option_index=idx).first():
                db.session.add(PollVote(message_id=message_id, user_id=user_id, option_index=idx))
                added = True

    if added:
        db.session.commit()

    user_votes = PollVote.query.filter_by(message_id=message_id, user_id=user_id).all()
    selected_indices = sorted(vote.option_index for vote in user_votes)

    emit('poll_vote_ack', {
        'message_id': message_id,
        'selected': selected_indices,
        'locked': (not multiple_choice) and len(selected_indices) > 0
    }, room=f"user_{user_id}")

    if added:
        socketio.emit('poll_updated', {'message_id': message_id, 'poll': message.to_dict().get('poll')}, room=str(message.room_id))

@app.route('/api/poll_vote/<int:message_id>', methods=['GET'])
def get_poll_vote(message_id):
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401

    user_id = session['user_id']
    message = db.session.get(Message, message_id)
    if not message or message.message_type != 'poll':
        return jsonify({'success': False, 'selected': []}), 404

    if not RoomParticipant.query.filter_by(user_id=user_id, room_id=message.room_id).first():
        return jsonify({'error': 'Access denied'}), 403

    votes = PollVote.query.filter_by(message_id=message_id, user_id=user_id).all()
    selected = sorted(vote.option_index for vote in votes)
    return jsonify({'success': True, 'selected': selected})


@app.route('/api/thread/<int:message_id>', methods=['GET'])
def get_thread(message_id):
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401

    user_id = session['user_id']
    root_message = db.session.get(Message, message_id)
    if not root_message:
        return jsonify({'success': False, 'message': 'Сообщение не найдено'}), 404

    participant = RoomParticipant.query.filter_by(user_id=user_id, room_id=root_message.room_id).first()
    if not participant:
        return jsonify({'error': 'Forbidden'}), 403

    comments = Message.query.filter_by(room_id=root_message.room_id, thread_root_id=message_id).order_by(Message.timestamp.asc()).all()
    return jsonify({
        'success': True,
        'thread': root_message.to_dict(),
        'comments': [comment.to_dict() for comment in comments]
    })
# --- API Блокировок и Контактов (неизвестные/запросы) ---
@app.route('/api/block_user', methods=['POST'])
def block_user():
    if 'user_id' not in session: return jsonify({'error': 'Unauthorized'}), 401
    data = request.get_json(); target_id = data.get('user_id')
    user_id = session['user_id']
    if not target_id or target_id == user_id: return jsonify({'success': False}), 400
    if not db.session.get(User, target_id): return jsonify({'success': False}), 404
    if not BlockedUser.query.filter_by(blocker_id=user_id, blocked_id=target_id).first():
        db.session.add(BlockedUser(blocker_id=user_id, blocked_id=target_id))
        db.session.commit()
    return jsonify({'success': True, 'message': 'Пользователь заблокирован.'})

@app.route('/api/unblock_user', methods=['POST'])
def unblock_user():
    if 'user_id' not in session: return jsonify({'error': 'Unauthorized'}), 401
    data = request.get_json(); target_id = data.get('user_id')
    user_id = session['user_id']
    BlockedUser.query.filter_by(blocker_id=user_id, blocked_id=target_id).delete()
    db.session.commit()
    return jsonify({'success': True})
# --- API Чата и Комнат ---
@app.route('/api/chat_history/<int:room_id>', methods=['GET'])
def chat_history(room_id):
    if 'user_id' not in session: return jsonify({'error': 'Unauthorized'}), 401
    user_id = session['user_id']
    if not RoomParticipant.query.filter_by(user_id=user_id, room_id=room_id).first():
        return jsonify({'error': 'Access denied'}), 403
    # Если это dm и один из участников заблокирован — сообщения не показываем
    room = db.session.get(Room, room_id)
    if room and room.type == 'dm':
        other_participant_entry = room.participants.filter(RoomParticipant.user_id != user_id).first()
        if other_participant_entry:
            other_id = other_participant_entry.user_id
            if BlockedUser.query.filter_by(blocker_id=user_id, blocked_id=other_id).first():
                return jsonify([])
    messages = (Message.query
                .filter(Message.room_id == room_id, Message.message_type.notin_(['poll_comment', 'comment']))
                .order_by(Message.timestamp.asc())
                .limit(100)
                .all())
    return jsonify([message.to_dict() for message in messages])

@app.route('/api/room_members/<int:room_id>', methods=['GET'])
def room_members(room_id):
    if 'user_id' not in session: return jsonify({'error': 'Unauthorized'}), 401
    # Проверяем, что текущий пользователь состоит в комнате
    if not RoomParticipant.query.filter_by(user_id=session['user_id'], room_id=room_id).first():
        return jsonify({'error': 'Access denied'}), 403
    participants = RoomParticipant.query.filter_by(room_id=room_id).all()
    result = []
    for p in participants:
        user = db.session.get(User, p.user_id)
        if user:
            result.append({'id': user.id, 'username': user.username, 'role': p.role})
    return jsonify({'success': True, 'members': result})

@app.route('/api/create_room', methods=['POST'])
def create_room():
    if 'user_id' not in session: return jsonify({'error': 'Unauthorized'}), 401
    user = db.session.get(User, session['user_id']); data = request.get_json()
    room_name = data.get('name', '').strip(); room_type = data.get('type'); member_ids = data.get('members', [])
    
    if not room_name or room_type not in ['group', 'channel']:
        return jsonify({'success': False, 'message': 'Неверные данные.'}), 400
        
    new_room = Room(name=room_name, type=room_type); db.session.add(new_room)
    db.session.add(RoomParticipant(user_id=user.id, room=new_room, role='admin'))
    
    added_users = []
    for member_id in member_ids:
        contact_user = db.session.get(User, member_id)
        if contact_user and user.get_contact(contact_user):
             db.session.add(RoomParticipant(user_id=member_id, room=new_room, role='member'))
             added_users.append(contact_user)

    db.session.commit()
    
    for added_user in added_users:
        notify_user_about_new_room(added_user, new_room)

    return jsonify({'success': True, 'room': new_room.to_dict(user)}), 201

@app.route('/api/update_room', methods=['POST'])
def update_room():
    if 'user_id' not in session: return jsonify({'error': 'Unauthorized'}), 401
    user_id = session['user_id']; data = request.get_json()
    room_id = data.get('room_id'); new_name = data.get('name', '').strip()
    new_avatar = data.get('avatar_url', '').strip()

    participant = RoomParticipant.query.filter_by(user_id=user_id, room_id=room_id).first()
    if not participant or participant.role != 'admin':
        return jsonify({'success': False, 'message': 'Только администратор может изменять настройки.'}), 403
    
    room = participant.room
    if room.type == 'dm': return jsonify({'success': False}), 400

    if not new_name or len(new_name) < 3:
        return jsonify({'success': False, 'message': 'Название слишком короткое.'}), 400

    room.name = new_name

    if new_avatar.startswith('http://') or new_avatar.startswith('https://'):
        room.avatar_url = new_avatar
    elif not new_avatar:
        room.avatar_url = None

    db.session.commit()
    
    notify_room_update(room)
    
    return jsonify({'success': True, 'message': 'Настройки обновлены.'})

@app.route('/api/add_room_members', methods=['POST'])
def add_room_members():
    if 'user_id' not in session: return jsonify({'error': 'Unauthorized'}), 401
    user = db.session.get(User, session['user_id']); data = request.get_json()
    room_id = data.get('room_id'); member_ids = data.get('members', [])

    participant = RoomParticipant.query.filter_by(user_id=user.id, room_id=room_id).first()
    if not participant or participant.role != 'admin':
        return jsonify({'success': False, 'message': 'Только администратор может добавлять участников.'}), 403
    
    room = participant.room
    if room.type == 'dm': return jsonify({'success': False}), 400

    added_count = 0; added_users = []
    for member_id in member_ids:
        member_user = db.session.get(User, member_id)
        if member_user and user.get_contact(member_user):
            if not RoomParticipant.query.filter_by(user_id=member_id, room_id=room_id).first():
                db.session.add(RoomParticipant(user_id=member_id, room_id=room_id, role='member'))
                added_count += 1
                added_users.append(member_user)

    db.session.commit()
    
    if added_count > 0:
        for added_user in added_users:
             notify_user_about_new_room(added_user, room)

    return jsonify({'success': True, 'message': f'Добавлено участников: {added_count}.'})

@app.route('/api/manage_room_member', methods=['POST'])
def manage_room_member():
    if 'user_id' not in session: return jsonify({'error': 'Unauthorized'}), 401
    
    current_user_id = session['user_id']
    data = request.get_json()
    room_id = data.get('room_id')
    target_user_id = data.get('target_user_id')
    action = data.get('action') # 'promote', 'demote', 'remove'

    if not all([room_id, target_user_id, action]) or action not in ['promote', 'demote', 'remove']:
        return jsonify({'success': False, 'message': 'Неверные данные запроса.'}), 400

    if current_user_id == target_user_id:
        return jsonify({'success': False, 'message': 'Вы не можете управлять собой.'}), 403

    # Проверяем, что текущий пользователь - админ комнаты
    current_participant = RoomParticipant.query.filter_by(user_id=current_user_id, room_id=room_id).first()
    if not current_participant or current_participant.role != 'admin':
        return jsonify({'success': False, 'message': 'Только администратор может управлять участниками.'}), 403

    # Находим целевого участника
    target_participant = RoomParticipant.query.filter_by(user_id=target_user_id, room_id=room_id).first()
    if not target_participant:
        return jsonify({'success': False, 'message': 'Участник не найден в этой комнате.'}), 404

    message = ''
    if action == 'promote':
        target_participant.role = 'admin'
        message = 'Участник повышен до администратора.'
    elif action == 'demote':
        target_participant.role = 'member'
        message = 'Администратор понижен до участника.'
    elif action == 'remove':
        db.session.delete(target_participant)
        message = 'Участник удален из комнаты.'

    db.session.commit()

    # Оповещаем всех в комнате об изменениях
    participants = RoomParticipant.query.filter_by(room_id=room_id).all()
    members_data = [{'id': p.user.id, 'username': p.user.username, 'role': p.role} for p in participants]
    socketio.emit('member_list_updated', {'room_id': room_id, 'members': members_data}, room=str(room_id))

    # Если пользователя удалили, ему нужно отправить отдельное событие
    if action == 'remove':
        socketio.emit('removed_from_room', {'room_id': room_id}, room=f"user_{target_user_id}")

    return jsonify({'success': True, 'message': message})

@app.route('/api/delete_room', methods=['POST'])
def delete_room():
    if 'user_id' not in session: return jsonify({'error': 'Unauthorized'}), 401
    
    current_user_id = session['user_id']
    data = request.get_json()
    room_id = data.get('room_id')

    if not room_id:
        return jsonify({'success': False, 'message': 'Не указан ID комнаты.'}), 400

    participant = RoomParticipant.query.filter_by(user_id=current_user_id, room_id=room_id).first()
    if not participant or participant.role != 'admin':
        return jsonify({'success': False, 'message': 'Только администратор может удалить комнату.'}), 403
        
    room = db.session.get(Room, room_id)
    if not room:
        return jsonify({'success': False, 'message': 'Комната не найдена.'}), 404

    # Оповещаем всех участников об удалении
    participant_ids = [p.user_id for p in room.participants]
    socketio.emit('room_deleted', {'room_id': room_id, 'room_name': room.name}, room=str(room_id))
    
    # Удаляем все связанные сущности: сообщения, реакции, участники
    MessageReaction.query.join(Message).filter(Message.room_id == room_id).delete(synchronize_session=False)
    MessageMedia.query.join(Message).filter(Message.room_id == room_id).delete(synchronize_session=False)
    Message.query.filter_by(room_id=room_id).delete()
    RoomParticipant.query.filter_by(room_id=room_id).delete()
    
    # Наконец, удаляем саму комнату
    db.session.delete(room)
    db.session.commit()
    
    # Закрываем комнаты у всех пользователей
    for user_id in participant_ids:
        socketio.close_room(str(room_id))

    return jsonify({'success': True, 'message': f'Комната "{room.name}" успешно удалена.'})

# --- API Поиска и Контактов ---
@app.route('/api/search_user', methods=['GET'])
def search_user():
    if 'user_id' not in session: return jsonify({'error': 'Unauthorized'}), 401
    query = request.args.get('q', '').lower().strip()
    if query.startswith('@'): query = query[1:]

    if not query or len(query) < 3:
         return jsonify({'success': False, 'message': 'Запрос должен быть длиннее 2 символов.'})

    results = User.query.filter(
        User.username.ilike(f'%{query}%'),
        User.is_verified == True,
        User.id != session['user_id']
    ).limit(10).all()
    
    if not results: return jsonify({'success': False, 'message': 'Пользователь не найден.'})
        
    return jsonify({'success': True, 'results': [user.to_dict_profile() for user in results]})

@app.route('/api/user/<int:user_id>', methods=['GET'])
def get_user(user_id):
    """Получить информацию о пользователе (для аватарки и т.д.)"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Не авторизован'}), 401
    
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({'success': False, 'message': 'Пользователь не найден'}), 404
    
    return jsonify({
        'success': True,
        'user': {
            'id': user.id,
            'username': user.username,
            'avatar_url': user.avatar_url,
            'bio': user.bio
        }
    })

@app.route('/api/archive_chat', methods=['POST'])
def archive_chat():
    """Архивировать чат для текущего пользователя"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Не авторизован'}), 401
    
    data = request.get_json()
    room_id = data.get('room_id')
    
    if not room_id:
        return jsonify({'success': False, 'message': 'Не указан ID комнаты'}), 400
    
    # Находим запись участника
    participant = RoomParticipant.query.filter_by(
        user_id=session['user_id'], 
        room_id=room_id
    ).first()
    
    if not participant:
        return jsonify({'success': False, 'message': 'Вы не участник этой комнаты'}), 403
    
    # Архивируем
    participant.is_archived = True
    db.session.commit()
    
    return jsonify({'success': True, 'message': 'Чат архивирован'})

@app.route('/api/unarchive_chat', methods=['POST'])
def unarchive_chat():
    """Разархивировать чат для текущего пользователя"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Не авторизован'}), 401
    
    data = request.get_json()
    room_id = data.get('room_id')
    
    if not room_id:
        return jsonify({'success': False, 'message': 'Не указан ID комнаты'}), 400
    
    # Находим запись участника
    participant = RoomParticipant.query.filter_by(
        user_id=session['user_id'], 
        room_id=room_id
    ).first()
    
    if not participant:
        return jsonify({'success': False, 'message': 'Вы не участник этой комнаты'}), 403
    
    # Разархивируем
    participant.is_archived = False
    db.session.commit()
    
    return jsonify({'success': True, 'message': 'Чат разархивирован'})

@app.route('/api/start_dm', methods=['POST'])
def start_dm():
    if 'user_id' not in session: return jsonify({'error': 'Unauthorized'}), 401
    data = request.get_json(); contact_id = data.get('contact_id')
    current_user = db.session.get(User, session['user_id'])
    contact_user = db.session.get(User, contact_id)

    if not contact_user: return jsonify({'success': False, 'message': 'Неверный ID.'}), 400

    # Нельзя начинать ЛС если вы заблокировали пользователя
    if BlockedUser.query.filter_by(blocker_id=current_user.id, blocked_id=contact_id).first():
        return jsonify({'success': False, 'message': 'Пользователь заблокирован.'}), 403

    room = find_or_create_dm_room(current_user, contact_user)
    
    return jsonify({'success': True, 'room': room.to_dict(current_user)})

@app.route('/api/update_contact', methods=['POST'])
def update_contact():
    if 'user_id' not in session: return jsonify({'error': 'Unauthorized'}), 401
    user = db.session.get(User, session['user_id']); data = request.get_json()
    contact_id = data.get('contact_id')
    custom_name = data.get('custom_name', '').strip()

    contact_entry = Contact.query.filter_by(user_id=user.id, contact_id=contact_id).first()
    
    if not contact_entry:
        return jsonify({'success': False, 'message': 'Контакт не найден в вашем списке.'}), 404
        
    contact_entry.custom_name = custom_name if custom_name else None
    db.session.commit()
    
    room = Room.query.filter_by(type='dm').filter(
        Room.participants.any(user_id=user.id)
    ).filter(
        Room.participants.any(user_id=contact_id)
    ).first()
    
    if room:
        socketio.emit('room_updated', room.to_dict(user), room=f"user_{user.id}")

    return jsonify({'success': True, 'message': 'Контакт обновлен.'})

@app.route('/api/update_profile', methods=['POST'])
def update_profile():
    if 'user_id' not in session: return jsonify({'error': 'Unauthorized'}), 401
    user = db.session.get(User, session['user_id']); data = request.get_json()
    new_username = data.get('username', '').lower().strip()
    new_bio = data.get('bio', '').strip(); new_theme = data.get('theme', 'dark')

    if new_username != user.username:
        if not new_username or len(new_username) < 3 or '@' in new_username:
            return jsonify({'success': False, 'message': 'Некорректное имя пользователя.'}), 400
        if User.query.filter(User.username == new_username).first():
            return jsonify({'success': False, 'message': 'Это имя занято.'}), 409
        user.username = new_username

    user.bio = new_bio[:200]
    if new_theme in ['dark', 'light', 'ocean', 'amoled']: user.theme = new_theme

    db.session.commit()
    return jsonify({'success': True, 'message': 'Профиль обновлен.', 'username': user.username, 'theme': user.theme, 'bio': user.bio})

# --- Аватары пользователя ---
def _allowed_image(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_IMAGE_EXTENSIONS

@app.route('/api/upload_avatar', methods=['POST'])
def upload_avatar():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    if 'avatar' not in request.files:
        return jsonify({'success': False, 'message': 'Файл не найден.'}), 400
    file = request.files['avatar']
    if file.filename == '':
        return jsonify({'success': False, 'message': 'Имя файла пусто.'}), 400
    if not _allowed_image(file.filename):
        return jsonify({'success': False, 'message': 'Недопустимый формат изображения.'}), 400

    filename = secure_filename(file.filename)
    name_base, ext = os.path.splitext(filename)
    unique_name = f"u{session['user_id']}_{int(time.time())}{ext.lower()}"
    save_path = os.path.join(UPLOAD_AVATAR_DIR, unique_name)
    try:
        file.save(save_path)
    except Exception:
        return jsonify({'success': False, 'message': 'Не удалось сохранить файл.'}), 500

    user = db.session.get(User, session['user_id'])
    # Удаляем предыдущий файл (если загружался через наше API)
    try:
        if user.avatar_url and user.avatar_url.startswith('/static/uploads/avatars/'):
            old_path = user.avatar_url.lstrip('/')
            if os.path.exists(old_path):
                os.remove(old_path)
    except Exception:
        pass

    user.avatar_url = f"/static/uploads/avatars/{unique_name}"
    db.session.commit()

    # Обновляем DM-комнаты для отображения нового аватара у собеседников
    participant_entries = user.rooms.options(db.joinedload(RoomParticipant.room)).all()
    for entry in participant_entries:
        if entry.room.type == 'dm':
            notify_room_update(entry.room)

    return jsonify({'success': True, 'avatar_url': user.avatar_url})

@app.route('/api/remove_avatar', methods=['POST'])
def remove_avatar():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    user = db.session.get(User, session['user_id'])
    try:
        if user.avatar_url and user.avatar_url.startswith('/static/uploads/avatars/'):
            old_path = user.avatar_url.lstrip('/')
            if os.path.exists(old_path):
                os.remove(old_path)
    except Exception:
        pass
    user.avatar_url = None
    db.session.commit()

    participant_entries = user.rooms.options(db.joinedload(RoomParticipant.room)).all()
    for entry in participant_entries:
        if entry.room.type == 'dm':
            notify_room_update(entry.room)
    return jsonify({'success': True})

# --- Аватары комнат (групп и каналов) ---
@app.route('/api/upload_room_avatar', methods=['POST'])
def upload_room_avatar():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    if 'avatar' not in request.files:
        return jsonify({'success': False, 'message': 'Файл не найден.'}), 400
    
    room_id = request.form.get('room_id')
    if not room_id:
        return jsonify({'success': False, 'message': 'ID комнаты не указан.'}), 400
    
    try:
        room_id = int(room_id)
    except:
        return jsonify({'success': False, 'message': 'Некорректный ID комнаты.'}), 400
    
    # Проверяем права доступа - только админ может менять аватар
    participant = RoomParticipant.query.filter_by(user_id=session['user_id'], room_id=room_id).first()
    if not participant or participant.role != 'admin':
        return jsonify({'success': False, 'message': 'Только администратор может изменять аватар комнаты.'}), 403
    
    room = db.session.get(Room, room_id)
    if not room or room.type == 'dm':
        return jsonify({'success': False, 'message': 'Комната не найдена или это личный чат.'}), 404
    
    file = request.files['avatar']
    if file.filename == '':
        return jsonify({'success': False, 'message': 'Имя файла пусто.'}), 400
    if not _allowed_image(file.filename):
        return jsonify({'success': False, 'message': 'Недопустимый формат изображения.'}), 400

    filename = secure_filename(file.filename)
    name_base, ext = os.path.splitext(filename)
    unique_name = f"room{room_id}_{int(time.time())}{ext.lower()}"
    save_path = os.path.join(UPLOAD_AVATAR_DIR, unique_name)
    
    try:
        file.save(save_path)
    except Exception:
        return jsonify({'success': False, 'message': 'Не удалось сохранить файл.'}), 500

    # Удаляем предыдущий файл аватара
    try:
        if room.avatar_url and room.avatar_url.startswith('/static/uploads/avatars/'):
            old_path = room.avatar_url.lstrip('/')
            if os.path.exists(old_path):
                os.remove(old_path)
    except Exception:
        pass

    room.avatar_url = f"/static/uploads/avatars/{unique_name}"
    db.session.commit()

    # Уведомляем всех участников об обновлении
    notify_room_update(room)

    return jsonify({'success': True, 'avatar_url': room.avatar_url})

@app.route('/api/remove_room_avatar', methods=['POST'])
def remove_room_avatar():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    
    data = request.get_json()
    room_id = data.get('room_id')
    
    if not room_id:
        return jsonify({'success': False, 'message': 'ID комнаты не указан.'}), 400
    
    # Проверяем права доступа - только админ может удалять аватар
    participant = RoomParticipant.query.filter_by(user_id=session['user_id'], room_id=room_id).first()
    if not participant or participant.role != 'admin':
        return jsonify({'success': False, 'message': 'Только администратор может удалять аватар комнаты.'}), 403
    
    room = db.session.get(Room, room_id)
    if not room or room.type == 'dm':
        return jsonify({'success': False, 'message': 'Комната не найдена или это личный чат.'}), 404
    
    # Удаляем файл аватара
    try:
        if room.avatar_url and room.avatar_url.startswith('/static/uploads/avatars/'):
            old_path = room.avatar_url.lstrip('/')
            if os.path.exists(old_path):
                os.remove(old_path)
    except Exception:
        pass
    
    room.avatar_url = None
    db.session.commit()

    # Уведомляем всех участников об обновлении
    notify_room_update(room)
    
    return jsonify({'success': True})

# --- Обработчики SocketIO ---
@socketio.on('connect')
def on_connect():
    if 'user_id' in session:
        user_id = session['user_id']
        join_room(f"user_{user_id}")
        ONLINE_USERS.add(user_id)
        SID_TO_USER[flask_request.sid] = user_id
        # Принудительно переводим соединение в WebSocket для мобильных клиентов,
        # если сервер запустился в режиме с polling по умолчанию
        try:
            emit('noop')  # держим канал активным
        except Exception:
            pass
        # Уведомляем участников его комнат о присутствии
        entries = db.session.get(User, user_id).rooms.options(db.joinedload(RoomParticipant.room)).all()
        for e in entries:
            emit('presence_update', {'user_id': user_id, 'online': True}, room=str(e.room_id))

@socketio.on('join')
def on_join(data):
    if 'user_id' not in session: return
    user_id = session['user_id']; room_id = data['room_id']
    if RoomParticipant.query.filter_by(user_id=user_id, room_id=room_id).first():
        join_room(str(room_id))
        # Отправим текущее присутствие участников в комнате
        participants = RoomParticipant.query.filter_by(room_id=room_id).all()
        presence = {p.user_id: (p.user_id in ONLINE_USERS) for p in participants}
        emit('room_presence_snapshot', {'room_id': room_id, 'presence': presence})

@socketio.on('leave')
def on_leave(data):
    if 'user_id' in session: leave_room(str(data['room_id']))

@socketio.on('send_message')
def handle_message(data):
    if 'user_id' not in session: return
    sender_id = session['user_id']; room_id = data['room_id']; content = data.get('content', '').strip()
    if not content: return

    participant = RoomParticipant.query.filter_by(user_id=sender_id, room_id=room_id).first()
    if not participant: return
    room = participant.room

    message_type = (data.get('message_type') or 'text').strip().lower()

    if room.type == 'channel' and participant.role != 'admin':
        if message_type not in ('comment', 'poll_comment'):
            return

    # Блок: запрещаем писать, если отправитель заблокировал получателя ИЛИ получатель заблокировал отправителя
    if room.type == 'dm':
        other_entry = room.participants.filter(RoomParticipant.user_id != sender_id).first()
        if other_entry:
            # Проверяем блокировку в обе стороны
            if BlockedUser.query.filter_by(blocker_id=sender_id, blocked_id=other_entry.user_id).first():
                return  # Отправитель заблокировал получателя
            if BlockedUser.query.filter_by(blocker_id=other_entry.user_id, blocked_id=sender_id).first():
                return  # Получатель заблокировал отправителя

    thread_root_id = data.get('thread_root_id')
    thread_type = data.get('thread_type')

    # Комментарии доступны только участникам комнаты
    root_message = None
    if thread_root_id:
        try:
            thread_root_id = int(thread_root_id)
            root_message = db.session.get(Message, thread_root_id)
        except (TypeError, ValueError):
            thread_root_id = None
    if root_message and root_message.room_id != room_id:
        thread_root_id = None
        root_message = None
    if root_message:
        if not thread_type:
            if root_message.message_type == 'poll':
                thread_type = 'poll'
            else:
                thread_type = 'message'
        else:
            thread_type = str(thread_type).strip().lower()
        if root_message.message_type == 'poll':
            message_type = 'poll_comment'
        elif message_type not in ('comment', 'poll_comment'):
            message_type = 'comment'
    else:
        thread_type = None

    new_message = Message(
        room_id=room_id,
        sender_id=sender_id,
        content=content,
        message_type=message_type,
        thread_root_id=thread_root_id,
        thread_type=thread_type
    )
    db.session.add(new_message)
    
    # Увеличиваем счетчик непрочитанных для всех в комнате, кроме отправителя
    other_participants = room.participants.filter(RoomParticipant.user_id != sender_id).all()
    for p in other_participants:
        unread_entry = UnreadMessage.query.filter_by(user_id=p.user_id, room_id=room_id).first()
        if unread_entry:
            unread_entry.count += 1
        else:
            db.session.add(UnreadMessage(user_id=p.user_id, room_id=room_id, count=1))

    db.session.commit()
    message_dict = new_message.to_dict()
    if new_message.thread_root_id:
        try:
            count_stmt = db.select(db.func.count()).select_from(Message).where(Message.thread_root_id == new_message.thread_root_id)
            message_dict['thread_comment_count'] = db.session.execute(count_stmt).scalar() or 0
        except Exception:
            message_dict['thread_comment_count'] = 0

    # Отправляем сообщение и обновленный счетчик непрочитанных
    for p in room.participants.all():
        # Сам отправитель не получает обновление счетчика, у него всегда 0
        if p.user_id == sender_id:
            emit('receive_message', message_dict, room=f"user_{p.user_id}")
            continue

        unread_entry = UnreadMessage.query.filter_by(user_id=p.user_id, room_id=room_id).first()
        unread_count = unread_entry.count if unread_entry else 0
        
        payload = {
            'message': message_dict,
            'unread_update': {
                'room_id': room_id,
                'count': unread_count
            }
        }
        emit('receive_message_with_unread', payload, room=f"user_{p.user_id}")

    return message_dict

@app.route('/api/mark_room_as_read', methods=['POST'])
def mark_room_as_read():
    if 'user_id' not in session:
        return jsonify({'error': 'Unauthorized'}), 401

    user_id = session['user_id']
    data = request.get_json() or {}

    try:
        room_id = int(data.get('room_id'))
    except (TypeError, ValueError):
        return jsonify({'success': False, 'message': 'Не указан ID комнаты.'}), 400

    unread_entry = UnreadMessage.query.filter_by(user_id=user_id, room_id=room_id).first()
    if unread_entry:
        unread_entry.count = 0

    # Фиксируем последний прочитанный идентификатор сообщения в комнате
    last_message_id = db.session.execute(
        db.select(db.func.max(Message.id)).where(Message.room_id == room_id)
    ).scalar()

    db.session.commit()

    if last_message_id:
        payload = {
            'room_id': room_id,
            'reader_id': user_id,
            'last_read_message_id': int(last_message_id)
        }
        socketio.emit('room_read_receipt', payload, room=str(room_id))

    return jsonify({'success': True})


@app.route('/api/send_voice', methods=['POST'])
def send_voice():
    """Отправка голосового сообщения"""
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Не авторизован'}), 401
    
    room_id = request.form.get('room_id')
    audio_file = request.files.get('audio')
    
    if not room_id or not audio_file:
        return jsonify({'success': False, 'message': 'Не указана комната или файл'}), 400
    
    # Проверяем доступ к комнате
    participant = RoomParticipant.query.filter_by(user_id=session['user_id'], room_id=room_id).first()
    if not participant:
        return jsonify({'success': False, 'message': 'Вы не участник этой комнаты'}), 403
    
    try:
        # Сохраняем аудиофайл
        filename = secure_filename(f"voice_{session['user_id']}_{int(time.time())}.webm")
        filepath = os.path.join(UPLOAD_MEDIA_DIR, filename)
        audio_file.save(filepath)
        
        media_url = f"/static/uploads/media/{filename}"
        
        # Создаем сообщение
        new_message = Message(
            room_id=room_id,
            sender_id=session['user_id'],
            content='🎤 Голосовое сообщение',
            media_url=media_url,
            media_type='audio',
            message_type='voice'
        )
        db.session.add(new_message)
        db.session.commit()
        
        # Отправляем через Socket.IO
        message_dict = new_message.to_dict()
        socketio.emit('receive_message', message_dict, room=str(room_id))
        
        return jsonify({'success': True, 'message_id': new_message.id})
        
    except Exception as e:
        db.session.rollback()
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/send_media', methods=['POST'])
def send_media():
    if 'user_id' not in session: return jsonify({'error': 'Unauthorized'}), 401
    
    try:
        sender_id = session['user_id']
        room_id_str = request.form.get('room_id')
        caption = request.form.get('caption', '').strip()
        files = request.files.getlist('files')
        
        if not room_id_str or not files:
            return jsonify({'success': False, 'message': 'ID комнаты или файлы отсутствуют.'}), 400
            
        room_id = int(room_id_str)
        
        participant = RoomParticipant.query.filter_by(user_id=sender_id, room_id=room_id).first()
        if not participant:
            return jsonify({'success': False, 'message': 'Нет доступа к комнате.'}), 403
        
        room = participant.room
        if room.type == 'channel' and participant.role != 'admin':
            return jsonify({'success': False, 'message': 'Нет прав для отправки в канал.'}), 403
        
        if room.type == 'dm':
            other_entry = room.participants.filter(RoomParticipant.user_id != sender_id).first()
            if other_entry and BlockedUser.query.filter_by(blocker_id=sender_id, blocked_id=other_entry.user_id).first():
                return jsonify({'success': False, 'message': 'Пользователь заблокирован.'}), 403
        
        # Создаем одно сообщение
        new_message = Message(room_id=room_id, sender_id=sender_id, content=caption)
        db.session.add(new_message)
        
        media_items_added = []
        
        for file in files:
            if not file or not file.filename:
                continue

            filename = secure_filename(file.filename)
            ext = filename.rsplit('.', 1)[1].lower() if '.' in filename else ''

            if ext in ALLOWED_IMAGE_EXTENSIONS:
                media_type = 'image'
            elif ext in ALLOWED_VIDEO_EXTENSIONS:
                media_type = 'video'
            else:
                media_type = 'file'

            unique_name = f"m{sender_id}_{int(time.time())}_{filename}"
            save_path = os.path.join(UPLOAD_MEDIA_DIR, unique_name)

            # Ограничим размер файла вручную на случай отсутствия Content-Length
            file.seek(0, os.SEEK_END)
            size = file.tell()
            file.seek(0)
            if size > MAX_FILE_SIZE:
                return jsonify({'success': False, 'message': 'Файл слишком большой.'}), 413

            file.save(save_path)
            
            media_url = f"/static/uploads/media/{unique_name}"
            
            media_item = MessageMedia(
                message=new_message,
                url=media_url,
                type=media_type
            )
            media_items_added.append(media_item)

        if not media_items_added and not caption:
            return jsonify({'success': False, 'message': 'Нет контента для отправки'}), 400

        if media_items_added:
            db.session.add_all(media_items_added)

        # Увеличиваем счетчик непрочитанных
        other_participants = room.participants.filter(RoomParticipant.user_id != sender_id).all()
        for p in other_participants:
            unread_entry = UnreadMessage.query.filter_by(user_id=p.user_id, room_id=room_id).first()
            if unread_entry:
                unread_entry.count += 1
            else:
                db.session.add(UnreadMessage(user_id=p.user_id, room_id=room_id, count=1))

        db.session.commit()
        
        message_dict = new_message.to_dict()
        
        # Отправляем сообщение и обновленный счетчик непрочитанных (через socketio.emit из HTTP контекста)
        for p in room.participants.all():
            if p.user_id == sender_id:
                socketio.emit('receive_message', message_dict, room=f"user_{p.user_id}")
                continue

            unread_entry = UnreadMessage.query.filter_by(user_id=p.user_id, room_id=room_id).first()
            unread_count = unread_entry.count if unread_entry else 0
            
            payload = {
                'message': message_dict,
                'unread_update': { 'room_id': room_id, 'count': unread_count }
            }
            socketio.emit('receive_message_with_unread', payload, room=f"user_{p.user_id}")
        
        return jsonify({'success': True, 'message': message_dict})

    except Exception as e:
        import traceback
        app.logger.error(f"Error in /api/send_media: {e}\n{traceback.format_exc()}")
        return jsonify({'success': False, 'message': 'Внутренняя ошибка сервера.'}), 500


@socketio.on('react_to_message')
def handle_reaction(data):
    if 'user_id' not in session: return
    user_id = session['user_id']; message_id = data['message_id']
    emoji = data['emoji']; action = data['action']

    ALLOWED_EMOJIS = ['👍', '👎', '❤️', '😂', '😮', '😢', '🔥']
    if emoji not in ALLOWED_EMOJIS: return

    message = db.session.get(Message, message_id)
    if not message: return
    
    if not RoomParticipant.query.filter_by(user_id=user_id, room_id=message.room_id).first(): return

    if action == 'add':
        try:
            db.session.add(MessageReaction(message_id=message_id, user_id=user_id, emoji=emoji))
            db.session.commit()
        except Exception:
            db.session.rollback()
            
    elif action == 'remove':
        MessageReaction.query.filter_by(message_id=message_id, user_id=user_id, emoji=emoji).delete()
        db.session.commit()

    updated_message = db.session.get(Message, message_id)
    
    update_data = {
        'message_id': message_id,
        'reactions': updated_message.get_reactions_summary()
    }
    emit('update_reactions', update_data, room=str(message.room_id))

@socketio.on('typing')
def handle_typing(data):
    if 'user_id' not in session: return
    user_id = session['user_id']
    room_id = data.get('room_id')
    is_typing = bool(data.get('is_typing'))
    if not room_id: return
    if not RoomParticipant.query.filter_by(user_id=user_id, room_id=room_id).first():
        return
    emit('typing', {'user_id': user_id, 'room_id': room_id, 'is_typing': is_typing}, room=str(room_id), include_self=False)

@socketio.on('edit_message')
def handle_edit_message(data):
    if 'user_id' not in session: return
    user_id = session['user_id']
    message_id = data.get('message_id')
    new_content = (data.get('content') or '').strip()
    if not message_id or not new_content: return
    msg = db.session.get(Message, message_id)
    if not msg: return
    # Разрешаем редактировать отправителю или админу комнаты
    participant = RoomParticipant.query.filter_by(user_id=user_id, room_id=msg.room_id).first()
    if not participant: return
    if msg.sender_id != user_id and participant.role != 'admin':
        return
    msg.content = new_content
    db.session.commit()
    payload = {'message_id': msg.id, 'content': msg.content}
    emit('message_edited', payload, room=str(msg.room_id))
    return {'success': True}

@socketio.on('delete_message')
def handle_delete_message(data):
    if 'user_id' not in session: return
    user_id = session['user_id']
    message_id = data.get('message_id')
    if not message_id: return
    msg = db.session.get(Message, message_id)
    if not msg: return
    participant = RoomParticipant.query.filter_by(user_id=user_id, room_id=msg.room_id).first()
    if not participant: return
    if msg.sender_id != user_id and participant.role != 'admin':
        return
    room_id = msg.room_id
    db.session.delete(msg)
    db.session.commit()
    emit('message_deleted', {'message_id': message_id}, room=str(room_id))
    return {'success': True}

@socketio.on('delete_messages')
def handle_delete_messages(data):
    if 'user_id' not in session: return
    user_id = session['user_id']
    message_ids = data.get('message_ids', [])
    
    if not message_ids: return

    deleted_ids = []
    room_id_to_notify = None

    for msg_id in message_ids:
        msg = db.session.get(Message, msg_id)
        if msg and msg.sender_id == user_id:
            # Можно добавить проверку на админа, если нужно
            if not room_id_to_notify:
                room_id_to_notify = msg.room_id
            
            deleted_ids.append(msg_id)
            db.session.delete(msg)

    if deleted_ids:
        db.session.commit()
        emit('messages_deleted', {'message_ids': deleted_ids}, room=str(room_id_to_notify))
    
    return {'success': True, 'deleted_count': len(deleted_ids)}


@socketio.on('webrtc_signal')
def handle_webrtc_signal(data):
    if 'user_id' not in session: return
    sender_id = session['user_id']
    target_user_id = data.get('target_user_id')
    signal_data = data.get('signal')

    if not target_user_id or not signal_data: return

    emit('webrtc_signal', {
        'sender_id': sender_id,
        'signal': signal_data
    }, room=f"user_{target_user_id}")

@socketio.on('call_action')
def handle_call_action(data):
    if 'user_id' not in session: return
        
    sender_id = session['user_id']
    target_user_id = data.get('target_user_id')
    action_type = data.get('action')
    
    if not target_user_id or not action_type: return
        
    sender_name = "Unknown"
    if action_type == 'start':
        user = db.session.get(User, sender_id)
        if user: sender_name = f"@{user.username}"

    emit('call_action', {
        'sender_id': sender_id,
        'sender_name': sender_name,
        'action': action_type
    }, room=f"user_{target_user_id}")

@socketio.on('room_call_action')
def handle_room_call_action(data):
    # Групповые звонки: обработка различных действий
    if 'user_id' not in session: return
    sender_id = session['user_id']
    room_id = data.get('room_id')
    action_type = data.get('action')  # 'lobby_created', 'invite', 'join', 'end'
    if not room_id or not action_type: return

    # Проверяем, что пользователь в комнате
    if not RoomParticipant.query.filter_by(user_id=sender_id, room_id=room_id).first():
        return

    sender_name = 'Unknown'
    user = db.session.get(User, sender_id)
    if user: sender_name = f"@{user.username}"

    if action_type == 'lobby_created':
        # Создано лобби - уведомляем всех в комнате (для показа индикатора)
        emit('room_call_action', {
            'sender_id': sender_id,
            'sender_name': sender_name,
            'room_id': room_id,
            'action': 'lobby_created',
            'initiator_id': sender_id
        }, room=str(room_id))
        
    elif action_type == 'invite':
        # Приглашение конкретного пользователя
        target_user_id = data.get('target_user_id')
        if target_user_id:
            emit('room_call_action', {
                'sender_id': sender_id,
                'sender_name': sender_name,
                'room_id': room_id,
                'action': 'invite',
                'target_user_id': target_user_id
            }, room=f"user_{target_user_id}")
            
    elif action_type == 'join':
        # Участник присоединился - уведомляем всех в комнате
        emit('room_call_action', {
            'sender_id': sender_id,
            'sender_name': sender_name,
            'room_id': room_id,
            'action': 'participant_joined',
            'user_id': sender_id
        }, room=str(room_id))
        
    elif action_type == 'end':
        # Завершение звонка - уведомляем всех
        emit('room_call_action', {
            'sender_id': sender_id,
            'room_id': room_id,
            'action': 'end'
        }, room=str(room_id))

@socketio.on('system_message')
def handle_system_message(data):
    # Создание системного сообщения (блокировка, разблокировка, звонки)
    if 'user_id' not in session: return
    
    room_id = data.get('room_id')
    content = data.get('content')
    msg_type = data.get('type', 'system')  # 'system' or 'call'
    call_duration = data.get('call_duration')
    
    if not room_id or not content: return
    
    # Проверяем доступ к комнате
    if not RoomParticipant.query.filter_by(user_id=session['user_id'], room_id=room_id).first():
        return
    
    # Создаем системное сообщение от текущего пользователя
    new_message = Message(
        room_id=room_id,
        sender_id=session['user_id'],  # Используем ID текущего пользователя
        content=content,
        message_type=msg_type,
        call_duration=call_duration
    )
    db.session.add(new_message)
    db.session.commit()
    
    # Отправляем всем участникам
    message_dict = new_message.to_dict()
    emit('receive_message', message_dict, room=str(room_id))
    
    return message_dict

@socketio.on('whiteboard_draw')
def handle_whiteboard_draw(data):
    """Синхронизация рисования на доске между участниками"""
    if 'user_id' not in session: return
    
    room_id = data.get('room_id')
    if not room_id: return
    
    # Проверяем доступ к комнате
    if not RoomParticipant.query.filter_by(user_id=session['user_id'], room_id=room_id).first():
        return
    
    # Отправляем всем участникам кроме отправителя
    emit('whiteboard_draw', data, room=str(room_id), include_self=False)

@socketio.on('whiteboard_clear')
def handle_whiteboard_clear(data):
    """Очистка доски для всех участников"""
    if 'user_id' not in session: return
    
    room_id = data.get('room_id')
    if not room_id: return
    
    # Проверяем доступ к комнате
    if not RoomParticipant.query.filter_by(user_id=session['user_id'], room_id=room_id).first():
        return
    
    # Отправляем всем участникам кроме отправителя
    emit('whiteboard_clear', {'room_id': room_id}, room=str(room_id), include_self=False)

@socketio.on('document_update')
def handle_document_update(data):
    """Синхронизация совместного документа"""
    if 'user_id' not in session: return
    
    room_id = data.get('room_id')
    content = data.get('content', '')
    
    if not room_id: return
    
    # Проверяем доступ к комнате
    if not RoomParticipant.query.filter_by(user_id=session['user_id'], room_id=room_id).first():
        return
    
    # Отправляем всем участникам кроме отправителя
    emit('document_update', {'content': content}, room=str(room_id), include_self=False)

@socketio.on('presentation_slide_change')
def handle_presentation_slide_change(data):
    """Синхронизация смены слайдов презентации"""
    if 'user_id' not in session: return
    
    room_id = data.get('room_id')
    slide_index = data.get('slide_index', 0)
    
    if not room_id: return
    
    # Проверяем доступ к комнате
    if not RoomParticipant.query.filter_by(user_id=session['user_id'], room_id=room_id).first():
        return
    
    # Отправляем всем участникам кроме отправителя
    emit('presentation_slide_change', {'slide_index': slide_index}, room=str(room_id), include_self=False)

@socketio.on('update_call_card')
def handle_update_call_card(data):
    # Обновление карточки звонка (добавление длительности после завершения)
    if 'user_id' not in session: return
    
    message_id = data.get('message_id')
    duration = data.get('duration')
    status = data.get('status')
    
    if not message_id: return
    
    # Находим сообщение
    message = db.session.get(Message, message_id)
    if not message or message.message_type != 'call': return
    
    # Проверяем доступ
    if not RoomParticipant.query.filter_by(user_id=session['user_id'], room_id=message.room_id).first():
        return
    
    # Обновляем длительность
    message.call_duration = duration
    db.session.commit()
    
    # Уведомляем всех в комнате об обновлении
    emit('call_card_updated', {
        'message_id': message_id,
        'duration': duration,
        'status': status
    }, room=str(message.room_id))

@socketio.on('disconnect')
def on_disconnect():
    sid = flask_request.sid
    user_id = SID_TO_USER.pop(sid, None)
    if user_id and user_id in ONLINE_USERS:
        ONLINE_USERS.discard(user_id)
        # Уведомляем участников его комнат
        try:
            entries = db.session.get(User, user_id).rooms.options(db.joinedload(RoomParticipant.room)).all()
            for e in entries:
                emit('presence_update', {'user_id': user_id, 'online': False}, room=str(e.room_id))
        except Exception:
            pass

# --- Технический маршрут: подавление 404 от Chrome DevTools ---
@app.route('/.well-known/appspecific/com.chrome.devtools.json', methods=['GET'])
def chrome_devtools_probe():
    return ('', 204)

# Favicon, чтобы убрать 404
@app.route('/favicon.ico')
def favicon():
    return ('', 204)

if __name__ == '__main__':
    with app.app_context():
       db.create_all()
       # Добавляем недостающие столбцы (SQLite)
       try:
           # avatar_url для user
           info = db.session.execute(text("PRAGMA table_info(user)")).fetchall()
           has_avatar = any(row[1] == 'avatar_url' for row in info)
           if not has_avatar:
               db.session.execute(text("ALTER TABLE user ADD COLUMN avatar_url VARCHAR(256)"))
               db.session.commit()
           
           # media_url и media_type для message
           msg_info = db.session.execute(text("PRAGMA table_info(message)")).fetchall()
           has_media_url = any(row[1] == 'media_url' for row in msg_info)
           has_media_type = any(row[1] == 'media_type' for row in msg_info)
           has_thread_root = any(row[1] == 'thread_root_id' for row in msg_info)
           has_thread_type = any(row[1] == 'thread_type' for row in msg_info)
           
           # Создаем новую таблицу message_media, если ее нет
           inspector = db.inspect(db.engine)
           if not inspector.has_table('message_media'):
                MessageMedia.__table__.create(db.engine)

           if not has_media_url:
               db.session.execute(text("ALTER TABLE message ADD COLUMN media_url VARCHAR(512)"))
               db.session.commit()
           if not has_media_type:
               db.session.execute(text("ALTER TABLE message ADD COLUMN media_type VARCHAR(20)"))
               db.session.commit()
           if not has_thread_root:
               db.session.execute(text("ALTER TABLE message ADD COLUMN thread_root_id INTEGER"))
               db.session.commit()
           if not has_thread_type:
               db.session.execute(text("ALTER TABLE message ADD COLUMN thread_type VARCHAR(20)"))
               db.session.commit()
           
           # message_type для системных сообщений
           has_message_type = any(row[1] == 'message_type' for row in msg_info)
           if not has_message_type:
               db.session.execute(text("ALTER TABLE message ADD COLUMN message_type VARCHAR(20) DEFAULT 'text'"))
               db.session.commit()
           
           # call_duration для карточек звонков
           has_call_duration = any(row[1] == 'call_duration' for row in msg_info)
           if not has_call_duration:
               db.session.execute(text("ALTER TABLE message ADD COLUMN call_duration VARCHAR(10)"))
               db.session.commit()
           # Создаем таблицу голосов для опросов, если её нет
           inspector2 = db.inspect(db.engine)
           if not inspector2.has_table('poll_vote'):
               # Создадим через SQLAlchemy метаданные
               try:
                   from sqlalchemy.exc import OperationalError
               except Exception:
                   OperationalError = Exception
               try:
                   # Используем декларативную модель, уже объявленную выше
                   PollVote.__table__.create(db.engine)
               except OperationalError:
                   pass
       except Exception as e:
           print(f"Migration error: {e}")
           pass
    print("Сервер запущен на http://127.0.0.1:5000")
    try:
        print(f"Используемая БД: {app.config.get('SQLALCHEMY_DATABASE_URI')}")
    except Exception:
        pass
    if not IS_MAIL_CONFIGURED:
        print("ВНИМАНИЕ: Переменные окружения для Email не настроены.")
        
    socketio.run(app, debug=True, allow_unsafe_werkzeug=True)
