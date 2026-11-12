import { Injectable, type CanActivate } from '@nestjs/common';
import { PlatformContext } from '../../core/tenant/platform-context.js';
@Injectable()
export class PlatformOnlyGuard implements CanActivate {
  constructor(private readonly platform: PlatformContext) {}
  canActivate(): boolean {
    this.platform.assertPlatform();
    return true;
  }
}
