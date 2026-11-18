import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemModule } from '../system/system.module.js';
import {
  OAuthClient,
  OAuthGrant,
  OAuthEvent,
  OAuthScope,
  OAuthToken,
} from './entity/oauth.entity.js';
import { OAuthClientService } from './service/oauth-client.service.js';
import { OAuthScopesService } from './service/oauth-scopes.service.js';
import { OAuthCrypto } from './service/oauth-crypto.js';
import { OAuthAdapterService } from './service/oauth-adapter.service.js';
import { OAuthGrantService } from './service/oauth-grant.service.js';
import { OAuthRuntimeService } from './service/oauth-runtime.service.js';
import { OAuthMetadataFetcher } from './service/oauth-metadata-fetcher.js';
import { OAuthTokenStore } from './service/oauth-token-store.js';
import {
  OAuthClientController,
  OAuthGrantController,
  OAuthInteractionController,
  OAuthServiceAccountController,
  OAuthEventController,
} from './controller/admin/oauth.controller.js';
@Module({
  imports: [
    SystemModule,
    TypeOrmModule.forFeature([
      OAuthClient,
      OAuthGrant,
      OAuthEvent,
      OAuthScope,
      OAuthToken,
    ]),
  ],
  controllers: [
    OAuthClientController,
    OAuthGrantController,
    OAuthInteractionController,
    OAuthServiceAccountController,
    OAuthEventController,
  ],
  providers: [
    OAuthClientService,
    OAuthScopesService,
    OAuthCrypto,
    OAuthAdapterService,
    OAuthGrantService,
    OAuthRuntimeService,
    OAuthMetadataFetcher,
    OAuthTokenStore,
  ],
  exports: [
    OAuthRuntimeService,
    OAuthScopesService,
    OAuthClientService,
    OAuthCrypto,
  ],
})
export class OAuthModule {}
