import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsString,
  Length,
  IsBoolean,
  IsOptional,
  IsInt,
  Min,
  Matches,
  IsIn,
  IsObject,
} from 'class-validator';
export class OAuthClientSaveBody {
  @ApiPropertyOptional() @IsOptional() @Matches(/^[1-9]\d{0,19}$/) id?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) version?: number;
  @ApiProperty() @IsString() @Length(1, 100) name!: string;
  @ApiProperty() @IsBoolean() enabled!: boolean;
  @ApiProperty({ enum: ['none', 'client_secret_basic', 'private_key_jwt'] })
  @IsIn(['none', 'client_secret_basic', 'private_key_jwt'])
  authMethod!: 'none' | 'client_secret_basic' | 'private_key_jwt';
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsString({ each: true })
  redirectUris!: string[];
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(60)
  @ArrayUnique()
  @Matches(/^[a-z][a-z0-9-]*:(read|write|risk)$/, { each: true })
  scopes!: string[];
  @ApiPropertyOptional({ writeOnly: true })
  @IsOptional()
  @IsString()
  @Length(32, 64)
  @Matches(/^[A-Za-z0-9_-]{32,64}$/)
  secret?: string;
  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  jwks?: Record<string, unknown>;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Matches(/^[1-9]\d{0,19}$/)
  serviceUserId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Matches(/^[1-9]\d{0,19}$/)
  serviceOrgId?: string | null;
}
export class OAuthIdBody {
  @ApiProperty() @Matches(/^[1-9]\d{0,19}$/) id!: string;
}
export class OAuthIntegrationSaveBody {
  @ApiPropertyOptional() @IsOptional() @Matches(/^[1-9]\d{0,19}$/) id?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) version?: number;
  @ApiProperty() @IsString() @Length(1, 100) name!: string;
  @ApiProperty() @IsBoolean() enabled!: boolean;
  @ApiProperty() @Matches(/^[1-9]\d{0,19}$/) orgId!: string;
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @Matches(/^[1-9]\d{0,19}$/, { each: true })
  roleIds!: string[];
  @ApiPropertyOptional({ writeOnly: true })
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{32,64}$/)
  secret?: string;
}
export class OAuthIntegrationResult {
  @ApiProperty() id!: string;
  @ApiProperty() clientId!: string;
  @ApiProperty() version!: number;
  @ApiProperty() name!: string;
  @ApiProperty() enabled!: boolean;
  @ApiProperty() orgId!: string;
  @ApiProperty({ type: [String] }) roleIds!: string[];
  @ApiProperty({ type: [String] }) scopes!: string[];
}
export class OAuthSavedResult {
  @ApiProperty() id!: string;
}
export class OAuthInteractionQuery {
  @ApiProperty() @Matches(/^[a-zA-Z0-9_-]{10,150}$/) uid!: string;
}
export class OAuthConsentBody extends OAuthInteractionQuery {
  @ApiProperty() @IsBoolean() approve!: boolean;
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(60)
  @ArrayUnique()
  @IsString({ each: true })
  scopes!: string[];
}
export class OAuthScopeItem {
  @ApiProperty() code!: string;
  @ApiProperty({ type: [String] }) permissions!: string[];
}
export class OAuthScopesResult {
  @ApiProperty({ type: [OAuthScopeItem] }) list!: OAuthScopeItem[];
}
export class OAuthInteractionResult {
  @ApiProperty() uid!: string;
  @ApiProperty() clientName!: string;
  @ApiProperty() tenantName!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty({ type: [String] }) scopes!: string[];
}
export class OAuthConsentResult {
  @ApiProperty() redirectTo!: string;
}
export class OAuthServiceAccountBody {
  @ApiProperty() @IsString() @Length(1, 100) name!: string;
  @ApiProperty() @Matches(/^[1-9]\d{0,19}$/) orgId!: string;
}
export class OAuthMyGrant {
  @ApiProperty() id!: string;
  @ApiProperty() clientId!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() audience!: string;
  @ApiProperty() active!: boolean;
  @ApiProperty({ type: [String] }) scopes!: string[];
}
export class OAuthMyGrantsResult {
  @ApiProperty({ type: [OAuthMyGrant] }) list!: OAuthMyGrant[];
}
export class OAuthStatusResult {
  @ApiProperty() enabled!: boolean;
  @ApiProperty() issuer!: string;
  @ApiProperty() dcrEnabled!: boolean;
  @ApiProperty() cimdEnabled!: boolean;
}
