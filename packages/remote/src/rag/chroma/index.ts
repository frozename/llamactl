import type { RetrievalProvider } from '@nova/contracts';
import type { RagBinding } from '../../config/schema.js';
import { ChromaRagAdapter } from './adapter.js';
import { connectChromaMcp } from './client.js';

export { ChromaRagAdapter } from './adapter.js';
export {
  connectChromaMcp,
  type ChromaMcpClient,
  type ChromaMcpConnection,
  type ChromaToolResult,
} from './client.js';

/**
 * Factory — boots the chroma-mcp subprocess and returns an adapter
 * ready for the `RetrievalProvider` surface. Callers own the returned
 * instance's lifetime; `close()` tears down the subprocess.
 */
export async function createChromaAdapter(
  binding: RagBinding,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RetrievalProvider> {
  const { client, close } = await connectChromaMcp(binding, env);
  return new ChromaRagAdapter(client, binding, close);
}
