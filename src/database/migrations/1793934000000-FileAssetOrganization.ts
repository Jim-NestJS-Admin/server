import {
  TableColumn,
  TableIndex,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';

/** 已执行旧T09迁移的环境也可补齐T06所属组织字段；新环境直接跳过已有列。 */
export class FileAssetOrganization1793934000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (!(await runner.hasColumn('file_asset', 'org_id')))
      await runner.addColumn(
        'file_asset',
        new TableColumn({
          name: 'org_id',
          type: 'bigint',
          unsigned: true,
          isNullable: true,
        }),
      );
    const table = await runner.getTable('file_asset');
    if (
      !table?.indices.some(
        (index) =>
          index.columnNames.length === 1 && index.columnNames[0] === 'org_id',
      )
    )
      await runner.createIndex(
        'file_asset',
        new TableIndex({ name: 'idx_file_asset_org', columnNames: ['org_id'] }),
      );
  }
  async down(): Promise<void> {
    throw new Error('所属组织字段不自动删除，回退需要人工确认');
  }
}
