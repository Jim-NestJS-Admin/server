import { SelectQueryBuilder, type ObjectLiteral } from 'typeorm';

export interface QueryScope {
  /** 范围条件（租户、数据范围），每条都和业务条件整体 AND，业务代码改不掉 */
  conditions: string[];
  /** 范围条件用到的参数；参数名是框架保留的，业务代码不能改 */
  params: Record<string, unknown>;
}

/**
 * 带范围条件的查询构造器（租户感知 Repository、BaseService.select 返回的都是它）。
 *
 * 普通 SelectQueryBuilder 上提前 andWhere 的条件，调用方一个 `.where(...)` 就会被整体替换，
 * `.orWhere(...)` 也会变成「租户 = ? OR ...」。这里把范围条件放在 TypeORM 组装 WHERE 的最后一步，
 * 和软删除条件一样：业务条件整体加括号，再 AND 范围条件。clone（分页计数会用）也会带上。
 * 范围条件的参数在组装时重新写入，setParameter 改保留参数直接报错。
 *
 * 它只能读：转成写操作的方法一律报错。
 * 注意：qb.subQuery() 建的子查询是普通查询构造器，不带范围条件；需要子查询时用另一个 repo.query(...)。
 */
const readOnly = (op: string) =>
  new Error(
    `带范围条件的查询只能读，不能调用 ${op}()：写入请用 TenantRepository 的 insert / update / remove 或通用 CRUD`,
  );

export class ScopedSelectQueryBuilder<
  T extends ObjectLiteral,
> extends SelectQueryBuilder<T> {
  private scope: QueryScope | undefined;
  private sealed = false;

  constructor(source: SelectQueryBuilder<T>, scope?: QueryScope) {
    super(source);
    const inherited =
      source instanceof ScopedSelectQueryBuilder ? source.scope : undefined;
    this.scope = scope ?? inherited;
    if (this.scope)
      for (const [k, v] of Object.entries(this.scope.params))
        super.setParameter(k, v);
    this.sealed = true;
  }

  // 只读：不能从查询构造器转成写操作（insert / update / delete / softDelete / restore / relation），
  // 否则转出来的是不带范围条件的普通写构造器，能改别的租户的数据，也能绕过跨租户模式的只读。
  // 写入走 TenantRepository 的 insert / update / remove 或通用 CRUD。
  override insert(): never {
    throw readOnly('insert');
  }
  override update(): never {
    throw readOnly('update');
  }
  override delete(): never {
    throw readOnly('delete');
  }
  override softDelete(): never {
    throw readOnly('softDelete');
  }
  override restore(): never {
    throw readOnly('restore');
  }
  override relation(): never {
    throw readOnly('relation');
  }

  override setParameter(key: string, value: unknown): this {
    if (
      this.sealed &&
      this.scope &&
      Object.hasOwn(this.scope.params, key) &&
      value !== this.scope.params[key]
    )
      throw new Error(`参数名 ${key} 是框架保留的，不能修改`);
    return super.setParameter(key, value);
  }

  protected override createWhereExpression(): string {
    if (!this.scope?.conditions.length) return super.createWhereExpression();
    // 组装前把保留参数恢复成框架的值，防止有人直接改 expressionMap.parameters
    Object.assign(this.expressionMap.parameters, this.scope.params);
    const prev = this.expressionMap.extraAppendedAndWhereCondition;
    const mine = this.scope.conditions.map((c) => `(${c})`).join(' AND ');
    this.expressionMap.extraAppendedAndWhereCondition = prev
      ? `(${prev}) AND ${mine}`
      : mine;
    try {
      return super.createWhereExpression();
    } finally {
      this.expressionMap.extraAppendedAndWhereCondition = prev;
    }
  }
}
