import { Injectable } from '@nestjs/common';

export type HealthCheck = () => Promise<void>;

/**
 * 健康检查注册表。数据库、Redis 等模块落地后（T03、T04）在这里注册各自的检查，/health 会一起检测。
 */
@Injectable()
export class HealthService {
  private readonly checks = new Map<string, HealthCheck>();

  register(name: string, check: HealthCheck): void {
    this.checks.set(name, check);
  }

  async run(timeoutMs = 3000): Promise<{
    status: 'ok' | 'error';
    checks: Record<string, 'ok' | 'error'>;
  }> {
    const entries = await Promise.all(
      [...this.checks].map(async ([name, check]) => {
        try {
          await Promise.race([
            check(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), timeoutMs),
            ),
          ]);
          return [name, 'ok'] as const;
        } catch {
          return [name, 'error'] as const;
        }
      }),
    );
    const checks = Object.fromEntries(entries);
    return {
      status: entries.every(([, s]) => s === 'ok') ? 'ok' : 'error',
      checks,
    };
  }
}
