const WebSocket = require('ws');

// Создаём сервер на порту 8080
const wss = new WebSocket.Server({ port: 8080 });

const users = new Map();

console.log('✅ Server started on ws://0.0.0.0:8080');

function broadcastStatus(nickname) {
  const user = users.get(nickname);
  if (!user) return;

  user.contacts.forEach(contactNick => {
    const contact = users.get(contactNick);
    if (contact && contact.socket && contact.socket.readyState === WebSocket.OPEN) {
      contact.socket.send(JSON.stringify({
        type: 'status',
        userId: nickname,
        online: user.socket.readyState === WebSocket.OPEN
      }));
    }
  });
}

wss.on('connection', (ws, req) => {
  let currentNick = null;
  
  console.log('📱 New client connected');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('📨 Received:', data.type);

      if (data.type === 'register') {
        const { userId, password } = data;
        
        if (!users.has(userId)) {
          users.set(userId, {
            password: password,
            socket: ws,
            contacts: []
          });
          console.log(`✅ New user: ${userId}`);
        } else {
          const existingUser = users.get(userId);
          existingUser.socket = ws;
          console.log(`🔄 User reconnected: ${userId}`);
        }
        
        currentNick = userId;
        
        ws.send(JSON.stringify({
          type: 'registered',
          success: true,
          userId: userId
        }));
        
        const user = users.get(userId);
        ws.send(JSON.stringify({
          type: 'contacts_list',
          contacts: user.contacts
        }));
        
        broadcastStatus(userId);
      }
      
      else if (data.type === 'message') {
        const { from, to, content, messageId } = data;
        const target = users.get(to);
        
        if (target && target.socket && target.socket.readyState === WebSocket.OPEN) {
          target.socket.send(JSON.stringify({
            type: 'message',
            from: from,
            content: content,
            messageId: messageId,
            timestamp: Date.now()
          }));
          
          console.log(`📨 Message: ${from} → ${to}: ${content}`);
          
          setTimeout(() => {
            if (target.socket && target.socket.readyState === WebSocket.OPEN) {
              target.socket.send(JSON.stringify({
                type: 'delete_message',
                messageId: messageId
              }));
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
          
          ws.send(JSON.stringify({
            type: 'contact_added_success',
            contact: contactId
          }));
        }
      }
      
    } catch (e) {
      console.error('Error:', e);
    }
  });
  
  ws.on('close', () => {
    if (currentNick) {
      console.log(`👋 User disconnected: ${currentNick}`);
      const user = users.get(currentNick);
      if (user) user.socket = null;
      broadcastStatus(currentNick);
    }
  });
});

console.log('🎉 Server ready!');