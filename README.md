# 💬 GlassChat - Modern Glass Design Messenger

Beautiful real-time chat application with glassmorphism design, group chats, video calls, and more!

## ✨ Features

- 🎨 **Beautiful Glassmorphism UI** - Modern, elegant design with blur effects
- 💬 **Real-time Messaging** - Instant messaging with Socket.IO
- 👥 **Group Chats & Channels** - Create groups and broadcast channels
- 🎥 **Video Calls** - Built-in video calling with SFU (Selective Forwarding Unit)
- 😊 **Message Reactions** - React to messages with emojis
- 📎 **File Sharing** - Send images and files
- 🔔 **Notifications** - Real-time notifications for messages and calls
- 🌓 **Multiple Themes** - Dark, Light, Ocean themes
- 📱 **Responsive Design** - Works on desktop and mobile

## 🚀 Quick Start

### Requirements
- Python 3.8+
- Node.js 14+
- Cloudflare Tunnel (for external access)

### Installation

1. **Clone the repository**
```bash
git clone <your-repo-url>
cd GlassChatProject
```

2. **Install Python dependencies**
```bash
pip install flask flask-socketio flask-sqlalchemy flask-cors werkzeug
```

3. **Install Node.js dependencies**
```bash
cd sfu_server
npm install
cd ..
```

### Running the Application

**You need 4 terminal windows:**

#### Terminal 1: Flask Server
```bash
python app.py
```

#### Terminal 2: Cloudflare Tunnel for Flask
```bash
cloudflared tunnel --url http://localhost:5000
```
Copy the URL that appears!

#### Terminal 3: SFU Server (for video calls)
```bash
cd sfu_server
node server.js
```

#### Terminal 4: Cloudflare Tunnel for SFU
```bash
cloudflared tunnel --url http://localhost:4000
```

### Access the Application

Open the URL from Terminal 2 in your browser!

## 📖 Full Documentation

See [ЗАПУСК_СЕРВЕРА.md](ЗАПУСК_СЕРВЕРА.md) for detailed Russian instructions.

## 🏗️ Technology Stack

- **Backend:** Flask, Flask-SocketIO, SQLAlchemy
- **Frontend:** Vanilla JavaScript, Socket.IO Client
- **Video:** Mediasoup (SFU), WebRTC
- **Styling:** Custom CSS with Glassmorphism
- **Database:** SQLite

## 📁 Project Structure

```
GlassChatProject/
├── app.py                 # Main Flask application
├── static/
│   ├── css/
│   │   └── style.css      # Glassmorphism styles
│   ├── js/
│   │   ├── chat.js        # Main chat logic
│   │   ├── sfu.js         # Video call logic
│   │   └── auth.js        # Authentication
│   └── uploads/           # User uploads
├── templates/
│   ├── index.html         # Main chat interface
│   └── auth.html          # Login/Register page
├── sfu_server/
│   ├── server.js          # Mediasoup SFU server
│   └── package.json       # Node dependencies
└── instance/
    └── database.db        # SQLite database

```

## 🎥 Video Calls

Video calls use **Mediasoup SFU** for efficient multi-party video conferencing:
- Low latency
- Scalable architecture
- Works through Cloudflare tunnels

## 🔒 Security Note

This is a development version. For production:
- Use proper SSL certificates
- Implement rate limiting
- Add CSRF protection
- Use production WSGI server
- Secure your database

## 📝 License

MIT License - feel free to use and modify!

## 🤝 Contributing

Contributions are welcome! Feel free to submit issues and pull requests.

---

**Made with ❤️ using Glass Design principles**

