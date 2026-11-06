import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../core/crud/base.entity.js';
import type {
  DataScopeKind,
  MenuNode,
} from '../../../core/permission/permission-source.js';

@Entity('sys_user')
@Index(['tenantId', 'username', 'activeGuard'], { unique: true })
export class SystemUser extends BaseEntity {
  @Column({ type: 'varchar', length: 64 }) username: string;
  @Column({ type: 'varchar', length: 100, select: false }) passwordHash: string;
  @Column({ type: 'varchar', length: 100 }) nickname: string;
  @Column({ type: 'varchar', length: 500, nullable: true }) avatar:
    string | null;
  @Column({ type: 'boolean', default: true }) enabled: boolean;
  @Column({ type: 'varchar', length: 16, default: 'zh-CN' }) locale: string;
  @Column({ type: 'bigint', unsigned: true, nullable: true }) defaultOrgId:
    string | null;
}

@Entity('sys_org')
export class SystemOrg extends BaseEntity {
  @Column({ type: 'varchar', length: 100 }) name: string;
  @Column({ type: 'bigint', unsigned: true, nullable: true }) parentId:
    string | null;
  @Column({ type: 'boolean', default: true }) enabled: boolean;
  @Column({ type: 'int', default: 0 }) rank: number;
}

@Entity('sys_role')
@Index(['tenantId', 'code', 'activeGuard'], { unique: true })
export class SystemRole extends BaseEntity {
  @Column({ type: 'varchar', length: 64 }) code: string;
  @Column({ type: 'varchar', length: 100 }) name: string;
  @Column({ type: 'boolean', default: true }) enabled: boolean;
  @Column({ type: 'boolean', default: false }) allPermissions: boolean;
  @Column({ type: 'json' }) permissions: string[];
  @Column({ type: 'varchar', length: 24 }) dataScope: DataScopeKind;
  @Column({ type: 'json' }) customOrgIds: string[];
}

@Entity('sys_user_role')
export class SystemUserRole extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true }) userId: string;
  @Column({ type: 'bigint', unsigned: true }) roleId: string;
  @Column({ type: 'bigint', unsigned: true, nullable: true }) scopeOrgId:
    string | null;
}

@Entity('sys_menu')
export class SystemMenu extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true, nullable: true }) parentId:
    string | null;
  @Column({ type: 'varchar', length: 16 }) type: MenuNode['type'];
  @Column({ type: 'varchar', length: 200 }) path: string;
  @Column({ type: 'varchar', length: 100 }) title: string;
  @Column({ type: 'varchar', length: 100, nullable: true }) icon: string | null;
  @Column({ type: 'int', default: 0 }) rank: number;
  @Column({ type: 'varchar', length: 200, nullable: true }) component:
    string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) permission:
    string | null;
  @Column({ type: 'boolean', default: false }) keepAlive: boolean;
  @Column({ type: 'boolean', default: false }) hidden: boolean;
}

export const SYSTEM_ENTITIES = [
  SystemUser,
  SystemOrg,
  SystemRole,
  SystemUserRole,
  SystemMenu,
];
