import { Module } from '@nestjs/common';
import { AuthModule } from './core/auth/auth.module.js';
import { CoreModule } from './core/core.module.js';

@Module({
  // T07 接入后：AuthModule.forRoot({ userStore: SystemAuthUserStore, imports: [SystemModule] })
  imports: [CoreModule, AuthModule.forRoot()],
})
export class AppModule {}
