import { Injectable } from '@nestjs/common';
import type { Principal } from '../tenant/request-context.js';
/** 仅内存对象身份绑定；外部HTTP头或JSON不能伪造。 */
@Injectable()
export class InternalAction {
  private readonly requests = new WeakMap<object, Principal>();
  bind(request: object, principal: Principal) {
    this.requests.set(request, principal);
  }
  principal(request: object) {
    return this.requests.get(request);
  }
}
