import { sendJson } from '../lib/http.js';
import { getUsage } from '../lib/quota.js';
import type { AuthUser } from '../lib/types.js';

export async function handleMe(user: AuthUser, stream: awslambda.ResponseStream) {
  const usage = await getUsage(user.sub);
  await sendJson(stream, 200, { sub: user.sub, username: user.username, usage });
}
