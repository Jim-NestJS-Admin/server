import {
  applyDecorators,
  Body,
  Header,
  HttpCode,
  Inject,
  Post,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiExtension,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { RawResponse } from '../../../../core/decorators/raw-response.decorator.js';
import { AdminController } from '../../../../core/endpoint/endpoint.decorators.js';
import { BusinessException } from '../../../../core/exceptions/business.exception.js';
import { ErrorCode } from '../../../../core/exceptions/error-code.js';
import {
  ApiErrorBody,
  ApiErrors,
  ApiResult,
} from '../../../../core/swagger/api-result.js';
import type {} from 'multer';
import { FileIdBody, FileReceipt } from '../../dto/file.dto.js';
import { FileGuard, FileOperation } from '../../file.guard.js';
import { FileService } from '../../service/file.service.js';
const FileErrors = () =>
  applyDecorators(
    ApiErrors(400, 404),
    ...[401, 403, 413, 503].map((status) =>
      ApiResponse({ status, schema: { $ref: getSchemaPath(ApiErrorBody) } }),
    ),
  );

@ApiTags('文件')
@ApiBearerAuth()
@UseGuards(FileGuard)
@AdminController('file/asset')
export class FileController {
  constructor(@Inject(FileService) private readonly files: FileService) {}
  @Post('upload')
  @HttpCode(200)
  @FileOperation('upload')
  @ApiExtension('x-permissions', ['file:asset:upload'])
  @ApiOperation({ operationId: 'fileAssetUpload', summary: '上传文件' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
      additionalProperties: false,
    },
  })
  @ApiResult(FileReceipt)
  @FileErrors()
  @UseInterceptors(FileInterceptor('file'))
  upload(@UploadedFile() file: Express.Multer.File | undefined) {
    if (!file?.buffer)
      throw new BusinessException(ErrorCode.BadRequest, '请选择文件');
    return this.files.upload(file.buffer);
  }

  @Post('download')
  @HttpCode(200)
  @FileOperation('read')
  @ApiExtension('x-permissions', ['file:asset:read'])
  @ApiOperation({ operationId: 'fileAssetDownload', summary: '鉴权下载文件' })
  @ApiBody({ type: FileIdBody })
  @ApiProduces('application/octet-stream')
  @ApiResponse({ status: 200, schema: { type: 'string', format: 'binary' } })
  @FileErrors()
  @RawResponse()
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cache-Control', 'private, no-store')
  async download(@Body() body: FileIdBody): Promise<StreamableFile> {
    const file = await this.files.download(body.id);
    return new StreamableFile(file.data, {
      type: 'application/octet-stream',
      disposition: `attachment; filename="${file.name}"`,
      length: file.data.length,
    });
  }
}
