import { DefaultNamingStrategy, type NamingStrategyInterface } from 'typeorm';

const snake = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();

/**
 * 数据库命名：表名、列名一律小写下划线（userName → user_name）。
 * 表名必须在 @Entity('表名') 里写明，不靠类名推导，避免改类名时表名跟着变。
 */
export class SnakeNamingStrategy
  extends DefaultNamingStrategy
  implements NamingStrategyInterface
{
  override columnName(
    propertyName: string,
    customName: string | undefined,
    embeddedPrefixes: string[],
  ): string {
    return (
      snake(embeddedPrefixes.concat('').join('_')) +
      (customName ?? snake(propertyName))
    );
  }

  override relationName(propertyName: string): string {
    return snake(propertyName);
  }

  override joinColumnName(
    relationName: string,
    referencedColumnName: string,
  ): string {
    return snake(`${relationName}_${referencedColumnName}`);
  }
}
