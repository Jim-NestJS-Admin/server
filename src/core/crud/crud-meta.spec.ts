import { IsString } from 'class-validator';
import { Column, Entity } from 'typeorm';
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
      { prefix: 'demo/item', api: ['export' as never] },
      /export/,
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

describe('数据库命名 SnakeNamingStrategy', () => {
  it('属性名转小写下划线', () => {
    const s = new SnakeNamingStrategy();
    expect(s.columnName('createdAt', undefined, [])).toBe('created_at');
    expect(s.columnName('orgId', undefined, [])).toBe('org_id');
    expect(s.columnName('httpURLValue', undefined, [])).toBe('http_url_value');
    expect(s.columnName('x', 'custom_name', [])).toBe('custom_name');
  });
});
