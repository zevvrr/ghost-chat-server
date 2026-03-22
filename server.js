const WebSocket = require('ws');
const crypto = require('crypto');

// Создаём сервер на порту 8080
const wss = new WebSocket.Server({ port: 8080 });

// Хранилище пользователей
const users = new Map(); // { userId: { password, socket, contacts } }

console.log('🔒 VeilChat Server started on ws://0.0.0.0:8080');
console.log('📝 Features: encrypted messages, disappearing messages, WebRTC calls');

// Генерация ID комнаты для звонка
function generateRoomId() {
  return crypto.randomBytes(16).toString('hex');
}

// Отправка сообщения пользователю
function sendToUser(userId, data) {
  const user = users.get(userId);
  if (user && user.socket && user.socket.readyState === WebSocket.OPEN) {
    user.socket.send(JSON.stringify(data));
    return true;
  }
  return false;
}

// Отправка статуса онлайн всем контактам
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

wss.on('connection', (ws, req) => {
  let currentUserId = null;
  let heartbeatInterval = null;

  console.log('📱 New client connected');

  // Heartbeat для проверки живых соединений
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  heartbeatInterval = setInterval(() => {
    if (ws.isAlive === false) {
      if (currentUserId) {
        console.log(`❌ User ${currentUserId} disconnected (timeout)`);
        broadcastStatus(currentUserId);
        const user = users.get(currentUserId);
        if (user) user.socket = null;
      }
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  }, 30000);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('📨 Received:', data.type, data);

      // Регистрация пользователя
      if (data.type === 'register') {
        const { userId, password } = data;
        
        if (!users.has(userId)) {
          users.set(userId, {
            password: password,
            socket: ws,
            contacts: []
          });
          console.log(`✅ New user registered: ${userId}`);
        } else {
          const existingUser = users.get(userId);
          existingUser.socket = ws;
          console.log(`🔄 User reconnected: ${userId}`);
        }
        
        currentUserId = userId;
        
        // Отправляем подтверждение
        ws.send(JSON.stringify({
          type: 'registered',
          success: true,
          userId: userId
        }));
        
        // Отправляем список контактов
        const user = users.get(userId);
        ws.send(JSON.stringify({
          type: 'contacts_list',
          contacts: user.contacts
        }));
        
        // Уведомляем контакты о статусе
        broadcastStatus(userId);
      }
      
      // Отправка сообщения
      else if (data.type === 'message') {
        const { from, to, content, messageId } = data;
        const target = users.get(to);
        
        if (target && target.socket && target.socket.readyState === WebSocket.OPEN) {
          // Отправляем сообщение получателю
          target.socket.send(JSON.stringify({
            type: 'message',
            from: from,
            content: content,
            messageId: messageId,
            timestamp: Date.now()
          }));
          
          // Отправляем подтверждение отправителю
          const sender = users.get(from);
          if (sender && sender.socket && sender.socket.readyState === WebSocket.OPEN) {
            sender.socket.send(JSON.stringify({
              type: 'message_delivered',
              messageId: messageId,
              to: to
            }));
          }
          
          console.log(`📨 Message from ${from} to ${to}: ${content.substring(0, 50)}`);
          
          // Планируем удаление сообщения через 60 секунд
          setTimeout(() => {
            if (target.socket && target.socket.readyState === WebSocket.OPEN) {
              target.socket.send(JSON.stringify({
                type: 'delete_message',
                messageId: messageId,
                from: from
              }));
              console.log(`🗑️ Message ${messageId} deleted after 60 seconds`);
            }
          }, 60000);
        } else {
          // Пользователь не в сети
          const sender = users.get(from);
          if (sender && sender.socket && sender.socket.readyState === WebSocket.OPEN) {
            sender.socket.send(JSON.stringify({
              type: 'error',
              message: `User ${to} is offline`
            }));
          }
        }
      }
      
      // Добавление контакта
      else if (data.type === 'add_contact') {
        const { userId, contactId } = data;
        const user = users.get(userId);
        
        if (user && !user.contacts.includes(contactId)) {
          user.contacts.push(contactId);
          console.log(`📞 ${userId} added contact: ${contactId}`);
          
          // Отправляем статус нового контакта
          const contact = users.get(contactId);
          if (contact) {
            ws.send(JSON.stringify({
              type: 'status',
              userId: contactId,
              online: contact.socket?.readyState === WebSocket.OPEN || false
            }));
          }
          
          ws.send(JSON.stringify({
            type: 'contact_added_success',
            contact: contactId
          }));
          
          // Уведомляем контакт о добавлении
          sendToUser(contactId, {
            type: 'contact_added',
            by: userId
          });
        }
      }
      
      // ========== WebRTC ЗВОНКИ ==========
      
      // Запрос на звонок
      else if (data.type === 'call_request') {
        const { from, to } = data;
        const target = users.get(to);
        
        if (!target) {
          sendToUser(from, {
            type: 'error',
            message: 'User not found'
          });
          return;
        }
        
        if (!target.socket || target.socket.readyState !== WebSocket.OPEN) {
          sendToUser(from, {
            type: 'error',
            message: 'User is offline'
          });
          return;
        }
        
        const roomId = generateRoomId();
        
        // Отправляем запрос на звонок получателю
        sendToUser(to, {
          type: 'incoming_call',
          from: from,
          roomId: roomId
        });
        
        // Отправляем инициатору ID комнаты
        sendToUser(from, {
          type: 'call_initialized',
          roomId: roomId
        });
        
        console.log(`📞 Call request from ${from} to ${to}, room: ${roomId}`);
      }
      
      // WebRTC сигналинг (offer, answer, ice_candidate)
      else if (data.type === 'webrtc_signal') {
        const { to, signal, roomId } = data;
        
        // Пересылаем сигнал получателю
        sendToUser(to, {
          type: 'webrtc_signal',
          from: currentUserId,
          signal: signal,
          roomId: roomId
        });
        
        console.log(`🔄 WebRTC signal from ${currentUserId} to ${to}: ${data.signal?.type || 'unknown'}`);
      }
      
      // Завершение звонка
      else if (data.type === 'end_call') {
        const { roomId } = data;
        
        // Уведомляем собеседника о завершении звонка
        // Для простоты, мы не храним комнаты, просто пересылаем
        // В реальном приложении нужно хранить участников комнаты
        
        console.log(`📞 Call ended for room: ${roomId}`);
      }
      
      else {
        console.log('Unknown message type:', data.type);
      }
      
    } catch (e) {
      console.error('Error parsing message:', e);
      ws.send(JSON.stringify({ 
        type: 'error', 
        message: 'Invalid message format' 
      }));
    }
  });

  ws.on('close', () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    
    if (currentUserId) {
      console.log(`👋 User disconnected: ${currentUserId}`);
      const user = users.get(currentUserId);
      if (user) user.socket = null;
      broadcastStatus(currentUserId);
    }
  });
});

console.log('✅ WebSocket server running on ws://localhost:8080');
console.log('🎉 Ready for calls!');