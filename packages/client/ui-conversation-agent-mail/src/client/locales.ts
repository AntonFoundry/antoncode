export const zh = {
  tab: 'Agent Mail',
  title: 'Agent Mail',
  readOnly: '只读预览',
  unavailable: 'Agent Mail 收件箱、发送和确认功能尚未连接。浏览器授权架构就绪前，这些操作不可用。',
  addressLabel: '会话地址',
  noAddress: '会话地址是 Agent 的会话 ID；此视图显示当前会话 ID，但不读取或写入队列。',
  composeTitle: '如何联系其他会话',
  composeHelp: '如需发送消息，请在对应 Agent 会话中使用 agent_queue_send 工具，并先通过 agent_queue_address 获取会话地址。此提示不会发送消息。',
  noEmail: 'Agent Mail 是 Agent 队列功能，不是 Gmail 或 iCloud 邮件。',
} satisfies Record<string, string>

export type AgentMailLocaleKey = keyof typeof zh

export const en = {
  tab: 'Agent Mail',
  title: 'Agent Mail',
  readOnly: 'Read-only preview',
  unavailable: 'Agent Mail inbox, send, and acknowledgement are not connected. These actions are unavailable until browser authorization is in place.',
  addressLabel: 'Agent session address',
  noAddress: 'An address is an Agent session ID. This conversation view shows the current session ID only; it does not read or write the queue.',
  composeTitle: 'How to contact another session',
  composeHelp: 'To send a message, use the agent_queue_send tool in the relevant Agent session, after obtaining its address with agent_queue_address. This guidance does not send a message.',
  noEmail: 'Agent Mail is an Agent queue feature, not Gmail or iCloud mail.',
} satisfies Record<AgentMailLocaleKey, string>
