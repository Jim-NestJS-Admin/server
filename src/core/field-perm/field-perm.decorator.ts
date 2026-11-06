export type FieldState = 'editable' | 'readonly' | 'masked' | 'hidden';
export type MaskRule = 'phone' | 'email' | 'idcard' | 'last4' | 'all';

/** 越大越宽松：可编辑 > 只读 > 脱敏 > 隐藏 */
export const STATE_RANK: Record<FieldState, number> = {
  hidden: 0,
  masked: 1,
  readonly: 2,
  editable: 3,
};

export interface FieldPermOptions {
  /** 后台显示的名称；不写时用 @CrudField 的 label，再没有就是字段名 */
  label?: string;
  /** 角色没有单独设置时的状态，默认可编辑 */
  default?: FieldState;
  /** 脱敏规则（状态为脱敏时用），默认 all */
  mask?: MaskRule;
  /** 审批临时授权最多能放到什么状态（执行在审批模块） */
  delegable?: FieldState;
  /** false：不进字段权限配置清单 */
  configurable?: boolean;
}

export const FIELD_PERM_KEY = 'jna:field-perm';

/**
 * 字段权限的代码默认值（架构「字段权限」）：`@FieldPerm({ label: '成本价', default: 'hidden' })`。
 * 只是默认值，后台的模块字段管理和角色字段权限优先。
 */
export function FieldPerm(options: FieldPermOptions): PropertyDecorator {
  return (target, key) => {
    const ctor = target.constructor;
    const prev = (Reflect.getMetadata(FIELD_PERM_KEY, ctor) ?? {}) as Record<
      string,
      FieldPermOptions
    >;
    Reflect.defineMetadata(
      FIELD_PERM_KEY,
      { ...prev, [String(key)]: options },
      ctor,
    );
  };
}

export function fieldPermOf(
  entity: Function,
  field: string,
): FieldPermOptions | undefined {
  const all = Reflect.getMetadata(FIELD_PERM_KEY, entity) as
    Record<string, FieldPermOptions> | undefined;
  return all?.[field];
}
