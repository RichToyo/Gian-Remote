export const MCP_MAX_REQUEST_BYTES = 1_048_576;
export const MCP_MAX_INPUT_ELEMENTS = 10_000;
export const MCP_MAX_INPUT_DEPTH = 64;

export class McpInputLimitError extends Error {}

/** Bound the entire JSON envelope before the SDK allocates validation errors. */
export function assertBoundedMcpJson(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let elements = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.value === null || typeof current.value !== 'object') continue;
    if (current.depth > MCP_MAX_INPUT_DEPTH) {
      throw new McpInputLimitError('MCP request nesting limit exceeded');
    }
    const keys = Object.keys(current.value);
    elements += keys.length;
    if (elements > MCP_MAX_INPUT_ELEMENTS) {
      throw new McpInputLimitError('MCP request element limit exceeded');
    }
    for (const key of keys) {
      pending.push({
        value: (current.value as Record<string, unknown>)[key],
        depth: current.depth + 1,
      });
    }
  }
}

export async function readBoundedMcpJson(chunks: AsyncIterable<Uint8Array>): Promise<unknown> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  for await (const chunk of chunks) {
    bytes += chunk.byteLength;
    if (bytes > MCP_MAX_REQUEST_BYTES) {
      throw new McpInputLimitError('MCP request byte limit exceeded');
    }
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object') {
    throw new SyntaxError('MCP request must be a JSON object');
  }
  assertBoundedMcpJson(value);
  return value;
}
