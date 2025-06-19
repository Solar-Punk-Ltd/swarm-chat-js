export enum MessageType {
  TEXT = 'text',
  THREAD = 'thread',
  REACTION = 'reaction',
}

export interface MessageData {
  id: string;
  targetMessageId?: string;
  type: MessageType;
  message: string;
  username: string;
  address: string;
  timestamp: number;
  signature: string;
  index: number;
  chatTopic: string;
  userTopic: string;
}

export interface StatefulMessage {
  message: MessageData;
  messageStateRefs: MessageStateRef[] | null;
}

export interface MessageStateRef {
  reference: string;
  timestamp: number;
}
