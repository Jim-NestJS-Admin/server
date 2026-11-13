import { BaseController, CrudController } from '../../../../core/crud/index.js';
import { FormSubmission } from '../../entity/form-submission.entity.js';
import { FormSubmissionService } from '../../service/form-submission.service.js';
@CrudController({
  prefix: 'form/submission',
  label: '表单提交记录',
  entity: FormSubmission,
  service: FormSubmissionService,
  api: ['page', 'info', 'add'],
  dataScope: true,
  pageQuery: {
    keyWords: ['name', 'code'],
    fieldEq: ['definitionId', 'code', 'revision'],
    defaultSort: [{ field: 'createdAt', order: 'desc' }],
  },
})
export class FormSubmissionController extends BaseController<FormSubmission> {}
