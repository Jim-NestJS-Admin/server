import {
  TableColumn,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';

export class FormVersionArchive1814906215523 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (!(await runner.hasColumn('form_definition', 'archived')))
      await runner.addColumn(
        'form_definition',
        new TableColumn({
          name: 'archived',
          type: 'tinyint',
          default: 0,
        }),
      );
  }

  async down(runner: QueryRunner): Promise<void> {
    if (await runner.hasColumn('form_definition', 'archived'))
      await runner.dropColumn('form_definition', 'archived');
  }
}
