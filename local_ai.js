import { config } from './config.js';

export async function generateLocalResponse(
  prompt,
  { systemInstruction = '', format, fetchImpl = fetch } = {}
) {
  const endpoint = `${config.ollamaBaseUrl.replace(/\/+$/, '')}/api/chat`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.ollamaTimeoutMs);
  timeout.unref?.();

  try {
    const messages = [];
    if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
    messages.push({ role: 'user', content: prompt });

    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel,
        messages,
        stream: false,
        think: false,
        ...(format ? { format } : {})
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`Ollama returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }

    const result = await response.json();
    const text = result?.message?.content?.trim();
    if (!text) throw new Error('Ollama returned an empty response.');
    return text;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Ollama did not respond within ${Math.ceil(config.ollamaTimeoutMs / 1000)} seconds.`);
    }
    if (error instanceof TypeError) {
      throw new Error(`Could not connect to Ollama at ${config.ollamaBaseUrl}. Ensure Ollama is running.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
