/** Wrap a structured result as an MCP text content block. */
export function jsonContent(data: unknown): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
