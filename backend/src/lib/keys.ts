/** DynamoDB key construction. Every key embeds the caller's verified `sub` (ownership by construction). */
export const userPk = (sub: string) => `USER#${sub}`;
export const sessionSk = (sessionId: string) => `SESSION#${sessionId}`;
export const SESSION_SK_PREFIX = 'SESSION#';
export const messagesPk = (sub: string, sessionId: string) => `USER#${sub}#SESSION#${sessionId}`;
export const messageSk = (createdAt: string, messageId: string) => `MSG#${createdAt}#${messageId}`;
export const MESSAGE_SK_PREFIX = 'MSG#';
export const usageSk = (date: string) => `USAGE#${date}`;
