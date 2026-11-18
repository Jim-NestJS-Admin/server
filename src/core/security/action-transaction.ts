import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { EntityManager } from 'typeorm';

interface Boundary {
  before(manager: EntityManager): Promise<void>;
  after(manager: EntityManager, result: unknown): Promise<void>;
  manager?: EntityManager;
  committed?: boolean;
}
/** 外部动作消费记录与实际业务事务绑定，不向HTTP暴露事务凭据。 */
@Injectable()
export class ActionTransaction {
  private readonly storage = new AsyncLocalStorage<Boundary>();
  async run<T>(boundary: Boundary, fn: () => Promise<T>): Promise<T> {
    return this.storage.run(boundary, async () => {
      const result = await fn();
      if (!boundary.committed)
        throw new Error('外部写操作必须使用统一业务事务');
      return result;
    });
  }
  current() {
    return this.storage.getStore();
  }
  assertWrite(manager: EntityManager) {
    const boundary = this.current();
    if (boundary && boundary.manager !== manager)
      throw new Error('外部动作禁止在确认事务外写入');
  }
}
