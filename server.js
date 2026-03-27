const WebSocket = require('ws');
const crypto = require('crypto');

const wss = new WebSocket.Server({ port: 8080 });
const users = new Map();

console.log('🔒 VeilChat Server started on ws://0.0.0.0:8080');
console.log('📝 Features: messages, disappearing messages, WebRTC calls');

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
      // Преобразуем буфер в строку
      const messageStr = message.toString();
      const data = JSON.parse(messageStr);
      console.log('📨 Received:', data.type);

      // Регистрация
      if (data.type === 'register') {
        const { userId, password } = data;
        
        if (!users.has(userId)) {
          users.set(userId, { password, socket: ws, contacts: [] });
          console.log(`✅ New user: ${userId}`);
        } else {
          users.get(userId).socket = ws;
          console.log(`🔄 User reconnected: ${userId}`);
        }
        currentUserId = userId;
        
        ws.send(JSON.stringify({ type: 'registered', success: true, userId: userId }));
        ws.send(JSON.stringify({ type: 'contacts_list', contacts: users.get(userId).contacts }));
        broadcastStatus(userId);
      }
      
      // Сообщение
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
        } else {
          console.log(`❌ User ${to} offline`);
        }
      }
      
      // Добавить контакт
      else if (data.type === 'add_contact') {
        const { userId, contactId } = data;
        const user = users.get(userId);
        if (user && !user.contacts.includes(contactId)) {
          user.contacts.push(contactId);
          console.log(`📞 ${userId} added contact: ${contactId}`);
          ws.send(JSON.stringify({ type: 'contact_added_success', contact: contactId }));
        }
      }
      
      // === ЗВОНКИ ===
      
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
        const { roomId } = data;
        console.log(`📞 Call ended: ${roomId}`);
      }
      
    } catch (e) {
      console.error('Error parsing message:', e);
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
console.log('🎉 Ready for calls!');
