export function normalizeUsername(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

export function normalizeNickname(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
}
