import { IDecodedMessage, type LightNode, ReliableChannel } from '@waku/sdk';
import crypto from 'crypto';
import protobuf from 'protobufjs';

import { MessageData } from '../interfaces/message.js';
import { ErrorHandler } from '../utils/error.js';
import { Logger } from '../utils/logger.js';

export class Waku {
  private readonly logger = Logger.getInstance();
  private readonly errorHandler = ErrorHandler.getInstance();

  private reliableChannel: ReliableChannel<any> | null = null;
  private messagePayloadType: protobuf.Type | null = null;
  private messageReceivedListener: ((event: Event) => void) | null = null;

  private readonly senderId = crypto.randomBytes(8).toString('hex');

  constructor(private node: LightNode, private chatTopic: string, private onMessage: (msg: MessageData) => void) {
    this.createProtobufSchema();
  }

  public async start(): Promise<void> {
    this.createProtobufSchema();
    await this.createChannel();
  }

  private createProtobufSchema(): void {
    const MessageDataType = new protobuf.Type('MessageData')
      .add(new protobuf.Field('id', 1, 'string'))
      .add(new protobuf.Field('targetMessageId', 2, 'string', 'optional'))
      .add(new protobuf.Field('type', 3, 'string'))
      .add(new protobuf.Field('message', 4, 'string'))
      .add(new protobuf.Field('username', 5, 'string'))
      .add(new protobuf.Field('address', 6, 'string'))
      .add(new protobuf.Field('timestamp', 7, 'uint64'))
      .add(new protobuf.Field('signature', 8, 'string'))
      .add(new protobuf.Field('index', 9, 'uint32'))
      .add(new protobuf.Field('chatTopic', 10, 'string'))
      .add(new protobuf.Field('userTopic', 11, 'string'))
      .add(new protobuf.Field('additionalProps', 12, 'string', 'optional'));

    const MessageStateRefType = new protobuf.Type('MessageStateRef')
      .add(new protobuf.Field('reference', 1, 'string'))
      .add(new protobuf.Field('timestamp', 2, 'uint64'));

    this.messagePayloadType = new protobuf.Type('MessagePayload')
      .add(MessageDataType)
      .add(MessageStateRefType)
      .add(new protobuf.Field('message', 1, 'MessageData'))
      .add(new protobuf.Field('messageStateRefs', 2, 'MessageStateRef', 'repeated'));

    this.logger.info('Protobuf schema created for chat messages');
  }

  private async createChannel(): Promise<void> {
    if (!this.node) {
      throw new Error('Waku node not initialized');
    }

    const contentTopic = `/solarpunk-msrs-chat/1/${this.chatTopic}/proto`;
    const channelName = `chat-channel-${this.chatTopic}`;

    const encoder = this.node.createEncoder({ contentTopic });
    const decoder = this.node.createDecoder({ contentTopic });

    this.reliableChannel = await ReliableChannel.create(this.node, channelName, this.senderId, encoder, decoder, {
      retrieveFrequencyMs: 3000,
      queryOnConnect: false,
    });

    this.setupChannelEventListeners(this.reliableChannel);

    this.logger.info(`Created reliable channel for topic: ${this.chatTopic}`);
  }

  private setupChannelEventListeners(channel: ReliableChannel<any>): void {
    this.messageReceivedListener = (event: Event) => {
      this.handleMessageReceived((event as CustomEvent).detail);
    };
    channel.addEventListener('message-received', this.messageReceivedListener);
  }

  private handleMessageReceived = async ({ payload }: IDecodedMessage): Promise<void> => {
    try {
      if (!payload) {
        this.logger.warn('Received Waku message without payload');
        return;
      }

      if (!this.messagePayloadType) {
        throw new Error('Protobuf schema not initialized');
      }

      const decoded = this.messagePayloadType.decode(payload);
      const decodedObject = this.messagePayloadType.toObject(decoded, {
        longs: String,
        enums: String,
        defaults: true,
      });

      if (!decodedObject.message) {
        this.logger.warn('Decoded object has no message field');
        return;
      }

      // Parse additionalProps if it's a JSON string
      let additionalProps = decodedObject.message.additionalProps;
      if (additionalProps && typeof additionalProps === 'string') {
        try {
          additionalProps = JSON.parse(additionalProps);
        } catch (e) {
          this.logger.warn('Failed to parse additionalProps as JSON:', additionalProps);
        }
      }

      const message: MessageData = {
        ...decodedObject.message,
        timestamp: Number(decodedObject.message.timestamp),
        additionalProps,
      };

      if (!message?.id) {
        this.logger.warn('Received invalid message structure via Waku');
        return;
      }

      this.onMessage(message);
    } catch (error) {
      this.errorHandler.handleError(error, 'Waku2.handleMessageReceived');
    }
  };

  public stop(): void {
    if (this.reliableChannel && this.messageReceivedListener) {
      this.reliableChannel.removeEventListener('message-received', this.messageReceivedListener);
      this.messageReceivedListener = null;
      this.reliableChannel.stop();
      this.logger.info('Waku reliable channel stopped');
    }
  }
}
