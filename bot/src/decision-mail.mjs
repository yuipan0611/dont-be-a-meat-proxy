import { readFile, lstat } from 'node:fs/promises';
import { createMailClient } from '../../client/mail-client.mjs';

export async function createDecisionMailWriter({ url, token, projectKey, senderFile }) {
  let sender;
  try {
    const st = await lstat(senderFile);
    if (!st.isFile() || (st.mode & 0o077)) throw new Error('private mode required');
    sender = JSON.parse(await readFile(senderFile, 'utf8'));
    if (sender.projectKey !== projectKey || !/^[A-Za-z]+$/.test(sender.agentName ?? '') ||
        typeof sender.senderToken !== 'string' || !sender.senderToken) throw new Error('identity mismatch');
  } catch {
    throw new Error('Decision Mail writer identity unavailable or invalid');
  }
  const client = createMailClient({ url, token, projectKey, agentName: sender.agentName, senderToken: sender.senderToken });
  return {
    async sendDecision(message) {
      if (message.project_key !== projectKey) throw new Error('Decision group boundary');
      const receipt = await client.callTool('send_message', { ...message,
        sender_name: sender.agentName, sender_token: sender.senderToken });
      return { messageId: receipt.message_id };
    },
  };
}
