import { Body, Post, HttpCode } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { CrudController, BaseController } from '../../../../core/crud/index.js';
import { ApiResult, ApiErrors } from '../../../../core/swagger/api-result.js';
import { Perms } from '../../../../core/permission/perms.decorator.js';
import { CodeRule, CodeSequence } from '../../entity/code-rule.entity.js';
import {
  CodeRuleService,
  CodeSequenceService,
} from '../../service/code-rule.service.js';
import {
  CodeBindingBody,
  CodePreviewBody,
  CodePreviewResult,
  CodeUsageResult,
  CodeHistoryResult,
  CodeRuleValidateBody,
  CodeTimeZoneResult,
} from '../../dto/code-rule.dto.js';
import { timeZoneCatalog } from '../../../../core/time/time-zones.js';
import {
  validateConfig,
  compatible,
  invalid,
  renderCode,
  periodKey,
  maximum,
} from '../../service/rule-config.js';

@CrudController({
  prefix: 'system/code-rule',
  label: '编码规则',
  entity: CodeRule,
  service: CodeRuleService,
  api: ['page', 'info', 'add', 'update', 'delete'],
  pageQuery: { keyWords: ['code', 'name'], fieldEq: ['status', 'resetPeriod'] },
})
export class CodeRuleController extends BaseController<CodeRule> {
  constructor(private readonly rules: CodeRuleService) {
    super();
  }
  @Post('timezones')
  @HttpCode(200)
  @Perms('system:code-rule:page')
  @ApiOperation({
    operationId: 'codeRuleTimeZones',
    summary: '系统维护的IANA时区目录，含中文城市名',
  })
  @ApiResult(CodeTimeZoneResult)
  timeZones() {
    return { list: timeZoneCatalog() };
  }
  @Post('usage/list')
  @HttpCode(200)
  @Perms('system:code-rule:page')
  @ApiOperation({
    operationId: 'codeRuleUsageList',
    summary: '已注册编码用途与绑定',
  })
  @ApiResult(CodeUsageResult)
  async usages() {
    return { list: await this.rules.usageList() };
  }
  @Post('binding/set')
  @HttpCode(200)
  @Perms('system:code-rule:bind', { risk: 'high' })
  @ApiOperation({
    operationId: 'codeRuleBindingSet',
    summary: '建立或切换编码规则绑定',
  })
  @ApiResult(CodeBindingBody)
  @ApiErrors(400, 403, 404, 409)
  bind(@Body() body: CodeBindingBody) {
    return this.rules.bind(body.usageKey, body.ruleId);
  }
  @Post('preview')
  @HttpCode(200)
  @Perms('system:code-rule:preview')
  @ApiOperation({
    operationId: 'codeRulePreview',
    summary: '预览后续编码，不占用号码',
  })
  @ApiResult(CodePreviewResult)
  @ApiErrors(400, 403, 404, 409)
  preview(@Body() body: CodePreviewBody) {
    return this.rules.preview(body.ruleId, body.usageKey);
  }
  @Post('history')
  @HttpCode(200)
  @Perms('system:code-rule:info')
  @ApiOperation({ operationId: 'codeRuleHistory', summary: '编码规则审计快照' })
  @ApiResult(CodeHistoryResult)
  async history(@Body() body: CodePreviewBody) {
    return { list: await this.rules.versions(body.ruleId) };
  }
  @Post('validate')
  @HttpCode(200)
  @Perms('system:code-rule:preview')
  @ApiOperation({
    operationId: 'codeRuleValidate',
    summary: '校验规则与用途兼容性，不写入',
  })
  @ApiResult(CodePreviewResult)
  async validate(@Body() body: CodeRuleValidateBody) {
    const config = validateConfig(body.data);
    if (body.usageKey) {
      const usage = (await this.rules.usages.catalog()).find(
        (u) => u.key === body.usageKey,
      );
      if (!usage) invalid('请选择已注册的用途', 'usageKey');
      compatible(config, usage);
    }
    const now = new Date(),
      start = BigInt(config.start);
    return {
      codes: [0n, 1n, 2n]
        .map((n) => start + n)
        .filter((n) => n <= maximum(config))
        .map((n) => renderCode(config, n, now)),
      periodKey: periodKey(config, now),
      consumes: false,
    };
  }
}
@CrudController({
  prefix: 'system/code-sequence',
  label: '编码序号',
  entity: CodeSequence,
  service: CodeSequenceService,
  delete: 'hard',
  api: ['page', 'info'],
  pageQuery: {
    keyWords: ['periodKey', 'lastCode'],
    fieldEq: ['ruleId', 'periodKey'],
  },
})
export class CodeSequenceController extends BaseController<CodeSequence> {}
