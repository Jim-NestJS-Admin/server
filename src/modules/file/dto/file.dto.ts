import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';
export class FileIdBody {
  @ApiProperty({ type: String, example: '1' })
  @Matches(/^[1-9]\d{0,19}$/, { message: '文件编号无效' })
  id: string;
}
export class FileReceipt {
  @ApiProperty({ type: String }) id: string;
  @ApiProperty({
    type: String,
    description: '系统生成的文件名，不使用客户端提供的名称',
  })
  name: string;
  @ApiProperty({ type: String }) mime: string;
  @ApiProperty({ type: Number }) bytes: number;
}
