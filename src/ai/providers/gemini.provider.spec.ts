import { afterEach, beforeEach, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { env } from '../../config/env';
import { type AiChatRequest, AiProviderError } from '../ai-provider';
import { GEMINI_MODEL, GeminiProvider } from './gemini.provider';

// The real @google/genai SDK with a stand-in for fetch: its request building, stream
// parsing, retries and ApiError are exercised, and no request ever leaves the machine.

/** Fake, and distinctive, so a leak into logs or errors is easy to spot */
const KEY = 'unit-test-fake-gemini-key-000';

const REQUEST: AiChatRequest = {
  system: 'You help pick a gift.',
  messages: [
    { role: 'user', content: 'Ideas?' },
    { role: 'assistant', content: 'A book.' },
    { role: 'user', content: 'Something else?' },
  ],
};

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
let fetchMock: jest.Mock<FetchFn>;
const realFetch = globalThis.fetch;
let warn: jest.SpiedFunction<Logger['warn']>;

/** A streamed answer: one server-sent event per chunk */
const sseResponse = (chunks: object[]) =>
  new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

const errorResponse = (status: number, reason = 'SOMETHING') =>
  new Response(
    JSON.stringify({
      error: {
        code: status,
        message: `failed (key ${KEY})`, // even an echoed key must not leak further
        status: reason,
        details: [{ reason }],
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );

const textChunk = (text: string, extra: object = {}) => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, ...extra }],
});

async function collect(request: AiChatRequest = REQUEST) {
  const out: string[] = [];
  for await (const text of new GeminiProvider().streamChat(request)) {
    out.push(text);
  }
  return out;
}

/** The AiFailure the stream ends with */
async function failureOf(request: AiChatRequest = REQUEST) {
  try {
    await collect(request);
  } catch (error) {
    expect(error).toBeInstanceOf(AiProviderError);
    const message = String((error as Error).message);
    expect(message).not.toContain(KEY);
    return (error as AiProviderError).failure;
  }
  throw new Error('expected the stream to fail');
}

beforeEach(() => {
  env.geminiApiKey = KEY;
  fetchMock = jest.fn<FetchFn>();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  // Nothing the provider logged may carry the key
  for (const call of warn.mock.calls) {
    expect(JSON.stringify(call)).not.toContain(KEY);
  }
  globalThis.fetch = realFetch;
  env.geminiApiKey = undefined;
  jest.restoreAllMocks();
});

describe('GeminiProvider', () => {
  it('answers not_configured without a key, without calling Google', async () => {
    env.geminiApiKey = undefined;
    expect(await failureOf()).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('streams the visible text, skipping thoughts', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'thinking…', thought: true }],
              },
            },
          ],
        },
        textChunk('Idea one. '),
        textChunk('Idea two.', { finishReason: 'STOP' }),
      ]),
    );

    expect(await collect()).toEqual(['Idea one. ', 'Idea two.']);
  });

  it('sends the system prompt and the history in Gemini format, the key only in a header', async () => {
    fetchMock.mockResolvedValue(sseResponse([textChunk('ok')]));
    await collect();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`models/${GEMINI_MODEL}:streamGenerateContent`);
    expect(url).not.toContain(KEY);
    expect(new Headers(init.headers).get('x-goog-api-key')).toBe(KEY);

    const body = JSON.parse(init.body as string) as {
      contents: { role: string; parts: { text: string }[] }[];
      systemInstruction: { parts: { text: string }[] };
    };
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Ideas?' }] },
      { role: 'model', parts: [{ text: 'A book.' }] },
      { role: 'user', parts: [{ text: 'Something else?' }] },
    ]);
    expect(body.systemInstruction.parts[0].text).toBe(REQUEST.system);
  });

  it('maps a server error to unavailable (after the SDK retries)', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(errorResponse(500)));
    expect(await failureOf()).toBe('unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalled();
  }, 20_000);

  it('logs why Google refused, as its status word', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(errorResponse(503, 'UNAVAILABLE')),
    );
    expect(await failureOf()).toBe('unavailable');
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain(
      'status 503, UNAVAILABLE',
    );
  }, 20_000);

  it("maps Google's rate limit to busy, without retrying (that would spend the quota again)", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(errorResponse(429, 'RESOURCE_EXHAUSTED')),
    );
    expect(await failureOf()).toBe('busy');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a stream cut off mid-reply as unavailable — the reply text never reaches the log', async () => {
    // What Google sends under load: a streamed answer, then an error the SDK can't read
    fetchMock.mockResolvedValue(
      new Response(
        `data: ${JSON.stringify(textChunk('secret reply text '))}\n\n{"error": {"code": 503, "status": "UNAVAILABLE"`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    expect(await failureOf()).toBe('unavailable');
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('stream cut off');
    expect(logged).not.toContain('secret reply text');
  });

  it('maps a timeout to timeout', async () => {
    // What fetch throws when the SDK's per-attempt timeout fires. Built as an Error of
    // this realm: Jest's sandbox doesn't see Node's DOMException as an Error
    fetchMock.mockRejectedValue(
      Object.assign(new Error('The operation timed out.'), {
        name: 'TimeoutError',
      }),
    );
    expect(await failureOf()).toBe('timeout');
  }, 20_000);

  it('maps a connection error to unavailable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await failureOf()).toBe('unavailable');
  }, 20_000);

  it('reports aborted when the browser goes away, without logging it', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_url, init) => {
      controller.abort();
      return Promise.reject(
        init.signal?.reason ?? new DOMException('aborted', 'AbortError'),
      );
    });
    expect(await failureOf({ ...REQUEST, signal: controller.signal })).toBe(
      'aborted',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('maps a malformed request to invalid_request', async () => {
    fetchMock.mockResolvedValue(errorResponse(400, 'INVALID_ARGUMENT'));
    expect(await failureOf()).toBe('invalid_request');
  });

  it('maps a rejected key to not_configured', async () => {
    fetchMock.mockResolvedValue(errorResponse(400, 'API_KEY_INVALID'));
    expect(await failureOf()).toBe('not_configured');

    fetchMock.mockResolvedValue(errorResponse(403, 'PERMISSION_DENIED'));
    expect(await failureOf()).toBe('not_configured');
  });

  it('maps a safety stop to refused', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([textChunk('', { finishReason: 'SAFETY' })]),
    );
    expect(await failureOf()).toBe('refused');

    fetchMock.mockResolvedValue(
      sseResponse([{ promptFeedback: { blockReason: 'SAFETY' } }]),
    );
    expect(await failureOf()).toBe('refused');
  });
});
