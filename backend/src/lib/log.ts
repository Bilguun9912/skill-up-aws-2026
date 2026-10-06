/**
 * Structured JSON logging. NEVER pass JWTs, prompts, user messages, or model output here —
 * only ids, routes, latencies, counts and token usage.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, string | number | boolean | null | undefined>;

function emit(level: Level, msg: string, fields?: LogFields): void {
  const line = JSON.stringify({ level, msg, time: new Date().toISOString(), ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** Safe error summary for logs: name + message only (no stack bodies with request data). */
export function errFields(err: unknown): LogFields {
  if (err instanceof Error) return { errName: err.name, errMessage: err.message.slice(0, 300) };
  return { errName: 'unknown' };
}

export const log = {
  debug: (msg: string, f?: LogFields) => emit('debug', msg, f),
  info: (msg: string, f?: LogFields) => emit('info', msg, f),
  warn: (msg: string, f?: LogFields) => emit('warn', msg, f),
  error: (msg: string, f?: LogFields) => emit('error', msg, f),
};
