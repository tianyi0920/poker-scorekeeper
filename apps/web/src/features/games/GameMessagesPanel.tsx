import type { GameMessageDto } from '@poker/contracts';

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

export function GameMessagesPanel({ messages }: { messages: GameMessageDto[] }) {
  if (messages.length === 0) {
    return <div className="game-messages-empty">本场还没有消息</div>;
  }

  return (
    <ol className="game-messages-list" aria-label="本场消息">
      {messages.map((message) => (
        <li key={message.id} className="game-message">
          <img src={message.avatarUrl} alt={`${message.nickname}的头像`} />
          <div>
            <p><strong>{message.nickname}</strong><time dateTime={message.createdAt}>{timeFormatter.format(new Date(message.createdAt))}</time></p>
            <span>{message.text}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}
