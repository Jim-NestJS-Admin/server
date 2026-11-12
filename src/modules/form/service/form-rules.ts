import { isEmail, isURL } from 'class-validator';
import { crudErrors } from '../../../core/crud/crud.errors.js';
import {
  FORM_TYPES,
  type FormDesignerDto,
  type FormFieldDto,
  type FormLinkageDto,
  type FormOptionDto,
  type FormValidationDto,
} from '../dto/form.dto.js';

type Obj = Record<string, unknown>;
const MAX_FIELDS = 200;
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);
function fail(path: string, message: string): never {
  throw crudErrors.badRequest('表单配置不合法', [
    { field: path, messages: [message] },
  ]);
}
function object(value: unknown, path: string): Obj {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(
      Object.getPrototypeOf(value) as object | null,
    )
  )
    fail(path, '必须是普通JSON对象');
  return value as Obj;
}
function keys(value: Obj, allowed: string[], path: string) {
  for (const key of Object.keys(value))
    if (DANGEROUS.has(key) || !allowed.includes(key))
      fail(`${path}.${key}`, '不支持的配置，禁止事件、脚本及远程数据');
}
function text(value: unknown, path: string, max = 200): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[<>]|\$FN:|FORM-CREATE|=>|\bfunction\s*\(/i.test(value)
  )
    fail(path, '必须是长度受限的纯文本，禁止脚本或HTML');
  return value;
}
function bool(value: unknown, fallback: boolean, path: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(path, '必须是布尔值');
  return value;
}
function list(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    fail(path, `必须是最多${max}项的数组`);
  return value;
}
const scalar = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v));
function options(value: unknown, path: string): FormOptionDto[] {
  const seen = new Set<string>();
  return list(value, path, 200).map((item, index) => {
    const p = `${path}.${index}`,
      option = object(item, p);
    keys(option, ['label', 'value'], p);
    const label = text(option.label, `${p}.label`);
    if (
      !scalar(option.value) ||
      (typeof option.value === 'string' &&
        (option.value.length > 200 || !option.value.length))
    )
      fail(`${p}.value`, '选项值必须是有限数值、布尔值或非空短文本');
    if (typeof option.value === 'string') text(option.value, `${p}.value`);
    const key = JSON.stringify(option.value);
    if (seen.has(key)) fail(`${p}.value`, '选项值不能重复');
    seen.add(key);
    return { label, value: option.value };
  });
}
function bound(value: unknown, path: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value) > 1e12
  )
    fail(path, '范围必须是有限数字，绝对值不超过10^12');
  return value;
}

