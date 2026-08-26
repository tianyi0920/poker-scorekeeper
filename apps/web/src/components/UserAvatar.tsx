import { useEffect, useState } from 'react';

interface UserAvatarProps {
  nickname: string;
  avatarKind?: 'PRESET' | 'UPLOAD';
  avatarValue?: string;
  avatarUrl?: string;
  className?: string;
  label?: string;
  decorative?: boolean;
}

function nicknameInitial(nickname: string): string {
  return Array.from(nickname.trim())[0]?.toLocaleUpperCase('zh-CN') ?? '?';
}

function nicknameTone(nickname: string): number {
  return Array.from(nickname).reduce((hash, character) => ((hash * 31) + (character.codePointAt(0) ?? 0)) >>> 0, 0) % 6;
}

function uploadedAvatarSource({ avatarKind, avatarValue, avatarUrl }: Pick<UserAvatarProps, 'avatarKind' | 'avatarValue' | 'avatarUrl'>): string | null {
  if (avatarKind === 'UPLOAD' && avatarValue !== undefined) return `/avatars/uploads/${avatarValue}`;
  if (avatarKind === 'PRESET') return null;
  return avatarUrl?.includes('/avatars/uploads/') === true ? avatarUrl : null;
}

export function UserAvatar(props: UserAvatarProps) {
  const { nickname, className = '', decorative = false } = props;
  const source = uploadedAvatarSource(props);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  useEffect(() => setFailedSource(null), [source]);
  const classes = ['user-avatar', `user-avatar--tone-${nicknameTone(nickname)}`, className].filter(Boolean).join(' ');
  const label = props.label ?? `${nickname}的头像`;

  if (source !== null && failedSource !== source) {
    return <img className={classes} src={source} alt={decorative ? '' : label} onError={() => setFailedSource(source)} />;
  }

  return <span className={classes} role={decorative ? undefined : 'img'} aria-label={decorative ? undefined : label} aria-hidden={decorative || undefined}>{nicknameInitial(nickname)}</span>;
}
