import { createDecoder, createLightNode, Decoder, IDecodedMessage, type LightNode, Protocols } from '@waku/sdk';
import { createRoutingInfo } from '@waku/utils';

import { MessageData } from '../interfaces/message.js';
import { WAKU_CLUSTER_ID } from '../lib/constants.js';
import { ErrorHandler } from '../utils/error.js';
import { Logger } from '../utils/logger.js';
import { decodeMessagePayload } from '../waku/ProtoMessage.js';

export class Waku {
  private readonly logger = Logger.getInstance();
  private readonly errorHandler = ErrorHandler.getInstance();
  private wakuNode: LightNode | null = null;

  private readonly onMessage: (msg: MessageData) => void;
  private readonly chatTopic: string;
  private initPromise: Promise<void>;

  constructor(chatTopic: string, onMessage: (msg: MessageData) => void, node?: LightNode) {
    this.chatTopic = chatTopic;
    this.onMessage = onMessage;
    this.wakuNode = node || null;
    this.initPromise = this.init();
  }

  private async init(): Promise<void> {
    this.wakuNode = this.wakuNode ?? (await this.createWakuLightNode());
    if (!(await this.subscribeToTopic())) throw new Error('Failed to subscribe to Waku topic');
    this.logger.info(`Subscribed to Waku topic: ${this.chatTopic}`);
  }

  private async createWakuLightNode(): Promise<LightNode> {
    const node = await createLightNode({
      defaultBootstrap: true,
      networkConfig: { clusterId: WAKU_CLUSTER_ID },
    });

    await node.start();
    await node.waitForPeers([Protocols.LightPush, Protocols.Filter], 30000);
    this.logger.info(`Waku node ready: ${node.libp2p.peerId.toString()}`);

    return node;
  }

  private createWakuDecoder(contentTopic: string): Decoder {
    if (!contentTopic?.trim()) throw new Error('Topic name must be a non-empty string');

    const networkConfig = {
      clusterId: WAKU_CLUSTER_ID,
      numShardsInCluster: 8,
    };

    const routingInfo = createRoutingInfo(networkConfig, { contentTopic });

    return createDecoder(contentTopic, routingInfo);
  }

  private async subscribeToTopic(): Promise<boolean> {
    if (!this.wakuNode?.isStarted()) throw new Error('Waku node is not running');
    return this.wakuNode.filter.subscribe(this.createWakuDecoder(this.chatTopic), this.handleWakuMessage);
  }

  private handleWakuMessage = async ({ payload }: IDecodedMessage): Promise<void> => {
    try {
      if (!payload) return this.logger.warn('Received Waku message without payload');

      const { message } = await decodeMessagePayload(payload);
      if (!message?.id) return this.logger.warn('Received invalid message structure via Waku');

      this.onMessage(message);
    } catch (error) {
      this.errorHandler.handleError(error, 'Waku.handleWakuMessage');
    }
  };

  public async isReady(): Promise<boolean> {
    try {
      await this.initPromise;
      return this.wakuNode?.isStarted() ?? false;
    } catch {
      return false;
    }
  }

  public async stop(): Promise<void> {
    try {
      await this.initPromise;
      if (this.wakuNode) {
        await this.wakuNode.stop();
        this.wakuNode = null;
        this.logger.info('Waku node stopped successfully');
      }
    } catch (error) {
      this.errorHandler.handleError(error, 'Waku.stop');
      throw error;
    }
  }
}