/** 不调用FormCreate解释器，不执行用户表达式；只接收可往返渲染的安全子集。 */
export function parseFormDesigner(input: unknown): {
  designer: FormDesignerDto;
  fields: FormFieldDto[];
} {
  let jsonNodes = 0;
  const scan = (v: unknown, path: string, depth: number) => {
    if (++jsonNodes > 20000 || depth > 32) fail(path, 'JSON结构过大或过深');
    if (typeof v === 'string') text(v, path, 20000);
    else if (Array.isArray(v))
      v.forEach((item, i) => scan(item, `${path}.${i}`, depth + 1));
    else if (v !== null && typeof v === 'object') {
      for (const [key, item] of Object.entries(object(v, path))) {
        if (DANGEROUS.has(key)) fail(`${path}.${key}`, '禁止原型属性');
        scan(item, `${path}.${key}`, depth + 1);
      }
    } else if (
      v !== null &&
      typeof v !== 'boolean' &&
      !(typeof v === 'number' && Number.isFinite(v))
    )
      fail(path, '只允许JSON值，禁止函数');
  };
  scan(input, 'data.designer', 0);
  const root = object(input, 'data.designer');
  keys(root, ['schemaVersion', 'rule', 'option', 'linkages'], 'data.designer');
  if (root.schemaVersion !== 1)
    fail('data.designer.schemaVersion', '只支持契约版本1');
  const fields: FormFieldDto[] = [],
    names = new Set<string>();
  let nodes = 0;
  const visit = (rules: unknown, path: string, depth: number): Obj[] => {
    if (depth > 12) fail(path, '布局嵌套最多12层');
    return list(rules, path, 200).map((item, index) => {
      const p = `${path}.${index}`,
        rule = object(item, p);
      if (++nodes > 400) fail(p, '组件总数最多400个');
      const type = text(rule.type, `${p}.type`, 30);
      const layout = ['row', 'col', 'el-row', 'el-col'].includes(type);
      keys(
        rule,
        layout
          ? ['type', 'props', 'children']
          : [
              'type',
              'field',
              'title',
              'info',
              'value',
              'props',
              'options',
              'validate',
              '$required',
              'hidden',
              'display',
              'meta',
            ],
        p,
      );
      const props =
        rule.props === undefined ? {} : object(rule.props, `${p}.props`);
      if (layout) {
        keys(props, ['span', 'offset', 'gutter'], `${p}.props`);
        for (const [key, value] of Object.entries(props))
          if (
            !Number.isInteger(value) ||
            (value as number) < 0 ||
            (value as number) > (key === 'gutter' ? 100 : 24)
          )
            fail(`${p}.props.${key}`, '布局参数越界');
        return {
          type,
          props,
          children: visit(rule.children, `${p}.children`, depth + 1),
        };
      }
      if (!(FORM_TYPES as readonly string[]).includes(type))
        fail(`${p}.type`, '组件不在白名单内');
      const field = text(rule.field, `${p}.field`, 64);
      if (
        !/^[a-z][a-zA-Z0-9_]{0,63}$/.test(field) ||
        DANGEROUS.has(field) ||
        [
          'id',
          'tenantId',
          'orgId',
          'createdBy',
          'updatedBy',
          'version',
        ].includes(field) ||
        names.has(field)
      )
        fail(`${p}.field`, '字段名无效、重复或属于系统保留字段');
      if (fields.length >= MAX_FIELDS) fail(p, '字段最多200个');
      names.add(field);
      const title = text(rule.title, `${p}.title`, 100);
      if (!title.trim()) fail(`${p}.title`, '字段标题不能为空');
      const propKeys: Record<string, string[]> = {
        input: [
          'type',
          'placeholder',
          'disabled',
          'clearable',
          'maxlength',
          'showWordLimit',
          'rows',
        ],
        inputNumber: [
          'min',
          'max',
          'step',
          'precision',
          'disabled',
          'controls',
        ],
        switch: ['disabled'],
        select: [
          'multiple',
          'placeholder',
          'disabled',
          'clearable',
          'filterable',
        ],
        radio: ['disabled'],
        checkbox: ['disabled'],
        datePicker: [
          'type',
          'valueFormat',
          'placeholder',
          'disabled',
          'clearable',
        ],
      };
      keys(props, propKeys[type], `${p}.props`);
      for (const [key, value] of Object.entries(props)) {
        const pp = `${p}.props.${key}`;
        if (['placeholder', 'type', 'valueFormat'].includes(key))
          text(value, pp);
        else if (
          ['min', 'max', 'step', 'precision', 'maxlength', 'rows'].includes(key)
        ) {
          bound(value, pp);
          if (
            ['precision', 'maxlength', 'rows'].includes(key) &&
            (!Number.isInteger(value) ||
              (value as number) < 0 ||
              (value as number) > 20000)
          )
            fail(pp, '整数配置越界');
          if (key === 'step' && (value as number) <= 0)
            fail(pp, '步长必须大于0');
        } else bool(value, false, pp);
      }
      if (
        type === 'input' &&
        props.type !== undefined &&
        !['text', 'textarea', 'password', 'email', 'url'].includes(
          props.type as string,
        )
      )
        fail(`${p}.props.type`, '不支持的输入类型');
      if (
        type === 'datePicker' &&
        ((props.type !== undefined && props.type !== 'date') ||
          props.valueFormat !== 'YYYY-MM-DD')
      )
        fail(`${p}.props`, '日期组件只支持date和YYYY-MM-DD值格式');
      const multiple =
        type === 'checkbox' || (type === 'select' && props.multiple === true);
      const choices =
        rule.options === undefined ? [] : options(rule.options, `${p}.options`);
      if (['select', 'radio', 'checkbox'].includes(type) !== choices.length > 0)
        fail(`${p}.options`, '选择组件必须有非空静态选项，其他组件不能带选项');
      if (new Set(choices.map((o) => typeof o.value)).size > 1)
        fail(`${p}.options`, '同一字段选项值类型必须一致');
      const valueType = multiple
        ? 'array'
        : type === 'inputNumber'
          ? 'number'
          : type === 'switch'
            ? 'boolean'
            : type === 'datePicker'
              ? 'date'
              : choices.length
                ? (typeof choices[0].value as 'string' | 'number' | 'boolean')
                : 'string';
      const validation: FormValidationDto = {};
      if (type === 'inputNumber') {
        if (props.precision !== undefined) {
          if ((props.precision as number) > 15)
            fail(`${p}.props.precision`, '精度最多15位');
          validation.precision = props.precision as number;
        }
        if (props.min !== undefined) validation.min = props.min as number;
        if (props.max !== undefined) validation.max = props.max as number;
      }
      if (type === 'input' && props.maxlength !== undefined)
        validation.max = props.maxlength as number;
      if (type === 'input' && ['email', 'url'].includes(props.type as string))
        validation.format = props.type as 'email' | 'url';
      let required = bool(rule.$required, false, `${p}.$required`);
      if (rule.validate !== undefined)
        for (const [i, item] of list(
          rule.validate,
          `${p}.validate`,
          20,
        ).entries()) {
          const vp = `${p}.validate.${i}`,
            v = object(item, vp);
          keys(v, ['required', 'min', 'max', 'type', 'message', 'trigger'], vp);
          if (v.required !== undefined)
            required = bool(v.required, false, `${vp}.required`) || required;
          if (v.message !== undefined) text(v.message, `${vp}.message`);
          if (
            v.trigger !== undefined &&
            !['blur', 'change'].includes(v.trigger as string)
          )
            fail(`${vp}.trigger`, '只支持blur/change');
          if (
            v.type !== undefined &&
            ![
              valueType === 'date' ? 'string' : valueType,
              'email',
              'url',
            ].includes(v.type as string)
          )
            fail(`${vp}.type`, '校验类型与字段不符或不支持');
          if (v.type === 'email' || v.type === 'url') {
            if (valueType !== 'string')
              fail(`${vp}.type`, '格式校验只能用于文本');
            validation.format = v.type;
          }
          for (const k of ['min', 'max'] as const)
            if (v[k] !== undefined) {
              if (!['string', 'number', 'array'].includes(valueType))
                fail(`${vp}.${k}`, '字段不支持范围校验');
              const n = bound(v[k], `${vp}.${k}`);
              if (
                valueType !== 'number' &&
                (!Number.isInteger(n) || n < 0 || n > 20000)
              )
                fail(`${vp}.${k}`, '长度必须是0至20000的整数');
              validation[k] =
                validation[k] === undefined
                  ? n
                  : k === 'min'
                    ? Math.max(validation[k]!, n)
                    : Math.min(validation[k]!, n);
            }
        }
      if ((validation.min ?? -Infinity) > (validation.max ?? Infinity))
        fail(`${p}.validate`, '最小值不能大于最大值');
      const meta =
        rule.meta === undefined ? {} : object(rule.meta, `${p}.meta`);
      keys(meta, ['multilingual', 'queryable'], `${p}.meta`);
      const multilingual = bool(
        meta.multilingual,
        false,
        `${p}.meta.multilingual`,
      );
      if (multilingual && valueType !== 'string')
        fail(`${p}.meta.multilingual`, '只有文本字段支持多语言标记');
      fields.push({
        field,
        title,
        component: type as FormFieldDto['component'],
        type: valueType,
        required,
        visible:
          !bool(rule.hidden, false, `${p}.hidden`) &&
          bool(rule.display, true, `${p}.display`),
        multiple,
        multilingual,
        queryable: bool(
          meta.queryable,
          valueType !== 'array',
          `${p}.meta.queryable`,
        ),
        options: choices,
        validation,
      });
      if (rule.info !== undefined) text(rule.info, `${p}.info`, 500);
      return structuredClone(rule);
    });
  };
  const rule = visit(root.rule, 'data.designer.rule', 0);
  if (!fields.length) fail('data.designer.rule', '表单至少包含一个字段');
  const option =
    root.option === undefined
      ? {}
      : object(root.option, 'data.designer.option');
  keys(option, ['form', 'submitBtn', 'resetBtn'], 'data.designer.option');
  for (const key of ['submitBtn', 'resetBtn'])
    if (option[key] !== undefined)
      bool(option[key], false, `data.designer.option.${key}`);
  if (option.form !== undefined) {
    const form = object(option.form, 'data.designer.option.form');
    keys(
      form,
      ['labelPosition', 'labelWidth', 'size'],
      'data.designer.option.form',
    );
    if (
      form.labelPosition !== undefined &&
      !['left', 'right', 'top'].includes(form.labelPosition as string)
    )
      fail('data.designer.option.form.labelPosition', '标签位置无效');
    if (
      form.size !== undefined &&
      !['small', 'default', 'large'].includes(form.size as string)
    )
      fail('data.designer.option.form.size', '尺寸无效');
    if (
      form.labelWidth !== undefined &&
      (!Number.isInteger(form.labelWidth) ||
        (form.labelWidth as number) < 0 ||
        (form.labelWidth as number) > 500)
    )
      fail('data.designer.option.form.labelWidth', '标签宽度必须为0至500');
  }
  const linkages = list(root.linkages ?? [], 'data.designer.linkages', 200).map(
    (item, i) => {
      const p = `data.designer.linkages.${i}`,
        v = object(item, p);
      keys(
        v,
        [
          'source',
          'operator',
          'value',
          'target',
          'action',
          'whenTrue',
          'whenFalse',
        ],
        p,
      );
      const source = fields.findIndex((f) => f.field === v.source),
        target = fields.findIndex((f) => f.field === v.target);
      if (source < 0 || target <= source || fields[source].multiple)
        fail(p, '联动只能从前置标量字段指向后置字段，禁止循环依赖');
      if (!['eq', 'ne', 'in'].includes(v.operator as string))
        fail(`${p}.operator`, '条件仅支持eq/ne/in');
      const values =
        v.operator === 'in' ? list(v.value, `${p}.value`, 200) : [v.value];
      if (!values.every(scalar)) fail(`${p}.value`, '比较值必须是标量');
      if (!['visible', 'required', 'options'].includes(v.action as string))
        fail(`${p}.action`, '动作仅支持visible/required/options');
      for (const key of ['whenTrue', 'whenFalse']) {
        if (v.action === 'options') {
          const choices = options(v[key], `${p}.${key}`);
          if (
            !choices.length ||
            !choices.every((o) =>
              fields[target].options.some((base) => base.value === o.value),
            )
          )
            fail(`${p}.${key}`, '联动选项必须是目标原始选项的非空子集');
        } else bool(v[key], false, `${p}.${key}`);
        if (v[key] === undefined)
          fail(`${p}.${key}`, '必须明确配置匹配和不匹配动作');
      }
      return structuredClone(v) as unknown as FormLinkageDto;
    },
  );
  const designer = {
    schemaVersion: 1,
    rule,
    option: structuredClone(option),
    linkages,
  };
  if (Buffer.byteLength(JSON.stringify(designer)) > 65536)
    fail('data.designer', '表单定义最多64KiB');
  // 默认值只用于渲染，也必须满足字段类型和范围；不把默认值隐式注入提交数据。
  const defaults: Obj = {};
  const collect = (rules: Obj[]) => {
    for (const r of rules) {
      if (Array.isArray(r.children)) collect(r.children as Obj[]);
      else if (Object.hasOwn(r, 'value')) defaults[r.field as string] = r.value;
    }
  };
  collect(rule);
  validateFormValues(
    {
      fields: fields.map((f) =>
        Object.assign({}, f, { required: false, visible: true }),
      ),
      designer: { ...designer, linkages: [] },
    },
    defaults,
  );
  return { designer, fields };
}

