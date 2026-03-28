const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');

const wss = new WebSocket.Server({ port: 8080 });
const users = new Map();
const DATA_FILE = './data/users.json';

// Загрузка пользователей
function loadUsers() {
  if (!fs.existsSync('./data')) fs.mkdirSync('./data');
  if (fs.existsSync(DATA_FILE)) {
    const data = fs.readFileSync(DATA_FILE);
    const saved = JSON.parse(data);
    for (let [id, info] of Object.entries(saved)) {
      users.set(id, { ...info, socket: null });
    }
    console.log(`📦 Loaded ${users.size} users from file`);
  }
}

// Сохранение пользователей
function saveUsers() {
  const toSave = {};
  for (let [id, info] of users) {
    toSave[id] = { password: info.password, contacts: info.contacts };
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(toSave, null, 2));
  console.log(`💾 Saved ${users.size} users to file`);
}

// Сохраняем каждые 10 секунд
setInterval(saveUsers, 10000);
process.on('SIGINT', () => { saveUsers(); process.exit(); });

loadUsers();

console.log('🔒 VeilChat Server started on ws://0.0.0.0:8080');

function sendToUser(userId, data) {
  const user = users.get(userId);
  if (user && user.socket && user.socket.readyState === WebSocket.OPEN) {
    user.socket.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function broadcastStatus(userId) {
  const user = users.get(userId);
  if (!user) return;
  user.contacts.forEach(contactNick => {
    sendToUser(contactNick, {
      type: 'status',
      userId: userId,
      online: user.socket?.readyState === WebSocket.OPEN
    });
  });
}

wss.on('connection', (ws) => {
  let currentUserId = null;
  console.log('📱 New client connected');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('📨 Received:', data.type);

      if (data.type === 'register') {
        const { userId, password } = data;
        
        if (!users.has(userId)) {
          users.set(userId, { password, socket: ws, contacts: [] });
          console.log(`✅ New user: ${userId}`);
          saveUsers();
        } else {
          users.get(userId).socket = ws;
          console.log(`🔄 User reconnected: ${userId}`);
        }
        currentUserId = userId;
        
        ws.send(JSON.stringify({ type: 'registered', success: true, userId: userId }));
        ws.send(JSON.stringify({ type: 'contacts_list', contacts: users.get(userId).contacts }));
        
        broadcastStatus(userId);
      }
      
      else if (data.type === 'message') {
        const { from, to, content, messageId } = data;
        const target = users.get(to);
        
        if (target && target.socket?.readyState === WebSocket.OPEN) {
          target.socket.send(JSON.stringify({
            type: 'message', from, content, messageId, timestamp: Date.now()
          }));
          console.log(`📨 Message: ${from} → ${to}: ${content}`);
          
          setTimeout(() => {
            if (target.socket?.readyState === WebSocket.OPEN) {
              target.socket.send(JSON.stringify({ type: 'delete_message', messageId }));
            }
          }, 60000);
        }
      }
      
      else if (data.type === 'add_contact') {
        const { userId, contactId } = data;
        const user = users.get(userId);
        if (user && !user.contacts.includes(contactId)) {
          user.contacts.push(contactId);
          console.log(`📞 ${userId} added contact: ${contactId}`);
          ws.send(JSON.stringify({ type: 'contact_added_success', contact: contactId }));
          saveUsers();
          
          const contact = users.get(contactId);
          if (contact) {
            ws.send(JSON.stringify({
              type: 'status',
              userId: contactId,
              online: contact.socket?.readyState === WebSocket.OPEN
            }));
          }
        }
      }
      
      else if (data.type === 'get_status') {
        const { userId } = data;
        const user = users.get(userId);
        if (user) {
          ws.send(JSON.stringify({
            type: 'status',
            userId: userId,
            online: user.socket?.readyState === WebSocket.OPEN
          }));
        }
      }
      
      else if (data.type === 'call_request') {
        const { from, to } = data;
        const roomId = crypto.randomBytes(8).toString('hex');
        sendToUser(to, { type: 'incoming_call', from: from, roomId: roomId });
        sendToUser(from, { type: 'call_initialized', roomId: roomId });
        console.log(`📞 Call: ${from} → ${to}, room: ${roomId}`);
      }
      
      else if (data.type === 'webrtc_signal') {
        const { to, signal, roomId } = data;
        sendToUser(to, { type: 'webrtc_signal', from: currentUserId, signal, roomId });
      }
      
      else if (data.type === 'end_call') {
        console.log(`📞 Call ended`);
      }
      
    } catch (e) {
      console.error('Error:', e);
    }
  });

  ws.on('close', () => {
    if (currentUserId) {
      console.log(`👋 User disconnected: ${currentUserId}`);
      const user = users.get(currentUserId);
      if (user) user.socket = null;
      broadcastStatus(currentUserId);
    }
  });
});

console.log('✅ Server running on ws://0.0.0.0:8080');
