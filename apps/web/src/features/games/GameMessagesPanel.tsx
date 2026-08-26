import type { GameMessageDto } from '@poker/contracts';
import { UserAvatar } from '../../components/UserAvatar.js';

export function formatMessageRelativeTime(createdAt: string, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 1_000));
  if (elapsedSeconds < 60) return '刚刚';
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}分钟前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}小时前`;
  return `${Math.floor(elapsedHours / 24)}天前`;
}

export function GameMessagesPanel({ messages }: { messages: GameMessageDto[] }) {
  if (messages.length === 0) {
    return <div className="game-messages-empty">本场还没有消息</div>;
  }

  return (
    <ol className="game-messages-list" aria-label="本场消息">
      {messages.map((message) => (
        <li key={message.id} className="game-message">
          <UserAvatar nickname={message.nickname} avatarUrl={message.avatarUrl} />
          <div>
            <p><strong>{message.nickname}</strong><time dateTime={message.createdAt}>{formatMessageRelativeTime(message.createdAt)}</time></p>
            <span>{message.text}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}
