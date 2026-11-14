import { QueryFailedError } from 'typeorm';
import { BusinessException } from '../../../core/exceptions/business.exception.js';
import { ErrorCode } from '../../../core/exceptions/error-code.js';

/** 事务整体已回滚；只将已知竞争翻译成可重试409，不隐藏其他数据库/编译错误。 */
export function workflowFailure(error: unknown): never {
  if (error instanceof QueryFailedError) {
    const driver = error.driverError as { code?: string; sqlMessage?: string };
    if (
      ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(driver.code ?? '')
    )
      throw new BusinessException(
        ErrorCode.Conflict,
        '流程状态正在变化，请使用原请求重试',
        409,
      );
    if (
      driver.code === 'ER_DUP_ENTRY' &&
      /uk_wf_instance_(submission|business)/.test(driver.sqlMessage ?? '')
    )
      throw new BusinessException(
        ErrorCode.Conflict,
        '该提交或业务版本已经发起审批，请查看原申请',
        409,
      );
  }
  throw error;
}