/** 可供workflow/CMS直接复用；调用方必须自行实施当前动作的数据/字段权限。 */
export function validateFormValues(
  definition: { fields: FormFieldDto[]; designer: FormDesignerDto },
  data: unknown,
): void {
  const values = object(data, 'data'),
    errors: { field: string; messages: string[] }[] = [];
  const add = (field: string, message: string) =>
    errors.push({ field: `data.${field}`, messages: [message] });
  const known = new Set(definition.fields.map((f) => f.field));
  for (const key of Object.keys(values))
    if (!known.has(key) || DANGEROUS.has(key)) add(key, '未知字段，不允许提交');
  const effective: Obj = {};
  for (const base of definition.fields) {
    const field = Object.assign({}, base);
    for (const link of definition.designer.linkages ?? [])
      if (link.target === field.field) {
        const src = effective[link.source];
        const match =
          link.operator === 'in'
            ? (link.value as unknown[]).includes(src)
            : link.operator === 'eq'
              ? src === link.value
              : src !== link.value;
        const result = match ? link.whenTrue : link.whenFalse;
        if (link.action === 'options')
          field.options = result as FormOptionDto[];
        else field[link.action] = result as boolean;
      }
    const value = Object.hasOwn(values, field.field)
      ? values[field.field]
      : undefined;
    const empty =
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && !value.length);
    if (!field.visible) {
      if (!empty) add(field.field, '隐藏字段不允许提交');
      continue;
    }
    effective[field.field] = value;
    if (empty) {
      if (field.required) add(field.field, '必填字段不能为空');
      continue;
    }
    const correct =
      field.type === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : field.type === 'boolean'
          ? typeof value === 'boolean'
          : field.type === 'array'
            ? Array.isArray(value) && value.length <= 200
            : typeof value === 'string' && value.length <= 20000;
    if (!correct) {
      add(field.field, '字段值类型不正确或长度超限');
      continue;
    }
    if (field.required && typeof value === 'string' && !value.trim())
      add(field.field, '必填字段不能只有空格');
    if (
      typeof value === 'number' &&
      field.validation.precision !== undefined &&
      Number(value.toFixed(field.validation.precision)) !== value
    )
      add(field.field, '数值小数位超过允许精度');
    if (
      field.type === 'date' &&
      (typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      add(field.field, '必须是有效的YYYY-MM-DD日期');
    const size =
      typeof value === 'number'
        ? value
        : typeof value === 'string' || Array.isArray(value)
          ? value.length
          : undefined;
    if (
      size !== undefined &&
      ((field.validation.min !== undefined && size < field.validation.min) ||
        (field.validation.max !== undefined && size > field.validation.max))
    )
      add(field.field, '字段值超出允许范围');
    if (
      field.validation.format &&
      (typeof value !== 'string' ||
        !(field.validation.format === 'email'
          ? isEmail(value)
          : isURL(value, {
              protocols: ['http', 'https'],
              require_protocol: true,
            })))
    )
      add(field.field, '字段格式不正确');
    if (field.options.length) {
      const items = field.multiple ? (value as unknown[]) : [value];
      if (
        !items.every(
          (v) => scalar(v) && field.options.some((o) => o.value === v),
        ) ||
        new Set(items).size !== items.length
      )
        add(field.field, '选项无效或重复');
    }
  }
  if (errors.length) throw crudErrors.badRequest('表单数据校验失败', errors);
}
