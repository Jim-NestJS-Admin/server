import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';
export class NotifyReadBody {
  @ApiProperty({ description: '本人消息编号' })
  @Matches(/^[1-9]\d{0,19}$/)
  id!: string;
}
export class NotifyReadResult {
  @ApiProperty() id!: string;
}
export class NotifyUnreadResult {
  @ApiProperty() count!: number;
}
