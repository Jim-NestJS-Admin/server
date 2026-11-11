import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { IsOptional, IsString, Matches, validate } from 'class-validator';
import { Column } from 'typeorm';
import {
  DecimalInput,
  applyDecimalInputs,
  validationMessages,
} from './decimal-input.js';

class OldEntity {
  @IsString()
  @Matches(/^-?\d{1,12}(\.\d{1,2})?$/)
  @Column({ type: 'decimal', precision: 14, scale: 2 })
  amount!: string;
}
class Input extends OldEntity {}
applyDecimalInputs(
  Input,
  OldEntity,
  ['amount'],
  [{ property: 'amount', label: '信用额度' }],
);
class NewInput {
  @IsOptional()
  @DecimalInput({ label: '单价', precision: 14, scale: 4 })
  price?: string;
}

describe('DECIMAL 入参', () => {
  it.each([50000, '50000', -12.34, '999999999999.99', 0])(
    '兼容旧实体的数字和字符串 %s',
    async (amount) => {
      const input = plainToInstance(Input, { amount });
      expect(await validate(input)).toEqual([]);
      expect(input.amount).toBe(String(amount));
    },
  );
  it.each([
    '1000000000000',
    '1.001',
    '',
    true,
    {},
    null,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    9007199254740992,
  ])('拒绝不合法或越界值 %s，返回中文', async (amount) => {
    const errors = await validate(plainToInstance(Input, { amount }));
    expect(errors.length).toBeGreaterThan(0);
    expect(validationMessages(errors[0]).join()).toMatch(/信用额度/);
    expect(validationMessages(errors[0]).join()).not.toMatch(/must/);
  });
  it('科学计数形式的 number 按十进制校验，字符串保持精度和可选字段行为', async () => {
    const input = plainToInstance(NewInput, { price: 1e-4 });
    expect(input.price).toBe('0.0001');
    expect(await validate(input)).toEqual([]);
    expect(await validate(plainToInstance(NewInput, {}))).toEqual([]);
    expect(
      await validate(plainToInstance(NewInput, { price: '0.00001' })),
    ).not.toEqual([]);
  });
});
