import { DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  CodeRule,
  CodeRuleVersion,
  CodeBinding,
  CodeSequence,
  CodeAllocation,
} from './entity/code-rule.entity.js';
import {
  CodeRuleService,
  CodeSequenceService,
} from './service/code-rule.service.js';
import { CODE_USAGES, CodeUsageRegistry } from './service/usage-registry.js';
import { CodeUsageDiagnostics } from './service/usage-diagnostics.js';
import { CodeSequenceStore } from './service/code-sequence.store.js';
import type { CodeUsage } from './service/rule-config.js';
import {
  CodeRuleController,
  CodeSequenceController,
} from './controller/admin/code-rule.controller.js';
@Module({})
export class CodeRuleModule {
  static forRoot(options: { usages: readonly CodeUsage[] }): DynamicModule {
    return {
      module: CodeRuleModule,
      global: true,
      imports: [
        TypeOrmModule.forFeature([
          CodeRule,
          CodeRuleVersion,
          CodeBinding,
          CodeSequence,
          CodeAllocation,
        ]),
      ],
      controllers: [CodeRuleController, CodeSequenceController],
      providers: [
        { provide: CODE_USAGES, useValue: options.usages },
        CodeUsageRegistry,
        CodeUsageDiagnostics,
        CodeSequenceStore,
        CodeRuleService,
        CodeSequenceService,
      ],
      exports: [CodeRuleService, CodeUsageRegistry],
    };
  }
}
