import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  ArrayMaxSize,
  ArrayUnique,
  IsBoolean,
  IsString,
  IsOptional,
  Length,
  Matches,
} from 'class-validator';
export class McpConfigBody {
  @ApiProperty() @IsBoolean() enabled!: boolean;
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(200)
  @ArrayUnique()
  @Matches(/^[a-z][a-z0-9.-]{0,99}$/, { each: true })
  blocked!: string[];
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @Matches(/^[a-z][a-z0-9:-]{1,149}$/, { each: true })
  confirmPermissions!: string[];
}
export class McpConfigResult extends McpConfigBody {
  @ApiProperty() deployed!: boolean;
  @ApiProperty({ type: [String] }) resources!: string[];
  @ApiProperty({ type: [String] }) permissions!: string[];
}
export class McpOperationQuery {
  @ApiProperty() @Matches(/^[1-9]\d{0,19}$/) id!: string;
}
export class McpDecisionBody extends McpOperationQuery {
  @ApiProperty() @IsBoolean() approve!: boolean;
}
export class McpReceipt {
  @ApiProperty() operationId!: string;
  @ApiProperty() status!: string;
  @ApiPropertyOptional({ type: Object, nullable: true }) result?: Record<
    string,
    unknown
  > | null;
  @ApiPropertyOptional() confirmUrl?: string;
}
export class McpOperationResult extends McpReceipt {
  @ApiProperty() summary!: string;
  @ApiProperty() applicationName!: string;
  @ApiProperty() resource!: string;
  @ApiProperty() action!: string;
  @ApiProperty() permission!: string;
  @ApiProperty() clientId!: string;
  @ApiProperty() ownerId!: string;
  @ApiProperty({ nullable: true, type: String }) orgId!: string | null;
  @ApiProperty({ nullable: true, type: String }) approverId!: string | null;
  @ApiProperty() expiresAt!: string;
  @ApiProperty({ type: Object }) parameters!: Record<string, unknown>;
  @ApiProperty({ type: [Object] }) targets!: { id: string; version: number }[];
}
export class McpOperationList {
  @ApiProperty({ type: [McpReceipt] }) list!: McpReceipt[];
}
export class McpSaved {
  @ApiProperty() id!: string;
}
export class McpDelegationBody {
  @ApiProperty() @IsString() @Length(1, 200) clientId!: string;
  @ApiProperty() @Matches(/^[1-9]\d{0,19}$/) approverId!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^[a-z][a-z0-9:-]{1,149}$/)
  permission?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
}
export class McpDelegationResult {
  @ApiProperty({ type: [Object] }) approvers!: {
    clientId: string;
    approverId: string;
  }[];
  @ApiProperty({ type: [Object] }) exemptions!: {
    clientId: string;
    serviceUserId: string;
    orgId: string | null;
    permission: string;
    enabled: boolean;
  }[];
}
