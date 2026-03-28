const WebSocket = require('ws');
const crypto = require('crypto');
const { Pool } = require('pg');

const wss = new WebSocket.Server({ port: 8080 });
const users = new Map(); // только для онлайн-статуса

// Подключение к PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Создаём таблицу
pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    contacts TEXT[] DEFAULT '{}'
  )
`).catch(e => console.error('Table error:', e));

// Загрузка пользователей при старте
async function loadAllUsers() {
  const res = await pool.query('SELECT id, password, contacts FROM users');
  for (let row of res.rows) {
    users.set(row.id, {
      password: row.password,
      contacts: row.contacts,
      socket: null
    });
  }
  console.log(`📦 Loaded ${users.size} users from DB`);
}

// Сохранение в БД
async function saveUserToDB(userId, password, contacts) {
  await pool.query(
    'INSERT INTO users (id, password, contacts) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET password = $2, contacts = $3',
    [userId, password, contacts]
  );
}

loadAllUsers();

console.log('🔒 VeilChat Server started');

function sendToUser(userId, data) {
  const user = users.get(userId);
  if (user && user.socket?.readyState === WebSocket.OPEN) {
    user.socket.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function broadcastStatus(userId) {
  const user = users.get(userId);
  if (!user) return;
  user.contacts.forEach(contact => {
    sendToUser(contact, {
      type: 'status',
      userId: userId,
      online: user.socket?.readyState === WebSocket.OPEN
    });
  });
}

wss.on('connection', (ws) => {
  let currentUserId = null;
  console.log('📱 New client');

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      console.log('📨', data.type);

      if (data.type === 'register') {
        const { userId, password } = data;
        
        if (!users.has(userId)) {
          users.set(userId, { password, socket: ws, contacts: [] });
          await saveUserToDB(userId, password, []);
          console.log(`✅ New: ${userId}`);
        } else {
          users.get(userId).socket = ws;
          console.log(`🔄 Reconnected: ${userId}`);
        }
        currentUserId = userId;
        
        ws.send(JSON.stringify({ type: 'registered', success: true }));
        ws.send(JSON.stringify({ type: 'contacts_list', contacts: users.get(userId).contacts }));
        
        // Отправляем статусы контактов
        for (let contact of users.get(userId).contacts) {
          const c = users.get(contact);
          if (c) {
            ws.send(JSON.stringify({
              type: 'status', userId: contact,
              online: c.socket?.readyState === WebSocket.OPEN
            }));
          }
        }
        
        broadcastStatus(userId);
      }
      
      else if (data.type === 'message') {
        const { from, to, content, messageId } = data;
        const target = users.get(to);
        if (target?.socket?.readyState === WebSocket.OPEN) {
          target.socket.send(JSON.stringify({
            type: 'message', from, content, messageId, timestamp: Date.now()
          }));
          console.log(`📨 ${from} → ${to}`);
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
          await saveUserToDB(userId, user.password, user.contacts);
          console.log(`📞 ${userId} added ${contactId}`);
          ws.send(JSON.stringify({ type: 'contact_added_success', contact: contactId }));
          
          const contact = users.get(contactId);
          if (contact) {
            ws.send(JSON.stringify({
              type: 'status', userId: contactId,
              online: contact.socket?.readyState === WebSocket.OPEN
            }));
          }
        }
      }
      
      else if (data.type === 'call_request') {
        const { from, to } = data;
        const roomId = crypto.randomBytes(8).toString('hex');
        sendToUser(to, { type: 'incoming_call', from, roomId });
        sendToUser(from, { type: 'call_initialized', roomId });
        console.log(`📞 Call: ${from} → ${to}`);
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
      console.log(`👋 Disconnected: ${currentUserId}`);
      const user = users.get(currentUserId);
      if (user) user.socket = null;
      broadcastStatus(currentUserId);
    }
  });
});

console.log('✅ Server ready');
