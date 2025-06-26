import { Bee, EthAddress, PrivateKey } from '@ethersphere/bee-js';

import { ChatSettings, ChatSettingsSwarm, ChatSettingsUser, MessageData, MessageType } from '../interfaces';
import { remove0x } from '../utils/common';
import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';
import { Logger } from '../utils/logger';

import { SwarmHistory } from './history';
import { SwarmChatUtils } from './utils';

export abstract class SwarmMessaging {
  protected emitter: EventEmitter;
  protected utils: SwarmChatUtils;
  protected history: SwarmHistory;
  protected userDetails: ChatSettingsUser;
  protected swarmSettings: ChatSettingsSwarm;

  protected logger = Logger.getInstance();
  protected errorHandler = ErrorHandler.getInstance();

  protected fetchProcessRunning = false;
  protected stopFetch = false;

  constructor(settings: ChatSettings) {
    const signer = new PrivateKey(remove0x(settings.user.privateKey));

    this.userDetails = {
      privateKey: settings.user.privateKey,
      ownAddress: signer.publicKey().address().toString(),
      nickname: settings.user.nickname,
      ownIndex: -1,
    };

    this.swarmSettings = {
      bee: new Bee(settings.infra.beeUrl),
      beeUrl: settings.infra.beeUrl,
      stamp: settings.infra.stamp || '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', // placeholder stamp if smart gateway is used
      enveloped: settings.infra.enveloped,
      gsocTopic: settings.infra.gsocTopic,
      gsocResourceId: settings.infra.gsocResourceId,
      chatTopic: settings.infra.chatTopic,
      chatAddress: settings.infra.chatAddress,
    };

    this.emitter = new EventEmitter();
  }

  public start() {
    this.init();
    this.startMessagesFetchProcess();
  }

  public stop() {
    this.emitter.cleanAll();
    this.stopMessagesFetchProcess();
    this.history.cleanup();
  }

  public getEmitter() {
    return this.emitter;
  }

  public orderMessages(messages: any[]) {
    return this.utils.orderMessages(messages);
  }

  public abstract sendMessage(
    message: string,
    type: MessageType,
    targetMessageId?: string,
    id?: string,
    prevState?: MessageData[],
  ): Promise<void>;

  public abstract fetchPreviousMessages(): Promise<void>;

  public hasPreviousMessages(): boolean {
    return this.history.hasPreviousMessages();
  }

  public async retrySendMessage(message: MessageData) {
    this.sendMessage(message.message, message.type, message.targetMessageId, message.id);
  }

  public abstract retryBroadcastUserMessage(message: MessageData): Promise<void>;

  protected abstract init(): Promise<void>;

  protected getSignature(message: string) {
    const { ownAddress: address, privateKey, nickname } = this.userDetails;

    const ownAddress = new EthAddress(address).toString();

    const signer = new PrivateKey(privateKey);
    const signerAddress = signer.publicKey().address().toString();

    if (signerAddress !== ownAddress) {
      throw new Error('The provided address does not match the address derived from the private key');
    }

    const timestamp = Date.now();
    const signature = signer.sign(JSON.stringify({ username: nickname, address: ownAddress, message, timestamp }));

    return signature.toHex();
  }

  protected abstract startMessagesFetchProcess(): Promise<void>;

  private stopMessagesFetchProcess() {
    this.stopFetch = true;
  }
}
