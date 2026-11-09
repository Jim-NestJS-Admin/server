import { Body, Get, HttpCode, Module, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IsDefined, Matches } from 'class-validator';
import { AdminController } from '../endpoint/endpoint.decorators.js';
import { BusinessException } from '../exceptions/business.exception.js';
import { ErrorCode } from '../exceptions/error-code.js';
import { LoginOnly } from '../permission/perms.decorator.js';
import { ApiErrors, ApiResult } from '../swagger/api-result.js';
import { TenantRepositoryFactory } from '../tenant/tenant-repository.js';
import { RequestContext } from '../tenant/request-context.js';
import { UserPreferenceEntity } from './user-preference.entity.js';

const KEY = /^[a-z][a-z0-9:_./-]{0,99}$/;
const MAX_BYTES = 64 * 1024;

class PreferenceKeyDto {
  @ApiProperty({
    example: 'query:system:user',
    description: '小写字母开头，最多 100 字',
  })
  @Matches(KEY, { message: '偏好键格式不对' })
  key!: string;
}

class SavePreferenceDto extends PreferenceKeyDto {
  @ApiProperty({
    description:
      '任意 JSON，最多 64KB（常用查询就是 query.md 的 where 加名字）',
  })
  @IsDefined()
  value!: unknown;
}

class PreferenceResult {
  @ApiProperty() key!: string;
  @ApiPropertyOptional({ description: '没有保存过时是 null' })
  value!: unknown;
}

/**
 * 当前用户的个人偏好（T18 常用查询、列设置）：身份和当前组织从会话取，只能读写自己的。
 * 登录即可，不用权限码（@LoginOnly）。
 */
@ApiTags('auth 登录认证')
@ApiBearerAuth()
@LoginOnly()
@AdminController('session/preference')
export class PreferenceController {
  constructor(
    private readonly repos: TenantRepositoryFactory,
    private readonly context: RequestContext,
  ) {}

  private who() {
    const { userId, orgId } = this.context.current();
    return { userId: userId!, scope: orgId ?? '-' };
  }

  private find(key: string) {
    const { userId, scope } = this.who();
    return this.repos
      .for(UserPreferenceEntity)
      .query('p')
      .andWhere('p.userId = :u AND p.scope = :s AND p.key = :k', {
        u: userId,
        s: scope,
        k: key,
      })
      .getOne();
  }

  @Get()
  @ApiOperation({
    operationId: 'sessionPreferenceGet',
    summary: '读一项个人偏好',
  })
  @ApiResult(PreferenceResult)
  @ApiErrors(400, 401)
  async get(@Query() q: PreferenceKeyDto): Promise<PreferenceResult> {
    const row = await this.find(q.key);
    return { key: q.key, value: row?.value ?? null };
  }

  @Post('save')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'sessionPreferenceSave',
    summary: '保存一项个人偏好（覆盖）',
  })
  @ApiResult(PreferenceResult)
  @ApiErrors(400, 401)
  async save(@Body() b: SavePreferenceDto): Promise<PreferenceResult> {
    if (Buffer.byteLength(JSON.stringify(b.value), 'utf8') > MAX_BYTES)
      throw new BusinessException(
        ErrorCode.BadRequest,
        '内容太大，最多 64KB',
        400,
      );
    const repo = this.repos.for(UserPreferenceEntity);
    const existing = await this.find(b.key);
    if (existing) await repo.update([existing.id], { value: b.value });
    else {
      const { userId, scope } = this.who();
      try {
        await repo.insert({ userId, scope, key: b.key, value: b.value });
      } catch {
        // 并发保存同一个键：另一个请求先插入了，改成更新
        const row = await this.find(b.key);
        if (!row)
          throw new BusinessException(ErrorCode.Conflict, undefined, 409);
        await repo.update([row.id], { value: b.value });
      }
    }
    return { key: b.key, value: b.value };
  }

  @Post('delete')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'sessionPreferenceDelete',
    summary: '删除一项个人偏好',
  })
  @ApiResult()
  @ApiErrors(400, 401)
  async remove(@Body() b: PreferenceKeyDto): Promise<null> {
    const row = await this.find(b.key);
    if (row) await this.repos.for(UserPreferenceEntity).remove([row.id]);
    return null;
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([UserPreferenceEntity])],
  controllers: [PreferenceController],
})
export class PreferenceModule {}
