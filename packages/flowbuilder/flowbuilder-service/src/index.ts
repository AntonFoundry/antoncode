/**
 * Flowbuilder service plugin entry: re-exports the Service Definition so the
 * Loader row resolves the class plugin.
 * @module @deepseek-ai/dsh-flowbuilder-service
 */

export {
  BlockUnknownError,
  FlowBuilderService,
  FlowGraphInvalidError,
  FlowUnknownError,
  default,
} from './service.ts'
