import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { ID_PATTERN } from '../../../core/crud/crud.dto.js';

export class StartWorkflowBody {
  @ApiProperty({ description: '已发布的固定流程版本编号' })
  @Matches(ID_PATTERN)
  definitionId!: string;
  @ApiProperty({
    description: '本人已保存的正式表单提交记录，不重复创建填写数据',
  })
  @Matches(ID_PATTERN)
  submissionId!: string;
}
export class ApproveWorkflowBody {
  @ApiProperty() @Matches(ID_PATTERN) id!: string;
  @ApiProperty({ description: '待办的乐观锁版本号' })
  @IsInt()
  @Min(1)
  version!: number;
  @ApiPropertyOptional({ maxLength: 1000, description: '审批意见（纯文本）' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
