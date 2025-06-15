import { FeedIndex } from '@ethersphere/bee-js';

import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';
import { Logger } from '../utils/logger';

import { EVENTS } from './constants';
import { SwarmReaction } from './reaction';
import { SwarmChatUtils } from './utils';

export class SwarmHistory {
  private reaction: SwarmReaction;
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  private historyIndex: FeedIndex | null = null;

  constructor(private utils: SwarmChatUtils, private emitter: EventEmitter) {
    this.reaction = new SwarmReaction(this.utils, this.emitter);
  }

  public async init() {
    try {
      const res = await this.utils.fetchLatestChatMessage();
      this.historyIndex = res.index;

      await this.fetchPreviousMessages();
      await this.reaction.initializeReactions(res.message.reactionState);

      return res.index;
    } catch (error) {
      this.errorHandler.handleError(error, 'SwarmHistory.init');
      return FeedIndex.fromBigInt(0n);
    }
  }

  public async fetchPreviousMessages(count = 10) {
    try {
      if (!this.historyIndex) {
        this.logger.warn('History index is not set. Cannot fetch previous messages.');
        return;
      }

      if (this.historyIndex.toBigInt() === 0n) {
        this.logger.warn('No previous messages to fetch.');
        return;
      }

      const current = this.historyIndex.toBigInt();
      const start = current > BigInt(count) ? current - BigInt(count) : 0n;

      for (let i = current - 1n; i >= start; i--) {
        const message = await this.utils.fetchChatMessage(FeedIndex.fromBigInt(i));
        this.emitter.emit(EVENTS.MESSAGE_RECEIVED, message);

        this.historyIndex = FeedIndex.fromBigInt(i);

        // Prevent infinite loop: BigInt has no automatic loop termination like `i >= 0`
        if (i === 0n) break;
      }
    } catch (error) {
      this.errorHandler.handleError(error, 'SwarmHistory.fetchPreviousMessages');
    }
  }

  public cleanup() {
    this.reaction.cleanupReactionState();
  }
}
