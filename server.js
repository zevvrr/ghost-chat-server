// server.js
const WebSocket = require('ws');
const crypto = require('crypto');
const bcrypt = require('bcrypt'); // npm install bcrypt

const wss = new WebSocket.Server({ port: 8080 });

// Хранилище
const users = new Map(); // { userId: { passwordHash, socket, contacts, publicKey } }
const messages = new Map(); // { messageId: { from, to, content, expiresAt } }
const rooms = new Map(); // для звонков { roomId: { participants, socket } }

console.log('🔒 Secure server started on ws://localhost:8080');

// Генерация ID комнаты для звонка
function generateRoomId() {
  return crypto.randomBytes(16).toString('hex');
}

// Отправка сообщения с подтверждением
function sendToUser(userId, data) {
  const user = users.get(userId);
  if (user && user.socket && user.socket.readyState === WebSocket.OPEN) {
    user.socket.send(JSON.stringify(data));
    return true;
  }
  return false;
}

// Broadcast статуса
function broadcastStatus(userId) {
  const user = users.get(userId);
  if (!user) return;

  user.contacts.forEach(contactId => {
    sendToUser(contactId, {
      type: 'status',
      userId: userId,
      online: user.socket.readyState === WebSocket.OPEN
    });
  });
}

// Обработка исчезающих сообщений
function scheduleMessageDeletion(messageId, userId, fromUser) {
  setTimeout(async () => {
    if (messages.has(messageId)) {
      messages.delete(messageId);
      
      // Уведомляем получателя об удалении
      sendToUser(userId, {
        type: 'delete_message',
        messageId: messageId,
        from: fromUser
      });
      
      console.log(`🗑️ Message ${messageId} deleted after 60 seconds`);
    }
  }, 60000); // 60 секунд
}

wss.on('connection', (ws, req) => {
  let currentUserId = null;
  let heartbeatInterval = null;

  // Heartbeat для проверки живы ли клиенты
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

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      switch(data.type) {
        
        // Регистрация с шифрованием пароля
        case 'register':
          const { userId, password, publicKey } = data;
          
          if (!userId || !password) {
            ws.send(JSON.stringify({ type: 'error', message: 'Missing credentials' }));
            return;
          }

          if (users.has(userId)) {
            // Обновляем сокет существующего пользователя
            const existingUser = users.get(userId);
            existingUser.socket = ws;
            existingUser.publicKey = publicKey;
            currentUserId = userId;
            
            ws.send(JSON.stringify({ type: 'registered', success: true, message: 'Reconnected' }));
          } else {
            // Хешируем пароль
            const saltRounds = 10;
            const passwordHash = await bcrypt.hash(password, saltRounds);
            
            users.set(userId, {
              passwordHash,
              socket: ws,
              contacts: [],
              publicKey: publicKey,
              createdAt: Date.now()
            });
            currentUserId = userId;
            
            ws.send(JSON.stringify({ type: 'registered', success: true, message: 'User created' }));
            console.log(`✅ New user registered: ${userId}`);
          }
          break;

        // Аутентификация
        case 'login':
          const { userId: loginId, password: loginPassword } = data;
          const user = users.get(loginId);
          
          if (!user) {
            ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
            return;
          }
          
          const isValid = await bcrypt.compare(loginPassword, user.passwordHash);
          if (!isValid) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid password' }));
            return;
          }
          
          user.socket = ws;
          currentUserId = loginId;
          ws.send(JSON.stringify({ type: 'login_success', userId: loginId }));
          
          // Отправляем список контактов
          ws.send(JSON.stringify({
            type: 'contacts_list',
            contacts: user.contacts
          }));
          
          broadcastStatus(loginId);
          console.log(`🔓 User logged in: ${loginId}`);
          break;

        // Отправка сообщения (с шифрованием на клиенте)
        case 'message':
          const { from, to, content, messageId, encrypted } = data;
          
          if (!users.has(to)) {
            ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
            return;
          }
          
          const messageData = {
            type: 'message',
            from,
            content,
            messageId,
            timestamp: Date.now(),
            encrypted: encrypted || false
          };
          
          // Сохраняем сообщение для отслеживания
          messages.set(messageId, {
            from,
            to,
            content,
            expiresAt: Date.now() + 60000
          });
          
          // Отправляем получателю
          const delivered = sendToUser(to, messageData);
          
          if (delivered) {
            // Отправляем подтверждение отправителю
            sendToUser(from, {
              type: 'message_delivered',
              messageId,
              to
            });
            
            // Планируем удаление сообщения
            scheduleMessageDeletion(messageId, to, from);
          } else {
            sendToUser(from, {
              type: 'message_failed',
              messageId,
              reason: 'User offline'
            });
          }
          break;

        // Добавление контакта
        case 'add_contact':
          const { userId: contactUserId, contactId } = data;
          const currentUser = users.get(contactUserId);
          const contactUser = users.get(contactId);
          
          if (!currentUser || !contactUser) {
            ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
            return;
          }
          
          if (!currentUser.contacts.includes(contactId)) {
            currentUser.contacts.push(contactId);
            
            // Уведомляем контакт о добавлении
            sendToUser(contactId, {
              type: 'contact_added',
              by: contactUserId
            });
            
            ws.send(JSON.stringify({
              type: 'contact_added_success',
              contact: contactId
            }));
          }
          break;

        // Запрос на звонок (WebRTC)
        case 'call_request':
          const { from: caller, to: callee } = data;
          
          if (!users.has(callee)) {
            sendToUser(caller, { type: 'call_error', message: 'User offline' });
            return;
          }
          
          const roomId = generateRoomId();
          
          // Создаем комнату для звонка
          rooms.set(roomId, {
            participants: [caller, callee],
            createdAt: Date.now()
          });
          
          // Отправляем запрос вызываемому
          sendToUser(callee, {
            type: 'incoming_call',
            from: caller,
            roomId
          });
          
          // Отправляем комнату вызывающему
          sendToUser(caller, {
            type: 'call_initialized',
            roomId
          });
          
          console.log(`📞 Call initiated: ${caller} -> ${callee}, room: ${roomId}`);
          break;

        // WebRTC сигналинг
        case 'webrtc_signal':
          const { to: signalTo, signal, roomId: signalRoom } = data;
          
          sendToUser(signalTo, {
            type: 'webrtc_signal',
            from: currentUserId,
            signal,
            roomId: signalRoom
          });
          break;

        // Завершение звонка
        case 'end_call':
          const { roomId: endRoomId } = data;
          
          if (rooms.has(endRoomId)) {
            const room = rooms.get(endRoomId);
            room.participants.forEach(participant => {
              sendToUser(participant, {
                type: 'call_ended',
                roomId: endRoomId
              });
            });
            rooms.delete(endRoomId);
            console.log(`📞 Call ended: room ${endRoomId}`);
          }
          break;
      }
      
    } catch (e) {
      console.error('Error processing message:', e);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });

  ws.on('close', () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    
    if (currentUserId) {
      console.log(`👋 User disconnected: ${currentUserId}`);
      broadcastStatus(currentUserId);
      
      const user = users.get(currentUserId);
      if (user) user.socket = null;
    }
  });
});

// Очистка старых комнат каждый час
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, roomId) => {
    if (now - room.createdAt > 3600000) { // 1 час
      rooms.delete(roomId);
      console.log(`🧹 Cleaned up old room: ${roomId}`);
    }
  });
}, 3600000);

console.log('✅ Server is running on ws://localhost:8080');
console.log('📝 Features: encrypted messages, disappearing messages, WebRTC calls');