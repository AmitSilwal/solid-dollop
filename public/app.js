const socket = io();
const form = document.getElementById('chat-form');
const input = document.getElementById('input');
const messages = document.getElementById('messages');

function appendMessage(text) {
  const item = document.createElement('li');
  item.textContent = text;
  messages.appendChild(item);
  window.scrollTo(0, document.body.scrollHeight);
}

function sendMessage() {
  const text = input.value.trim();

  if (!text) {
    return;
  }

  socket.emit('chat message', text);
  input.value = '';
}

form.addEventListener('submit', function onSubmit(event) {
  event.preventDefault();
  sendMessage();
});

socket.on('chat message', function onChatMessage(msg) {
  appendMessage(msg);
});
