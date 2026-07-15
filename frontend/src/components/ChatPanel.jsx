import { useState } from 'react';

export default function ChatPanel({ messages, onSend, currentUserId }) {
  const [text, setText] = useState('');

  function submit(e) {
    e.preventDefault();
    if (!text.trim()) return;
    onSend(text.trim());
    setText('');
  }

  return (
    <div className="chat-panel">
      <div className="chat-messages">
        {messages.map((m) => (
          <div key={m.id} className={m.userId === currentUserId ? 'chat-msg mine' : 'chat-msg'}>
            <span className="chat-author" style={{ color: m.user?.avatarColor }}>{m.user?.name}</span>
            <span className="chat-body">{m.body}</span>
          </div>
        ))}
      </div>
      <form className="chat-input-row" onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message everyone..." />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
