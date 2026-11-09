import { IsString } from 'class-validator';
import { Column, Entity } from 'typeorm';
import type { CrudChildOptions } from './crud.types.js';
import { SnakeNamingStrategy } from '../database/naming.strategy.js';
import { BaseEntity } from './base.entity.js';
import { CrudField } from './crud-field.decorator.js';
import { resolveCrudMeta } from './crud-meta.js';

@Entity('spec_item')
class ItemEntity extends BaseEntity {
  @CrudField({ label: '名称', list: { sortable: true } })
  @IsString()
  @Column({ type: 'varchar', length: 20 })
  name: string;

  @CrudField({ label: '编码', edit: 'none' })
  @Column({ type: 'varchar', length: 20 })
  code: string;
}

@Entity('spec_bad')
class NoValidatorEntity extends BaseEntity {
  @CrudField({ label: '备注' })
  @Column({ type: 'varchar', length: 20 })
  remark: string;
}

const base = { label: '条目', entity: ItemEntity, api: ['page' as const] };

describe('资源定义 resolveCrudMeta：配置写错在启动时就报错', () => {
  it('整理出可写、可读、可排序字段和权限码前缀', () => {
    const meta = resolveCrudMeta({ ...base, prefix: 'demo/item-type' });
    expect(meta).toMatchObject({
      name: 'DemoItemType',
      permPrefix: 'demo:item-type',
      addable: ['name'],
      updatable: ['name'],
      sortable: ['id', 'createdAt', 'updatedAt', 'name'],
      deleteMode: 'soft',
      maxSize: 500,
      defaultSort: [{ field: 'id', order: 'desc' }],
    });
    expect(meta.readable).toContain('code');
  });

  it.each([
    ['prefix 不是 模块/资源', { prefix: 'item' }, /prefix/],
    ['prefix 有大写', { prefix: 'Demo/Item' }, /prefix/],
    [
      '搜索字段没声明',
      { prefix: 'demo/item', pageQuery: { keyWords: ['nope' as never] } },
      /nope/,
    ],
    [
      '默认排序字段不能排序',
      {
        prefix: 'demo/item',
        pageQuery: {
          defaultSort: [{ field: 'code' as never, order: 'asc' as const }],
        },
      },
      /code/,
    ],
    [
      '每页上限超过 500',
      { prefix: 'demo/item', pageQuery: { maxSize: 501 } },
      /maxSize/,
    ],
    [
      '不认识的接口',
      { prefix: 'demo/item', api: ['import' as never] },
      /import/,
    ],
    [
      '硬删除资源开回收站',
      { prefix: 'demo/item', delete: 'hard', api: ['page', 'restore'] },
      /硬删除的资源没有回收站/,
    ],
  ])('%s', (_name, patch, error) => {
    expect(() => resolveCrudMeta({ ...base, ...patch } as never)).toThrow(
      error,
    );
  });

  it('可写字段没有校验规则：启动失败', () => {
    expect(() =>
      resolveCrudMeta({
        prefix: 'demo/bad',
        label: '坏',
        entity: NoValidatorEntity,
        api: ['add'],
      }),
    ).toThrow(/remark 没有 class-validator/);
  });
});

@Entity('spec_line')
class LineEntity extends BaseEntity {
  @Column({ type: 'bigint' })
  itemId: string;

  @CrudField({ label: '编码' })
  @IsString()
  @Column({ type: 'varchar', length: 20 })
  code: string;
}

class NotAnEntity {}

describe('子表配置', () => {
  const child = (patch: Partial<CrudChildOptions> = {}): CrudChildOptions => ({
    resource: 'lines',
    label: '行',
    entity: LineEntity,
    foreignKey: 'itemId',
    ...patch,
  });
  const resolve = (children: CrudChildOptions[]) =>
    resolveCrudMeta({ ...base, prefix: 'demo/item', children });

  it('整理出子表定义：可写字段、默认行数、文档名', () => {
    const [c] = resolve([child({ unique: [['code']] })]).children;
    expect(c).toMatchObject({
      name: 'DemoItemLines',
      addable: ['code'],
      min: 0,
      max: 500,
      unique: [['code']],
    });
    expect(c.readable).not.toContain('itemId');
    expect(c.readable).not.toContain('version');
  });

  it.each([
    ['resource 不是驼峰名', { resource: 'Lines' }, /resource/],
    ['实体没继承 BaseEntity', { entity: NotAnEntity as never }, /BaseEntity/],
    ['外键不是列', { foreignKey: 'nope' }, /外键 nope/],
    ['唯一字段没声明', { unique: [['nope']] }, /唯一字段 nope/],
    ['唯一字段空组', { unique: [[]] }, /空组/],
    ['排序字段不是列', { sortField: 'nope' }, /排序字段 nope/],
    ['最少大于最多', { min: 3, max: 2 }, /行数限制/],
    ['最多超过上限', { max: 1001 }, /行数限制/],
  ])('%s：启动失败', (_name, patch, error) => {
    expect(() => resolve([child(patch)])).toThrow(error);
  });

  it('外键用 @CrudField 声明（前端可写）：启动失败', () => {
    @Entity('spec_line_bad')
    class BadLine extends BaseEntity {
      @CrudField({ label: '外键' })
      @IsString()
      @Column({ type: 'bigint' })
      itemId: string;
    }
    expect(() => resolve([child({ entity: BadLine })])).toThrow(/由框架填写/);
  });

  it('同名子表、子表和主表同实体、同一实体挂两次：启动失败', () => {
    expect(() => resolve([child(), child()])).toThrow(/重复/);
    expect(() =>
      resolve([
        child({ entity: ItemEntity as never, foreignKey: 'createdBy' }),
      ]),
    ).toThrow(/同一个实体/);
    expect(() => resolve([child(), child({ resource: 'other' })])).toThrow(
      /只能挂一次/,
    );
  });
});

describe('数据库命名 SnakeNamingStrategy', () => {
  it('属性名转小写下划线', () => {
    const s = new SnakeNamingStrategy();
    expect(s.columnName('createdAt', undefined, [])).toBe('created_at');
    expect(s.columnName('orgId', undefined, [])).toBe('org_id');
    expect(s.columnName('httpURLValue', undefined, [])).toBe('http_url_value');
    expect(s.columnName('x', 'custom_name', [])).toBe('custom_name');
  });
});
