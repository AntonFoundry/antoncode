/** `flowbuilder` namespace dictionaries (the Workflows tab label and canvas chrome). */

/** Dictionary namespace owned by this plugin. */
export const NS = 'flowbuilder'

/** The flowbuilder dictionary key set (the source of truth for both locales). */
export type FlowbuilderKey =
  | 'view.dagflow'
  | 'flow.new'
  | 'flow.save'
  | 'flow.saved'
  | 'flow.run'
  | 'flow.running'
  | 'flow.result'
  | 'flow.library'
  | 'flow.library.empty'
  | 'flow.library.saveBlock'
  | 'flow.library.instantiate'
  | 'flow.palette'
  | 'flow.inspector'
  | 'flow.inspector.empty'
  | 'flow.field.name'
  | 'flow.field.description'
  | 'flow.field.title'
  | 'flow.field.kind'
  | 'flow.field.code'
  | 'flow.field.block'
  | 'flow.field.params'
  | 'flow.delete'
  | 'flow.disconnect'
  | 'flow.connect.hint'
  | 'flow.pickFlow'
  | 'flow.error'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Workflows tab label and the canvas chrome copy. */
    'flowbuilder': FlowbuilderKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<FlowbuilderKey, string> = {
  'view.dagflow': '工作流',
  'flow.new': '新建',
  'flow.save': '保存',
  'flow.saved': '已保存',
  'flow.run': '运行',
  'flow.running': '运行中…',
  'flow.result': '结果',
  'flow.library': '积木库',
  'flow.library.empty': '库中暂无积木',
  'flow.library.saveBlock': '存为积木',
  'flow.library.instantiate': '放到画布',
  'flow.palette': '节点',
  'flow.inspector': '检查器',
  'flow.inspector.empty': '选中一个节点以编辑',
  'flow.field.name': '名称',
  'flow.field.description': '描述',
  'flow.field.title': '标题',
  'flow.field.kind': '类型',
  'flow.field.code': '代码',
  'flow.field.block': '积木',
  'flow.field.params': '参数',
  'flow.delete': '删除',
  'flow.disconnect': '断开',
  'flow.connect.hint': '点击输出端口，再点击输入端口以连线',
  'flow.pickFlow': '选择工作流',
  'flow.error': '错误',
}

/** English dictionary. */
export const en: Record<FlowbuilderKey, string> = {
  'view.dagflow': 'Workflows',
  'flow.new': 'New',
  'flow.save': 'Save',
  'flow.saved': 'Saved',
  'flow.run': 'Run',
  'flow.running': 'Running…',
  'flow.result': 'Result',
  'flow.library': 'Block library',
  'flow.library.empty': 'No library blocks yet',
  'flow.library.saveBlock': 'Save as block',
  'flow.library.instantiate': 'Place on canvas',
  'flow.palette': 'Nodes',
  'flow.inspector': 'Inspector',
  'flow.inspector.empty': 'Select a node to edit',
  'flow.field.name': 'Name',
  'flow.field.description': 'Description',
  'flow.field.title': 'Title',
  'flow.field.kind': 'Kind',
  'flow.field.code': 'Code',
  'flow.field.block': 'Block',
  'flow.field.params': 'Params',
  'flow.delete': 'Delete',
  'flow.disconnect': 'Disconnect',
  'flow.connect.hint': 'Click an output port, then an input port, to connect',
  'flow.pickFlow': 'Pick workflow',
  'flow.error': 'Error',
}
