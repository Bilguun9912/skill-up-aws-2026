export interface Citation {
  n: number;
  source: 'pmbok' | 'user';
  edition?: '6' | '7';
  title: string;
  page?: number;
  excerpt: string;
  score?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface AuthUser {
  sub: string;
  username: string;
}

export type UiLang = 'ja' | 'en';
