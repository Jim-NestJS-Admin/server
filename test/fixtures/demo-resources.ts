import { Injectable } from '@nestjs/common';
import {
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { Column, Entity, Index } from 'typeorm';
import {
  BaseController,
  BaseEntity,
  BaseService,
  CrudController,
  CrudField,
  crudErrors,
  type CrudTx,
} from '../../src/core/crud/index.js';

/** 端到端测试用的资源，只在测试里注册，不进正式应用 */
@Entity('demo_user')
@Index('uk_demo_user_username', ['tenantId', 'username'], { unique: true })
export class DemoUserEntity extends BaseEntity {
  @CrudField({
    label: '账号',
    list: { sortable: true, width: 140 },
    form: { required: true },
    edit: 'add',
  })
  @IsString()
  @Length(2, 32)
  @Column({ type: 'varchar', length: 32 })
  username: string;

  @CrudField({
    label: '姓名',
    list: { sortable: true },
    form: { required: true },
  })
  @IsString()
  @Length(1, 32)
  @Column({ type: 'varchar', length: 32 })
  nickname: string;

  @CrudField({
    label: '状态',
    list: {},
    dict: [
      { value: 'enabled', label: '正常' },
      { value: 'disabled', label: '停用' },
    ],
  })
  @IsOptional()
  @IsIn(['enabled', 'disabled'])
  @Column({ type: 'varchar', length: 16, default: 'enabled' })
  status: string;

  @CrudField({ label: '所属组织', list: false, form: false, nullable: true })
  @IsOptional()
  @Matches(/^[1-9]\d{0,19}$/)
  @Column({ type: 'bigint', unsigned: true, nullable: true })
  orgId: string | null;

  @CrudField({
    label: '备注',
    list: false,
    form: { component: 'textarea' },
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Column({ type: 'varchar', length: 200, nullable: true })
  remark: string | null;
}

/** 带钩子的 Service：用来测钩子在事务里执行、抛异常能整体回滚 */
@Injectable()
export class DemoUserService extends BaseService<DemoUserEntity> {
  readonly calls: string[] = [];

  protected override async beforeAdd(
    data: Partial<DemoUserEntity>,
  ): Promise<void> {
    this.calls.push('beforeAdd');
    if (data.username === 'blocked')
      throw crudErrors.badRequest('这个账号不允许注册', [
        { field: 'username', messages: ['这个账号不允许注册'] },
      ]);
    // 钩子想偷偷改系统字段：框架必须忽略
    (data as Record<string, unknown>).tenantId = '999';
    (data as Record<string, unknown>).version = 99;
  }

  protected override async afterAdd(
    row: DemoUserEntity,
    tx: CrudTx,
  ): Promise<void> {
    this.calls.push('afterAdd');
    if (row.nickname === 'boom-after') {
      // 先在同一事务里再写一行，确认回滚时它也一起消失
      await tx.manager.query(
        'INSERT INTO demo_log (tenant_id, message, version) VALUES (1, ?, 1)',
        ['written-in-hook'],
      );
      throw new Error('afterAdd 故意失败');
    }
  }

  protected override async beforeUpdate(
    changes: Partial<DemoUserEntity>,
    existing: DemoUserEntity,
  ): Promise<void> {
    this.calls.push(`beforeUpdate:${existing.nickname}->${changes.nickname}`);
  }

  protected override async beforeDelete(rows: DemoUserEntity[]): Promise<void> {
    this.calls.push(`beforeDelete:${rows.length}`);
    if (rows.some((r) => r.username === 'protected'))
      throw crudErrors.badRequest('受保护的账号不能删除');
  }
}

@CrudController({
  prefix: 'test/demo-user',
  label: '演示用户',
  entity: DemoUserEntity,
  api: ['page', 'info', 'add', 'update', 'delete'],
  service: DemoUserService,
  pageQuery: {
    keyWords: ['username', 'nickname'],
    fieldEq: ['status', 'orgId'],
    maxSize: 100,
  },
})
export class DemoUserController extends BaseController<DemoUserEntity> {}

/** 硬删除资源，只开放部分接口 */
@Entity('demo_log')
export class DemoLogEntity extends BaseEntity {
  @CrudField({ label: '内容', form: { required: true } })
  @IsString()
  @Length(1, 100)
  @Column({ type: 'varchar', length: 100 })
  message: string;
}

@CrudController({
  prefix: 'test/demo-log',
  label: '演示日志',
  entity: DemoLogEntity,
  api: ['page', 'add', 'delete'],
  delete: 'hard',
})
export class DemoLogController extends BaseController<DemoLogEntity> {}
