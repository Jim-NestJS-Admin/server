import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
export interface AiRequest {
  apiKey: string;
  model: string;
  prompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
}
export interface AiResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}
export class AiProviderFailure extends Error {
  constructor(readonly definite: boolean) {
    super('模型调用未完成');
  }
}
export abstract class AiProvider {
  abstract count(input: AiRequest): Promise<number>;
  abstract generate(input: AiRequest): Promise<AiResponse>;
  async stream(
    input: AiRequest,
    onText: (text: string) => Promise<void>,
  ): Promise<AiResponse> {
    const result = await this.generate(input);
    await onText(result.text);
    return result;
  }
}
/** 固定官方地址，关闭SDK重试；结果不确定时保留预占，禁止重复计费请求。 */
@Injectable()
export class AnthropicProvider extends AiProvider {
  override async stream(
    input: AiRequest,
    onText: (text: string) => Promise<void>,
  ): Promise<AiResponse> {
    try {
      const stream = this.client(input).messages.stream({
        model: input.model,
        max_tokens: input.maxOutputTokens,
        messages: [{ role: 'user', content: input.prompt }],
      });
      let text = '';
      for await (const event of stream)
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          text += event.delta.text;
          await onText(text);
        }
      const result = await stream.finalMessage();
      return {
        text,
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
      };
    } catch (error) {
      throw new AiProviderFailure(
        error instanceof Anthropic.APIError &&
          [400, 401, 403, 404, 413, 422, 429].includes(error.status ?? 0),
      );
    }
  }
  private client(input: AiRequest) {
    return new Anthropic({
      apiKey: input.apiKey,
      baseURL: 'https://api.anthropic.com',
      maxRetries: 0,
      timeout: input.timeoutMs,
      logLevel: 'off',
    });
  }
  async count(input: AiRequest) {
    const response = await this.client(input).messages.countTokens({
      model: input.model,
      messages: [{ role: 'user', content: input.prompt }],
    });
    return response.input_tokens;
  }
  async generate(input: AiRequest): Promise<AiResponse> {
    try {
      const result = await this.client(input).messages.create({
        model: input.model,
        max_tokens: input.maxOutputTokens,
        messages: [{ role: 'user', content: input.prompt }],
      });
      return {
        text: result.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n'),
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
      };
    } catch (error) {
      // 明确拒绝且未执行的4xx可释放；超时/5xx/网络中断可能已经产生费用。
      throw new AiProviderFailure(
        error instanceof Anthropic.APIError &&
          [400, 401, 403, 404, 413, 422, 429].includes(error.status ?? 0),
      );
    }
  }
}
